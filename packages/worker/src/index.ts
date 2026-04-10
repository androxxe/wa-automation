import { Worker, Queue, DelayedError, type Job } from 'bullmq'
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
  pollIntervalForMessage,
} from './lib/scheduler'
import { warmWorker, startWarmSession, resumeWarmSession } from './lib/warm-worker'


const QUEUE_NAME             = 'whatsapp-messages'
const PHONE_CHECK_QUEUE_NAME = 'phone-check'
const REPLY_POLL_INTERVAL    = parseInt(process.env.REPLY_POLL_INTERVAL_MS ?? '60000', 10)
const REPLY_WINDOW_DAYS      = parseInt(process.env.CAMPAIGN_REPLY_WINDOW_DAYS ?? '3', 10)
const REPLY_EXPIRE_DAYS      = parseInt(process.env.REPLY_EXPIRE_DAYS ?? '3', 10)
const REPLY_BATCH_SIZE       = parseInt(process.env.REPLY_BATCH_SIZE ?? '10', 10)
const REPLY_REPOLL_COOLDOWN  = parseInt(process.env.REPLY_REPOLL_COOLDOWN_MS ?? '600000', 10)
const PHONE_POLL_COOLDOWN    = parseInt(process.env.REPLY_POLL_COOLDOWN_MS ?? '180000', 10)
const SIDEBAR_RATIO          = parseFloat(process.env.SIDEBAR_SEND_RATIO ?? '0.70')
const MANUAL_SEND_CHANNEL    = process.env.MANUAL_SEND_CHANNEL ?? 'manual-send:cmd'
const ALLOW_MANUAL_OUTSIDE_HOURS = process.env.ALLOW_MANUAL_OUTSIDE_HOURS === 'true'
// REPLY_POLL_CONCURRENCY is now read from DB (appConfig.replyPollConcurrency) each poll cycle.
// Env var serves as fallback when the DB value is missing.
const REPLY_POLL_CONCURRENCY_DEFAULT = parseInt(process.env.REPLY_POLL_CONCURRENCY ?? '1', 10)
// dailySendCap, breakEvery, typeDelay are now per-agent (BrowserAgent fields).
// Env vars remain as fallback defaults when an agent has no override.

// Per-agent session send counters (in-memory; reset on worker restart)
const sessionSendCount = new Map<number, number>()

// Throttle "sending disabled" log — only log once per 5 minutes
let lastSendDisabledLogAt = 0
const SEND_DISABLED_LOG_INTERVAL = 5 * 60 * 1000
const SEND_DISABLED_RESCHEDULE   = 5 * 60 * 1000 // 5 minutes
const CHAT_LOAD_TIMEOUT_MS       = 15000
const CHAT_LOAD_RETRY_TIMEOUT_MS = Math.max(1000, Math.floor(CHAT_LOAD_TIMEOUT_MS / 2))

