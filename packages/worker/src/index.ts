import { Worker, type Job } from 'bullmq'
import type { MessageJob, PhoneCheckJob } from '@aice/shared'
import { db } from './lib/db'
import { redis } from './lib/redis'
import { agentManager } from './lib/agent-manager'
import { validateStartup } from './lib/validate'
import {
  isWorkingHours,
  msUntilNextOpen,
  gaussianDelay,
  randomBreakDuration,
  sleep,
} from './lib/scheduler'
import { warmWorker, startWarmSession, resumeWarmSession } from './lib/warm-worker'


const QUEUE_NAME             = 'whatsapp-messages'
const PHONE_CHECK_QUEUE_NAME = 'phone-check'
const REPLY_POLL_INTERVAL    = parseInt(process.env.REPLY_POLL_INTERVAL_MS ?? '60000', 10)
const REPLY_WINDOW_DAYS      = parseInt(process.env.CAMPAIGN_REPLY_WINDOW_DAYS ?? '3', 10)
const REPLY_EXPIRE_DAYS      = parseInt(process.env.REPLY_EXPIRE_DAYS ?? '3', 10)
const REPLY_BATCH_SIZE       = parseInt(process.env.REPLY_BATCH_SIZE ?? '30', 10)
const REPLY_REPOLL_COOLDOWN  = parseInt(process.env.REPLY_REPOLL_COOLDOWN_MS ?? '600000', 10)
// dailySendCap, breakEvery, typeDelay are now per-agent (BrowserAgent fields).
// Env vars remain as fallback defaults when an agent has no override.

// Per-agent session send counters (in-memory; reset on worker restart)
const sessionSendCount = new Map<number, number>()

// In-memory tracker: when each phone was last polled for replies (epoch ms)
const lastPolledAt = new Map<string, number>()

// ─── Daily cap helpers ────────────────────────────────────────────────────────

async function todaySendCount(agentId: number): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const log   = await db.dailySendLog.findUnique({ where: { agentId_date: { agentId, date: today } } })
  return log?.count ?? 0
}

async function incrementDailyCount(agentId: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await db.dailySendLog.upsert({
    where:  { agentId_date: { agentId, date: today } },
    update: { count: { increment: 1 } },
    create: { agentId, date: today, count: 1 },
  })
}

// ─── Message worker ───────────────────────────────────────────────────────────

