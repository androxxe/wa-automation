import 'dotenv/config'
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


const QUEUE_NAME             = 'whatsapp-messages'
const PHONE_CHECK_QUEUE_NAME = 'phone-check'
const REPLY_POLL_INTERVAL    = parseInt(process.env.REPLY_POLL_INTERVAL_MS ?? '60000', 10)
// dailySendCap, breakEvery, typeDelay are now per-agent (BrowserAgent fields).
// Env vars remain as fallback defaults when an agent has no override.

// Per-agent session send counters (in-memory; reset on worker restart)
const sessionSendCount = new Map<number, number>()

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

      const online = agentManager.getAllAgents()
        .filter(({ agent: a }) => a.status === 'connected')

      if (online.length === 0) {
        console.log('[worker] no agent online, waiting 10s…')
        await sleep(10_000)
        continue
      }

      // Sort by activity; bump preferred agent to front if specified
      online.sort((a, b) => a.agent.activeJobCount - b.agent.activeJobCount)
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
    let agent   = await agentManager.getLeastBusyAgent().catch(() => null)
    while (!agent) {
      if (Date.now() - start > 5 * 60 * 1000) throw new Error('No agent online — cannot check phone')
      await sleep(5000)
      agent = await agentManager.getLeastBusyAgent().catch(() => null)
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

// Returns Map<phone, sentAt> so pollReplies can anchor to when each message was sent.
async function getUnrepliedPhones(): Promise<Map<string, Date>> {
  const messages = await db.message.findMany({
    where:  { status: { in: ['SENT', 'DELIVERED', 'READ'] }, reply: null },
    select: { phone: true, sentAt: true },
  })
  const map = new Map<string, Date>()
  for (const m of messages) {
    // Keep the EARLIEST sentAt per phone so the anchor covers all sent messages
    const existing = map.get(m.phone)
    const ts = m.sentAt ?? new Date(0)
    if (!existing || ts < existing) map.set(m.phone, ts)
  }
  return map
}

async function handleReply(params: {
  phone:          string
  text:           string
  screenshotPath: string | null
}) {
  const { phone, text, screenshotPath } = params

  // Fan-out: ALL unreplied messages for this phone (covers STIK + KARDUS)
  const messages = await db.message.findMany({
    where: {
      phone,
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      reply:  null,
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
      const unrepliedPhones = await getUnrepliedPhones()
      if (unrepliedPhones.size === 0) return
      console.log(`[agent:${online.agentId}][poll] checking ${unrepliedPhones.size} unreplied phone(s)`)
      await online.agent.pollReplies(handleReply, unrepliedPhones as Map<string, Date>)
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

  console.log(`[worker] listening on queues: ${QUEUE_NAME}, ${PHONE_CHECK_QUEUE_NAME}`)
  startReplyPolling()
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err)
  process.exit(1)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown() {
  console.log('[worker] shutting down...')
  await Promise.all([worker.close(), phoneCheckWorker.close()])
  await db.$disconnect()
  redis.disconnect()
  await agentManager.closeAll()
  await sleep(2000)
  process.exit(0)
}

process.on('SIGINT',  shutdown)
process.on('SIGTERM', shutdown)