// Round-robin index — persists across jobs, resets on worker restart
let roundRobinIndex = 0

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

    // 0b. Check dynamic toggle — pause sending if disabled via Settings
    {
      const cfg = await db.appConfig.findUnique({ where: { id: 'singleton' } })
      if (cfg && !cfg.sendEnabled) {
        const now = Date.now()
        if (now - lastSendDisabledLogAt >= SEND_DISABLED_LOG_INTERVAL) {
          console.log(`[worker] sending disabled via settings, rescheduling messages in ${SEND_DISABLED_RESCHEDULE / 60000}m`)
          lastSendDisabledLogAt = now
        }
        await job.moveToDelayed(Date.now() + SEND_DISABLED_RESCHEDULE, token)
        throw new DelayedError()
      }
    }

    // 0c. Resolve agent — pick the least-busy online agent that hasn't hit its daily cap.
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

      // Use cached status from the 15s polling interval instead of forcing a
      // DOM-based status check on every job. The old approach waited up to 30s
      // per agent (180s total for 6 agents) before each message, severely
      // limiting throughput. The 15s AgentManager polling is frequent enough
      // to detect disconnections.
      const allAgents = agentManager.getAllAgents()

      const online = allAgents
        .filter(({ agent: a, agentId }) =>
          a.status === 'connected' && !excludedAgentIds.has(agentId),
        )

      if (online.length === 0) {
        console.log('[worker] no agent online, waiting 10s…')
        await sleep(10_000)
        continue
      }

      // Round-robin: sort by agentId for a stable order, then rotate starting
      // position using a persistent index so each job picks the next agent in
      // sequence. This distributes sends evenly across agents — important for
      // minimising per-account volume and reducing WhatsApp ban risk.
      online.sort((a, b) => a.agentId - b.agentId)
      if (preferredAgentId) {
        const idx = online.findIndex(({ agentId }) => agentId === preferredAgentId)
        if (idx > 0) online.unshift(...online.splice(idx, 1))
      }

      // Pick the next agent under its daily cap, starting from roundRobinIndex
      for (let i = 0; i < online.length; i++) {
        const candidate = online[(roundRobinIndex + i) % online.length].agent
        const sent = await todaySendCount(candidate.agentId)
        if (sent < candidate.dailySendCap) {
          agent = candidate
          roundRobinIndex = (roundRobinIndex + i + 1) % online.length
          break
        }
      }

      if (!agent) {
        // All online agents have hit their cap — release job back to BullMQ delayed queue
        const delay = msUntilNextOpen()
        console.log(`[worker] all agents at daily cap, rescheduling in ${Math.round(delay / 60000)}m`)
        await job.moveToDelayed(Date.now() + delay, token)
        throw new DelayedError()
      }
    }

    agent.activeJobCount++
    const usedAgentId = agent.agentId
    const log = (msg: string) => console.log(`[agent:${usedAgentId}] ${msg}`)

    // Record which agent will handle this message BEFORE attempting the send,
    // so even if the send fails the agentId is persisted for reply polling.
    await db.message.update({
      where: { id: messageId },
      data:  { agentId: usedAgentId },
    }).catch(() => {})

    try {
      log(`picked up msg:${messageId} → ${phone}`)

      // 1. Working hours — reschedule via BullMQ instead of sleeping
      if (!isWorkingHours()) {
        const delay = msUntilNextOpen()
        log(`outside working hours, rescheduling in ${Math.round(delay / 60000)}m`)
        agent.activeJobCount--
        await job.moveToDelayed(Date.now() + delay, token)
        throw new DelayedError()
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

      // 4. Send — mixed navigation (sidebar search vs direct URL)
      const isRetryAttempt = (job.attemptsMade ?? 0) > 0
      const chatLoadTimeoutMs = isRetryAttempt ? CHAT_LOAD_RETRY_TIMEOUT_MS : CHAT_LOAD_TIMEOUT_MS
      log(`chat-load timeout for this attempt: ${chatLoadTimeoutMs}ms (attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1})`)
      const useSidebar = Math.random() < SIDEBAR_RATIO
      if (useSidebar) {
        log(`sending via sidebar search to ${phone}…`)
        await agent.sendMessageViaSidebar(phone, body, chatLoadTimeoutMs)
      } else {
        log(`sending via URL to ${phone}…`)
        await agent.sendMessage(phone, body, chatLoadTimeoutMs)
      }

      // 6. Update message record
      await db.message.updateMany({
        where: { id: messageId },
        data:  {
          status: 'SENT',
          sentAt: new Date(),
          body: body,
          agentId: usedAgentId,
          failedAt: null,
          failReason: null,
        },
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

worker.on('error', (err) => {
  console.error('[worker] worker error:', err)
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
  { connection: redis as never, concurrency: parseInt(process.env.PHONE_CHECK_CONCURRENCY ?? '3', 10), lockDuration: 10 * 60 * 1000 },
)

phoneCheckWorker.on('failed', (job, err) => {
  console.error(`[phone-check] failed for ${job?.data.phone}:`, err)
  if (job?.data.phone) redis.del(`wa:checking:${job.data.phone}`).catch(() => {})
})

phoneCheckWorker.on('error', (err) => {
  console.error('[phone-check] worker error:', err)
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

// Returns Map<agentId, Map<phone, sentAt>> — grouped by sending agent so each agent
// only polls replies for conversations it owns. Batched and prioritised per agent.
async function getUnrepliedPhonesByAgent(): Promise<Map<number, Map<string, Date>>> {
  const replyWindowCutoff = new Date(Date.now() - REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const messages = await db.message.findMany({
    where:  {
      status:   { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:    null,
      agentId:  { not: null },
      campaign: {
        OR: [
          { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          { status: 'COMPLETED', completedAt: { gte: replyWindowCutoff } },
        ],
      },
    },
    select: { phone: true, sentAt: true, agentId: true },
  })

  // Group by agentId, deduplicating by phone within each agent (keep MOST RECENT sentAt)
  const byAgent = new Map<number, Map<string, Date>>()
  for (const m of messages) {
    const agentId = m.agentId!
    if (!byAgent.has(agentId)) byAgent.set(agentId, new Map())
    const agentMap = byAgent.get(agentId)!
    const ts = m.sentAt ?? new Date(0)
    const existing = agentMap.get(m.phone)
    if (!existing || ts > existing) agentMap.set(m.phone, ts)
  }

  // Apply prioritisation + batching per agent
  const result = new Map<number, Map<string, Date>>()
  const now = Date.now()

  for (const [agentId, phoneMap] of byAgent) {
    // Filter: only include phones whose adaptive poll interval has elapsed
    const duePhones = [...phoneMap.entries()].filter(([phone, sentAt]) => {
      const lastPoll = lastPolledAt.get(phone) ?? 0
      const elapsed  = now - lastPoll
      const interval = pollIntervalForMessage(sentAt)
      const cooldown = Math.max(interval, PHONE_POLL_COOLDOWN)
      return elapsed >= cooldown
    })

    // Sort remaining phones by priority
    const entries = duePhones.sort((a, b) => {
      const aLastPoll = lastPolledAt.get(a[0]) ?? 0
      const bLastPoll = lastPolledAt.get(b[0]) ?? 0
      const aInCooldown = aLastPoll > 0 && (now - aLastPoll) < REPLY_REPOLL_COOLDOWN
      const bInCooldown = bLastPoll > 0 && (now - bLastPoll) < REPLY_REPOLL_COOLDOWN

      if (aInCooldown !== bInCooldown) return aInCooldown ? 1 : -1
      if (aLastPoll !== bLastPoll) return aLastPoll - bLastPoll
      return b[1].getTime() - a[1].getTime()
    })

    const batched = new Map<string, Date>()
    for (const [phone, sentAt] of entries.slice(0, REPLY_BATCH_SIZE)) {
      batched.set(phone, sentAt)
    }

    const skipped = phoneMap.size - duePhones.length
    if (skipped > 0) {
      console.log(`[poll] agent:${agentId} skipped ${skipped} phone(s) still in adaptive cooldown`)
    }
    if (phoneMap.size > REPLY_BATCH_SIZE) {
      console.log(`[poll] agent:${agentId} has ${phoneMap.size} unreplied phones, batched to ${batched.size}`)
    }

    if (batched.size > 0) result.set(agentId, batched)
  }

  return result
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

/**
 * Run async functions with a concurrency limit (simple semaphore).
 * All functions are executed; at most `limit` run at the same time.
 */
async function runWithConcurrency(fns: Array<() => Promise<void>>, limit: number): Promise<void> {
  let idx = 0
  const next = async (): Promise<void> => {
    while (idx < fns.length) {
      const fn = fns[idx++]
      await fn()
    }
  }
  const workers = Array.from({ length: Math.min(limit, fns.length) }, () => next())
  await Promise.allSettled(workers)
}

function startReplyPolling() {
  console.log(`[worker] reply polling every ${REPLY_POLL_INTERVAL / 1000}s (default concurrency: ${REPLY_POLL_CONCURRENCY_DEFAULT})`)

  let _isPolling = false

  const poll = async () => {
    if (_isPolling) {
      console.log('[poll] previous poll still running, skipping this tick')
      return
    }
    _isPolling = true
    try {
      // Check dynamic toggles from Settings
      const appConfig = await db.appConfig.findUnique({ where: { id: 'singleton' } })
      if (appConfig && !appConfig.replyPollEnabled) {
        console.log('[poll] reply polling disabled via settings, skipping')
        return
      }
      const pollConcurrency = (appConfig as Record<string, unknown>)?.replyPollConcurrency as number | undefined
        ?? REPLY_POLL_CONCURRENCY_DEFAULT

      // 1. Expire old unreplied messages first (shrinks the pool permanently)
      await expireOldMessages()

      // 2. Get unreplied phones grouped by sending agent
      const byAgent = await getUnrepliedPhonesByAgent()
      if (byAgent.size === 0) return

      // 3. Each connected agent polls its own sent phones — with LIMITED concurrency
      const allAgents = agentManager.getAllAgents()
      let polledAny = false

      const pollFns: Array<() => Promise<void>> = []

      for (const [agentId, phones] of byAgent) {
        const entry = allAgents.find(({ agentId: id }) => id === agentId)
        if (!entry || entry.agent.status !== 'connected') {
          // Sending agent is offline — skip, we can't check its chats from another session
          continue
        }

        // Skip agents that are currently sending — don't let reply polling
        // block the send pipeline. The agent will be polled next cycle when idle.
        if (entry.agent.activeJobCount > 0) {
          console.log(`[agent:${agentId}][poll] busy sending (${entry.agent.activeJobCount} job), skipping this cycle`)
          continue
        }

        console.log(`[agent:${agentId}][poll] checking ${phones.size} unreplied phone(s)`)
        polledAny = true

        pollFns.push(async () => {
          try {
            await entry.agent.pollReplies(handleReply, phones, handleStaleMessage)
            // Update lastPolledAt for all phones polled by this agent
            const now = Date.now()
            for (const phone of phones.keys()) {
              lastPolledAt.set(phone, now)
            }
          } catch (err) {
            console.error(`[agent:${agentId}][poll] error:`, err)
          }
        })
      }

      if (pollFns.length > 0) {
        // Run at most pollConcurrency agents simultaneously (configurable via Settings)
        await runWithConcurrency(pollFns, pollConcurrency)
      }

      // 5. Clean up lastPolledAt entries older than 2x cooldown (no longer relevant)
      const now = Date.now()
      const staleThreshold = now - REPLY_REPOLL_COOLDOWN * 2
      for (const [phone, ts] of lastPolledAt) {
        if (ts < staleThreshold) lastPolledAt.delete(phone)
      }

      if (polledAny) console.log('[poll] done')
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

// ─── Startup reconciliation ───────────────────────────────────────────────────

/**
 * On worker startup, find messages stuck as QUEUED in MySQL that have no
 * corresponding BullMQ job (e.g. Redis data was lost). Re-enqueue them so
 * they get processed.
 */
async function reconcileStuckQueued(): Promise<void> {
  const queue = new Queue<MessageJob>(QUEUE_NAME, { connection: redis as never })

  try {
    // 1. Find all QUEUED messages in RUNNING campaigns
    const stuckMessages = await db.message.findMany({
      where: {
        status:   'QUEUED',
        campaign: { status: 'RUNNING' },
      },
      include: {
        campaign: { select: { id: true } },
        contact:  { select: { id: true } },
      },
    })

    if (stuckMessages.length === 0) {
      console.log('[reconcile] no stuck QUEUED messages found')
      return
    }

    console.log(`[reconcile] found ${stuckMessages.length} QUEUED message(s) in RUNNING campaigns`)

    // 2. Get all existing job IDs from BullMQ (waiting + delayed + active)
    const [waiting, delayed, active] = await Promise.all([
      queue.getJobs(['waiting', 'prioritized'], 0, -1),
      queue.getJobs(['delayed'], 0, -1),
      queue.getJobs(['active'], 0, -1),
    ])
    const existingMessageIds = new Set<string>()
    for (const job of [...waiting, ...delayed, ...active]) {
      if (job?.data?.messageId) existingMessageIds.add(job.data.messageId)
    }

    // 3. Filter to only orphaned messages (no matching BullMQ job)
    const orphaned = stuckMessages.filter((m) => !existingMessageIds.has(m.id))

    if (orphaned.length === 0) {
      console.log(`[reconcile] all ${stuckMessages.length} QUEUED message(s) have matching BullMQ jobs — no action needed`)
      return
    }

    console.log(`[reconcile] ${orphaned.length} orphaned QUEUED message(s) — re-enqueueing to BullMQ`)

    // 4. Re-enqueue orphaned messages
    const jobs = orphaned.map((m) => ({
      name: 'message',
      data: {
        messageId:  m.id,
        campaignId: m.campaignId,
        contactId:  m.contactId,
        phone:      m.phone,
        body:       m.body,
      } satisfies MessageJob,
    }))

    await queue.addBulk(jobs)
    console.log(`[reconcile] re-enqueued ${jobs.length} message(s) successfully`)
  } finally {
    await queue.close()
  }
}

// ─── Manual send (fire-and-forget) ────────────────────────────────────────────

interface ManualSendCommand {
  requestId:    string
  phone:        string
  body:         string
  agentId?:     number
  requestedBy?: string
  dryRun?:      boolean
  messageId?:   string
}

async function selectManualAgent(preferredAgentId?: number) {
  const online = agentManager.getAllAgents()
    .filter(({ agent }) => agent.status === 'connected' && !agent.validationOnly)

  if (preferredAgentId) {
    const found = online.find(({ agentId }) => agentId === preferredAgentId)
    if (found) return found.agent
  }

  if (online.length === 0) return null

  online.sort((a, b) => a.agent.activeJobCount - b.agent.activeJobCount)
  return online[0].agent
}

async function handleManualSend(cmd: ManualSendCommand): Promise<void> {
  const { requestId, phone, body, agentId, dryRun, messageId } = cmd
  const log = (msg: string) => console.log(`[manual-send:${requestId}] ${msg}`)

  try {
    const agent = await selectManualAgent(agentId)
    if (!agent) {
      log('no online agent available (excluding validation-only)')
      return
    }

    if (dryRun) {
      log(`dry-run ok via agent:${agent.agentId}`)
      return
    }

    if (!ALLOW_MANUAL_OUTSIDE_HOURS && !isWorkingHours()) {
      log('blocked: outside working hours (ALLOW_MANUAL_OUTSIDE_HOURS=false)')
      return
    }

    const sentToday = await todaySendCount(agent.agentId)
    if (sentToday >= agent.dailySendCap) {
      log(`blocked: daily cap reached (${agent.dailySendCap}) for agent:${agent.agentId}`)
      return
    }

    agent.activeJobCount++
    try {
      log(`sending via agent:${agent.agentId} to ${phone}`)
      await agent.sendMessage(phone, body)
      await incrementDailyCount(agent.agentId)
      if (messageId) {
        await db.message.update({
          where: { id: messageId },
          data:  {
            status:  'SENT',
            sentAt:  new Date(),
            agentId: agent.agentId,
            body,
            failedAt: null,
            failReason: null,
          },
        }).catch((e) => log(`warn: failed to update message status: ${e}`))
      }
      log('sent')
    } catch (err) {
      if (messageId) {
        await db.message.update({
          where: { id: messageId },
          data:  { status: 'FAILED', failReason: String(err).slice(0, 500) },
        }).catch(() => {})
      }
      log(`error: ${err}`)
    } finally {
      agent.activeJobCount--
    }
  } catch (err) {
    console.error(`[manual-send:${requestId}] unexpected error:`, err)
  }
}

async function startManualSendListener(): Promise<void> {
  const sub = redis.duplicate()
  await sub.subscribe(MANUAL_SEND_CHANNEL)
  sub.on('message', (_channel, message) => {
    try {
      const cmd = JSON.parse(message) as ManualSendCommand
      ;(async () => handleManualSend(cmd))().catch((err) =>
        console.error('[manual-send] handler error:', err),
      )
    } catch (err) {
      console.error('[manual-send] command parse error:', err)
    }
  })
  console.log(`[worker] listening on ${MANUAL_SEND_CHANNEL} channel`)
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

async function startManualPollListener(): Promise<void> {
  const sub = redis.duplicate()
  await sub.subscribe('reply:poll-manual')
  sub.on('message', (_channel, message) => {
    try {
      const { byAgent } = JSON.parse(message) as {
        byAgent: Record<string, Record<string, string>> // agentId → { phone → sentAtISO }
      }

      // Process in background — don't block the subscriber
      ;(async () => {
        const allAgents = agentManager.getAllAgents()

        for (const [agentIdStr, phoneEntries] of Object.entries(byAgent)) {
          const agentId = parseInt(agentIdStr, 10)
          const entry   = allAgents.find(({ agentId: id }) => id === agentId)

          if (!entry || entry.agent.status !== 'connected') {
            console.warn(`[manual-poll] agent:${agentId} is not connected, skipping ${Object.keys(phoneEntries).length} phone(s)`)
            continue
          }

          // Build the Map<string, Date> that pollReplies expects
          const phonesMap = new Map<string, Date>()
          for (const [phone, sentAtISO] of Object.entries(phoneEntries)) {
            phonesMap.set(phone, new Date(sentAtISO))
          }

          console.log(`[manual-poll] agent:${agentId} polling ${phonesMap.size} phone(s)`)

          try {
            await entry.agent.pollReplies(handleReply, phonesMap, handleStaleMessage)
            // Update lastPolledAt tracking
            const now = Date.now()
            for (const phone of phonesMap.keys()) {
              lastPolledAt.set(phone, now)
            }
            console.log(`[manual-poll] agent:${agentId} done polling ${phonesMap.size} phone(s)`)
          } catch (err) {
            console.error(`[manual-poll] agent:${agentId} error:`, err)
          }
        }

        console.log('[manual-poll] done')
      })().catch((err) => console.error('[manual-poll] unexpected error:', err))
    } catch (err) {
      console.error('[manual-poll] command parse error:', err)
    }
  })
  console.log('[worker] listening on reply:poll-manual channel')
}

async function main() {
  await validateStartup()

  // Re-enqueue any QUEUED messages orphaned by Redis data loss BEFORE
  // agents come online and the worker starts picking up new jobs.
  await reconcileStuckQueued()

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
  await startManualSendListener()
  await startManualPollListener()
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
