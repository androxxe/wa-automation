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
import { varyMessage } from './lib/claude'

const QUEUE_NAME             = 'whatsapp-messages'
const PHONE_CHECK_QUEUE_NAME = 'phone-check'
const DAILY_SEND_CAP         = parseInt(process.env.DAILY_SEND_CAP        ?? '150',   10)
const REPLY_POLL_INTERVAL    = parseInt(process.env.REPLY_POLL_INTERVAL_MS ?? '60000', 10)
// Break settings are now per-agent (BrowserAgent.breakEvery/Min/Max).
// These env vars remain as the fallback default when an agent has no override.

// Per-agent session send counters (in-memory; reset on worker restart)
const sessionSendCount = new Map<number, number>()

// ─── Daily cap helpers ────────────────────────────────────────────────────────

async function todaySendCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const log   = await db.dailySendLog.findUnique({ where: { date: today } })
  return log?.count ?? 0
}

async function incrementDailyCount(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await db.dailySendLog.upsert({
    where:  { date: today },
    update: { count: { increment: 1 } },
    create: { date: today, count: 1 },
  })
}

// ─── Message worker ───────────────────────────────────────────────────────────

const worker = new Worker<MessageJob>(
  QUEUE_NAME,
  async (job: Job<MessageJob>) => {
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

    // 0b. Resolve agent — prefer specified, fall back to least-busy pool
    const AGENT_WAIT_TIMEOUT = 10 * 60 * 1000
    const agentWaitStart     = Date.now()

    let agent = await agentManager.getLeastBusyAgent(preferredAgentId).catch(() => null)
    while (!agent) {
      if (Date.now() - agentWaitStart > AGENT_WAIT_TIMEOUT) {
        throw new Error('No agent online after 10 minutes — scan the QR code in the Agents page')
      }
      console.log('[worker] no agent online, waiting 10s…')
      await sleep(10_000)
      agent = await agentManager.getLeastBusyAgent(preferredAgentId).catch(() => null)
    }

    agent.activeJobCount++
    const usedAgentId = agent.agentId
    const log = (msg: string) => console.log(`[agent:${usedAgentId}] ${msg}`)

    try {
      log(`picked up msg:${messageId} → ${phone}`)

      // 1. Daily cap
      const sentToday = await todaySendCount()
      if (sentToday >= DAILY_SEND_CAP) {
        const delay = msUntilNextOpen()
        log(`daily cap reached (${sentToday}/${DAILY_SEND_CAP}), sleeping ${Math.round(delay / 60000)}m`)
        await sleep(delay)
      }

      // 2. Working hours
      if (!isWorkingHours()) {
        const delay = msUntilNextOpen()
        log(`outside working hours, sleeping ${Math.round(delay / 60000)}m`)
        await sleep(delay)
      }

      // 3. Mid-session break (per agent — uses agent's own break settings)
      const count = (sessionSendCount.get(usedAgentId) ?? 0) + 1
      sessionSendCount.set(usedAgentId, count)
      if (count > 0 && count % agent.breakEvery === 0) {
        const dur = randomBreakDuration(agent.breakMinMs, agent.breakMaxMs)
        log(`mid-session break #${count} (every ${agent.breakEvery}): ${Math.round(dur / 60000)}m`)
        await sleep(dur)
      }

      // 4. Gaussian delay
      const delay = gaussianDelay()
      log(`waiting ${Math.round(delay / 1000)}s before send (session #${count})`)
      await sleep(delay)

      // 5. Vary message via Claude
      const variedBody = await varyMessage(body).catch(() => body)

      // 6. Send
      log(`sending to ${phone}…`)
      await agent.sendMessage(phone, variedBody)

      // 7. Update message record
      await db.message.updateMany({
        where: { id: messageId },
        data:  { status: 'SENT', sentAt: new Date(), body: variedBody, agentId: usedAgentId },
      })
      await incrementDailyCount()

      // 8. Update campaign totals + CampaignArea sentCount
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

        // 9. Trigger CSV report so this contact appears immediately (fire-and-forget)
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
  { connection: redis as never, concurrency: 1 },
)

worker.on('failed', async (job, err) => {
  if (!job) return
  console.error(`[worker] job ${job.id} FAILED for msg:${job.data.messageId} → ${job.data.phone}:`, err)
  const failReason = String(err)
  await db.message.update({
    where: { id: job.data.messageId },
    data:  { status: 'FAILED', failedAt: new Date(), failReason },
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

async function getUnrepliedPhones(): Promise<Set<string>> {
  const messages = await db.message.findMany({
    where:  { status: { in: ['SENT', 'DELIVERED', 'READ'] }, reply: null },
    select: { phone: true },
  })
  return new Set(messages.map((m) => m.phone))
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
      await online.agent.pollReplies(handleReply, unrepliedPhones)
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