const worker = new Worker<MessageJob>(
  QUEUE_NAME,
  async (job: Job<MessageJob>, token?: string) => {
    const { messageId, phone, body, campaignId, contactId, agentId: preferredAgentId } = job.data

    // 0a. Skip stale or CANCELLED messages
    const message = await db.message.findUnique({
      where:  { id: messageId },
      select: { id: true, status: true },
    })
    if (!message) {
      console.warn(`[worker] msg:${messageId} not found — stale job, skipping`)
      return
    }
    if (message.status === 'CANCELLED') {
      console.log(`[worker] msg:${messageId} CANCELLED (area target reached), skipping`)
      return
    }

    // 0b. Resolve agent — pick the least-busy online agent that hasn't hit its daily cap.
    //     If all agents are capped, reschedule the job via BullMQ delayed queue (no sleeping).
    const AGENT_WAIT_TIMEOUT = 10 * 60 * 1000
    const agentWaitStart     = Date.now()

    let agent: ReturnType<typeof agentManager.getAgent> = undefined
    while (!agent) {
      if (Date.now() - agentWaitStart > AGENT_WAIT_TIMEOUT) {
        throw new Error('No agent online after 10 minutes — scan the QR code in the Agents page')
      }

      // Filter: exclude agents in warm mode, validation-only mode, OR actively in a RUNNING warm session.
      // warmMode and validationOnly are stored in DB (not in-memory BrowserAgent), so we query each cycle.
      // Agents that flip warmMode=false mid-session are still blocked via the session check.
      const [excludedModeAgents, runningSessionAgents] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        db.agent.findMany({ where: { OR: [{ warmMode: true }, { validationOnly: true } as any] }, select: { id: true } }),
        db.warmSessionAgent.findMany({
          where: { session: { status: 'RUNNING' } },
          select: { agentId: true },
        }),
      ])
      const excludedAgentIds = new Set([
        ...excludedModeAgents.map((a) => a.id),
        ...runningSessionAgents.map((a) => a.agentId),
      ])

      const online = agentManager.getAllAgents()
        .filter(({ agent: a, agentId }) =>
          a.status === 'connected' && !excludedAgentIds.has(agentId),
        )

      if (online.length === 0) {
        console.log('[worker] no agent online, waiting 10s…')
        await sleep(10_000)
        continue
      }

      // Sort by activity with random tiebreaker so load is spread across all agents.
      // Without the tiebreaker, a stable sort always puts the lower-ID agent first
      // when both are idle (activeJobCount === 0), causing only one agent to ever work.
      online.sort((a, b) => {
        const diff = a.agent.activeJobCount - b.agent.activeJobCount
        return diff !== 0 ? diff : Math.random() - 0.5
      })
      if (preferredAgentId) {
        const idx = online.findIndex(({ agentId }) => agentId === preferredAgentId)
        if (idx > 0) online.unshift(...online.splice(idx, 1))
      }

      // Pick first agent under its daily cap
      for (const { agent: candidate } of online) {
        const sent = await todaySendCount(candidate.agentId)
        if (sent < candidate.dailySendCap) {
          agent = candidate
          break
        }
      }

      if (!agent) {
        // All online agents have hit their cap — release job back to BullMQ delayed queue
        const delay = msUntilNextOpen()
        console.log(`[worker] all agents at daily cap, rescheduling in ${Math.round(delay / 60000)}m`)
        await job.moveToDelayed(Date.now() + delay, token)
        return
      }
    }

    agent.activeJobCount++
    const usedAgentId = agent.agentId
    const log = (msg: string) => console.log(`[agent:${usedAgentId}] ${msg}`)

    try {
      log(`picked up msg:${messageId} → ${phone}`)

      // 1. Working hours — reschedule via BullMQ instead of sleeping
      if (!isWorkingHours()) {
        const delay = msUntilNextOpen()
        log(`outside working hours, rescheduling in ${Math.round(delay / 60000)}m`)
        agent.activeJobCount--
        await job.moveToDelayed(Date.now() + delay, token)
        return
      }

      // 2. Mid-session break (per agent — uses agent's own break settings)
      const count = (sessionSendCount.get(usedAgentId) ?? 0) + 1
      sessionSendCount.set(usedAgentId, count)
      if (count > 0 && count % agent.breakEvery === 0) {
        const dur = randomBreakDuration(agent.breakMinMs, agent.breakMaxMs)
        log(`mid-session break #${count} (every ${agent.breakEvery}): ${Math.round(dur / 60000)}m`)
        await sleep(dur)
      }

      // 3. Gaussian delay
      const delay = gaussianDelay()
      log(`waiting ${Math.round(delay / 1000)}s before send (session #${count})`)
      await sleep(delay)

      // 4. Send
      log(`sending to ${phone}…`)
      await agent.sendMessage(phone, body)

      // 6. Update message record
      await db.message.updateMany({
        where: { id: messageId },
        data:  { status: 'SENT', sentAt: new Date(), body: body, agentId: usedAgentId },
      })
      await incrementDailyCount(usedAgentId)

      // 7. Update campaign totals + CampaignArea sentCount
      const campaign = await db.campaign.update({
        where: { id: campaignId },
        data:  { sentCount: { increment: 1 } },
        select: { bulan: true, campaignType: true },
      })
      const contact = await db.contact.findUnique({
        where:  { id: contactId },
        select: { areaId: true },
      })
      if (contact?.areaId) {
        await db.campaignArea.updateMany({
          where: { campaignId, areaId: contact.areaId },
          data:  { sentCount: { increment: 1 } },
        })

        // 8. Trigger CSV report so this contact appears immediately (fire-and-forget)
        const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`
        fetch(`${apiUrl}/api/export/report-area`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            areaId:       contact.areaId,
            bulan:        campaign.bulan,
            campaignType: campaign.campaignType,
          }),
        }).catch(() => {})
      }

      log(`✓ sent msg:${messageId} to ${phone}`)
    } finally {
      agent.activeJobCount--
    }
  },
  {
    connection:   redis as never,
    concurrency:  1,
    // Must cover mid-session break (max 8 min) + Gaussian delay (max 90s) + send time + buffer
    lockDuration: 15 * 60 * 1000,
  },
)

worker.on('failed', async (job, err) => {
  if (!job) return
  console.error(`[worker] job ${job.id} FAILED for msg:${job.data.messageId} → ${job.data.phone}:`, err)
  const failReason = String(err)
  await db.message.update({
    where: { id: job.data.messageId },
    data:  { status: 'FAILED', failedAt: new Date(), failReason },
  }).catch(() => {})
  await db.campaign.update({
    where: { id: job.data.campaignId },
    data:  { failedCount: { increment: 1 } },
  }).catch(() => {})
  if (failReason.includes('tidak terdaftar')) {
    await db.contact.update({
      where: { id: job.data.contactId },
      data:  { phoneValid: false, waChecked: true },
    }).catch(() => {})
  }
})

// ─── Phone-check worker ───────────────────────────────────────────────────────

const phoneCheckWorker = new Worker<PhoneCheckJob>(
  PHONE_CHECK_QUEUE_NAME,
  async (job: Job<PhoneCheckJob>) => {
    const { phone } = job.data

    const start = Date.now()
    // Prefer a validation-only agent; fall back to any campaign agent if none available.
    let agent   = agentManager.getValidationAgent() ?? await agentManager.getLeastBusyAgent().catch(() => null)
    while (!agent) {
      if (Date.now() - start > 5 * 60 * 1000) throw new Error('No agent online — cannot check phone')
      await sleep(5000)
      agent = agentManager.getValidationAgent() ?? await agentManager.getLeastBusyAgent().catch(() => null)
    }

    agent.activeJobCount++
    console.log(`[agent:${agent.agentId}][phone-check] checking ${phone}…`)
    try {
      const registered = await agent.checkPhoneRegistered(phone)
      // Update ALL contacts with this phone across STIK and KARDUS
      await db.contact.updateMany({
        where: { phoneNorm: phone },
        data:  { phoneValid: registered, waChecked: true },
      })
      // Clear the "pending checking" Redis key so the UI badge updates
      await redis.del(`wa:checking:${phone}`)
      console.log(`[agent:${agent.agentId}][phone-check] ${phone} → ${registered ? '✓ terdaftar' : '✗ TIDAK terdaftar'}`)
      return { phone, registered }
    } finally {
      agent.activeJobCount--
    }
  },
  // Concurrency = number of agents — each job picks a different agent for parallel checking.
  { connection: redis as never, concurrency: parseInt(process.env.PHONE_CHECK_CONCURRENCY ?? '3', 10) },
)

phoneCheckWorker.on('failed', (job, err) => {
  console.error(`[phone-check] failed for ${job?.data.phone}:`, err)
  if (job?.data.phone) redis.del(`wa:checking:${job.data.phone}`).catch(() => {})
})

// ─── Reply polling ────────────────────────────────────────────────────────────

// Permanently mark old unreplied messages as EXPIRED so they leave the polling pool.
// Catches messages from long-running campaigns that CAMPAIGN_REPLY_WINDOW_DAYS cannot filter.
async function expireOldMessages(): Promise<number> {
  const expiryCutoff = new Date(Date.now() - REPLY_EXPIRE_DAYS * 24 * 60 * 60 * 1000)
  const result = await db.message.updateMany({
    where: {
      status:    { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:     null,
      sentAt:    { lt: expiryCutoff },
      updatedAt: { lt: expiryCutoff }, // skip recently un-expired messages (grace period)
    },
    data: { status: 'EXPIRED' },
  })
  if (result.count > 0) {
    console.log(`[poll] expired ${result.count} unreplied message(s) older than ${REPLY_EXPIRE_DAYS} days`)
  }
  return result.count
}

// Returns Map<phone, sentAt> — batched and prioritised so each poll cycle is bounded.
async function getUnrepliedPhones(): Promise<Map<string, Date>> {
  const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const messages = await db.message.findMany({
    where:  {
      status:   { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:    null,
      campaign: {
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
        ],
      },
    },
    select: { phone: true, sentAt: true },
  })

  // Deduplicate by phone, keeping the MOST RECENT sentAt per phone
  const map = new Map<string, Date>()
  for (const m of messages) {
    const existing = map.get(m.phone)
    const ts = m.sentAt ?? new Date(0)
    if (!existing || ts > existing) map.set(m.phone, ts)
  }

  // Sort by priority: never-polled first, then oldest-polled, then most-recent sentAt.
  // Phones polled within the cooldown window are deprioritised to the end.
  const now = Date.now()
  const entries = [...map.entries()].sort((a, b) => {
    const aLastPoll = lastPolledAt.get(a[0]) ?? 0
    const bLastPoll = lastPolledAt.get(b[0]) ?? 0
    const aInCooldown = aLastPoll > 0 && (now - aLastPoll) < REPLY_REPOLL_COOLDOWN
    const bInCooldown = bLastPoll > 0 && (now - bLastPoll) < REPLY_REPOLL_COOLDOWN

    // Phones in cooldown go to the back
    if (aInCooldown !== bInCooldown) return aInCooldown ? 1 : -1
    // Among non-cooldown: never-polled first (lastPoll=0), then oldest-polled
    if (aLastPoll !== bLastPoll) return aLastPoll - bLastPoll
    // Tie-break: most recently sent first
    return b[1].getTime() - a[1].getTime()
  })

  // Slice to batch size
  const batched = new Map<string, Date>()
  for (const [phone, sentAt] of entries.slice(0, REPLY_BATCH_SIZE)) {
    batched.set(phone, sentAt)
  }

  if (map.size > REPLY_BATCH_SIZE) {
    console.log(`[poll] ${map.size} total unreplied phones, batched to ${batched.size}`)
  }

  return batched
}

async function handleReply(params: {
  phone:          string
  text:           string
  screenshotPath: string | null
}) {
  const { phone, text, screenshotPath } = params

  // Fan-out: ALL unreplied messages for this phone in ACTIVE campaigns (covers STIK + KARDUS).
  // Also includes COMPLETED campaigns within the reply window so late replies are still captured.
  // Excludes COMPLETED campaigns older than REPLY_WINDOW_DAYS and all CANCELLED campaigns.
  const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const messages = await db.message.findMany({
    where: {
      phone,
      status:   { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:    null,
      campaign: {
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
        ],
      },
    },
    include: {
      campaign: true,
      contact:  { include: { area: true } },
    },
    orderBy: { sentAt: 'desc' },
  })

  if (messages.length === 0) return

  // Call Claude ONCE with the reply text, reuse result for all fan-out replies
  const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`
  let analysisData: Record<string, unknown> = {}
  try {
    const firstMsg = messages[0]
    const resp = await fetch(`${apiUrl}/api/analyze/reply`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        replyText:    text,
        bulan:        firstMsg.campaign.bulan,
        campaignType: firstMsg.contact.area.contactType,
      }),
    })
    if (resp.ok) {
      const json = await resp.json() as { ok: boolean; data: Record<string, unknown> }
      if (json.ok) analysisData = json.data
    }
  } catch (err) {
    console.warn('[worker] analyze/reply call failed:', err)
  }

  // Create Reply records + update counts + check stop condition
  for (const msg of messages) {
    // Guard: if reply.create fails (e.g. duplicate on second poll), skip ALL counter
    // updates for this message — avoids double-counting replyCount.
    const reply = await db.reply.create({
      data: {
        messageId:      msg.id,
        phone,
        body:           text,
        screenshotPath,
        claudeCategory:  (analysisData.category  as string)  ?? null,
        claudeSentiment: (analysisData.sentiment as string)  ?? null,
        claudeSummary:   (analysisData.summary   as string)  ?? null,
        jawaban:         (analysisData.jawaban   as number | null) ?? null,
      },
    }).catch((e) => {
      console.warn(`[worker] reply.create failed for msg ${msg.id} (already exists?):`, e)
      return null
    })

    // Only update counters if the Reply record was actually created
    if (!reply) continue

    if (msg.status !== 'READ') {
      await db.message.update({ where: { id: msg.id }, data: { status: 'READ', readAt: new Date() } })
      await db.campaign.update({ where: { id: msg.campaignId }, data: { readCount: { increment: 1 } } })
    }
    await db.campaign.update({ where: { id: msg.campaignId }, data: { replyCount: { increment: 1 } } })

    const areaId = msg.contact.areaId
    await db.campaignArea.updateMany({
      where: { campaignId: msg.campaignId, areaId },
      data:  { replyCount: { increment: 1 } },
    })

    // Stop-on-target check
    if (msg.campaign.stopOnTargetReached) {
      const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
      const target    = msg.campaign.targetRepliesPerArea ?? appConfig?.defaultTargetRepliesPerArea ?? 20
      const area      = await db.campaignArea.findUnique({
        where: { campaignId_areaId: { campaignId: msg.campaignId, areaId } },
      })
      if (area && area.replyCount >= target && !area.targetReached) {
        await db.campaignArea.update({
          where: { campaignId_areaId: { campaignId: msg.campaignId, areaId } },
          data:  { targetReached: true },
        })
        await db.message.updateMany({
          where: { campaignId: msg.campaignId, status: { in: ['PENDING', 'QUEUED'] }, contact: { areaId } },
          data:  { status: 'CANCELLED' },
        })
        console.log(`[worker] target reached for area ${areaId} in campaign ${msg.campaignId}`)

        // Check if ALL areas in this campaign have now reached their target → complete campaign
        const allAreas = await db.campaignArea.findMany({
          where:  { campaignId: msg.campaignId },
          select: { targetReached: true },
        })
        const allDone = allAreas.length > 0 && allAreas.every((a) => a.targetReached)
        if (allDone) {
          await db.campaign.update({
            where: { id: msg.campaignId },
            data:  { status: 'COMPLETED', completedAt: new Date() },
          })
          console.log(`[worker] campaign ${msg.campaignId} COMPLETED — all areas reached target`)
        }
      }
    }

    // Trigger CSV report (fire-and-forget)
    fetch(`${apiUrl}/api/export/report-area`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        areaId,
        bulan:        msg.campaign.bulan,
        campaignType: msg.contact.area.contactType,
      }),
    }).catch(() => {})
  }

  console.log(`[worker] reply from ${phone} fanned out to ${messages.length} message(s)`)
}

// Called when pollReplies detects that the expected outgoing message is absent from
// WhatsApp's chat DOM (stale anchor). The message was marked SENT in the DB but was
// never actually delivered. Mark it FAILED so the user can see and retry it.
async function handleStaleMessage(phone: string): Promise<void> {
  const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const staleMessages = await db.message.findMany({
    where: {
      phone,
      status:   { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:    null,
      campaign: {
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
        ],
      },
    },
    select: { id: true, campaignId: true, sentAt: true },
    orderBy: { sentAt: 'desc' },
  })

  if (staleMessages.length === 0) return

  for (const msg of staleMessages) {
    await db.message.update({
      where: { id: msg.id },
      data: {
        status:     'FAILED',
        failedAt:   new Date(),
        failReason: 'WhatsApp delivery not confirmed — message absent from chat during reply poll. Retry to resend.',
      },
    }).catch((e) => console.warn(`[worker] handleStaleMessage update failed for msg ${msg.id}:`, e))

    await db.campaign.update({
      where: { id: msg.campaignId },
      data:  { failedCount: { increment: 1 } },
    }).catch(() => {})

    console.warn(`[worker] marked msg:${msg.id} (phone:${phone}) as FAILED — stale delivery`)
  }
}

function startReplyPolling() {
  console.log(`[worker] reply polling every ${REPLY_POLL_INTERVAL / 1000}s`)

  let _isPolling = false

  const poll = async () => {
    const online = agentManager.getAllAgents().find(({ agent }) => agent.status === 'connected')
    if (!online) {
      console.log('[poll] skipping — no agent connected')
      return
    }
    if (_isPolling) {
      console.log('[poll] previous poll still running, skipping this tick')
      return
    }
    _isPolling = true
    try {
      // 1. Expire old unreplied messages first (shrinks the pool permanently)
      await expireOldMessages()

      // 2. Get batched + prioritised unreplied phones
      const unrepliedPhones = await getUnrepliedPhones()
      if (unrepliedPhones.size === 0) return
      console.log(`[agent:${online.agentId}][poll] checking ${unrepliedPhones.size} unreplied phone(s)`)
      await online.agent.pollReplies(handleReply, unrepliedPhones as Map<string, Date>, handleStaleMessage)

      // 3. Update lastPolledAt for all phones in this batch
      const now = Date.now()
      for (const phone of unrepliedPhones.keys()) {
        lastPolledAt.set(phone, now)
      }

      // 4. Clean up lastPolledAt entries older than 2x cooldown (no longer relevant)
      const staleThreshold = now - REPLY_REPOLL_COOLDOWN * 2
      for (const [phone, ts] of lastPolledAt) {
        if (ts < staleThreshold) lastPolledAt.delete(phone)
      }

      console.log(`[agent:${online.agentId}][poll] done`)
    } catch (err) {
      console.error('[worker] reply poll error:', err)
    } finally {
      _isPolling = false
    }
  }

  poll()
  setInterval(poll, REPLY_POLL_INTERVAL)

  // Reconnect watcher — immediate poll when any agent goes from offline → connected
  let _prevConnected = false
  setInterval(() => {
    const now = agentManager.getAllAgents().some(({ agent }) => agent.status === 'connected')
    if (!_prevConnected && now) {
      console.log('[poll] agent reconnected — immediate reply poll')
      poll()
    }
    _prevConnected = now
  }, 5000)
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function startWarmCommandListener(): Promise<void> {
  const sub = redis.duplicate()
  await sub.subscribe('warm:command')
  sub.on('message', (_channel, message) => {
    try {
      const { cmd, sessionId } = JSON.parse(message) as { cmd: string; sessionId: string }
      if (cmd === 'start') {
        startWarmSession(sessionId).catch((err) =>
          console.error(`[warm-worker] startWarmSession failed for ${sessionId}:`, err),
        )
      } else if (cmd === 'resume') {
        resumeWarmSession(sessionId).catch((err) =>
          console.error(`[warm-worker] resumeWarmSession failed for ${sessionId}:`, err),
        )
      }
    } catch (err) {
      console.error('[warm-worker] command parse error:', err)
    }
  })
  console.log('[worker] listening on warm:command channel')
}

async function main() {
  await validateStartup()
  await agentManager.init(redis)
  await agentManager.startPollingStatus()

  const allAgents = agentManager.getAllAgents()
  console.log(`[worker] auto-starting ${allAgents.length} agent(s)…`)
  for (const { agentId } of allAgents) {
    agentManager.startAgent(agentId).catch((err) =>
      console.warn(`[agent:${agentId}] auto-start failed:`, err),
    )
  }

  console.log(`[worker] listening on queues: ${QUEUE_NAME}, ${PHONE_CHECK_QUEUE_NAME}, warm-queue`)
  startReplyPolling()
  await startWarmCommandListener()
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err)
  process.exit(1)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log('[worker] shutting down...')
  await Promise.all([worker.close(), phoneCheckWorker.close(), warmWorker.close()])
  await db.$disconnect()
  redis.disconnect()
  await agentManager.closeAll()
  await sleep(2000)
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
