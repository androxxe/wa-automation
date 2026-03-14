import 'dotenv/config'
import { Worker, type Job } from 'bullmq'
import type { MessageJob } from '@aice/shared'
import { db } from './lib/db'
import { redis } from './lib/redis'
import { browserManager } from './lib/browser'
import { validateStartup } from './lib/validate'
import {
  isWorkingHours,
  msUntilNextOpen,
  gaussianDelay,
  randomBreakDuration,
  sleep,
} from './lib/scheduler'

const QUEUE_NAME = 'whatsapp-messages'
const DAILY_SEND_CAP = parseInt(process.env.DAILY_SEND_CAP ?? '150', 10)
const BREAK_EVERY = parseInt(process.env.MID_SESSION_BREAK_EVERY ?? '30', 10)

let sessionSendCount = 0

// ─── Daily cap helpers ────────────────────────────────────────────────────────

async function todaySendCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const log = await db.dailySendLog.findUnique({ where: { date: today } })
  return log?.count ?? 0
}

async function incrementDailyCount(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await db.dailySendLog.upsert({
    where: { date: today },
    update: { count: { increment: 1 } },
    create: { date: today, count: 1 },
  })
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker<MessageJob>(
  QUEUE_NAME,
  async (job: Job<MessageJob>) => {
    const { messageId, phone, body, campaignId } = job.data

    // 1. Check daily cap
    const sentToday = await todaySendCount()
    if (sentToday >= DAILY_SEND_CAP) {
      const delay = msUntilNextOpen()
      console.log(`[worker] daily cap reached (${sentToday}), delaying ${Math.round(delay / 60000)}m`)
      await sleep(delay)
    }

    // 2. Check working hours
    if (!isWorkingHours()) {
      const delay = msUntilNextOpen()
      console.log(`[worker] outside working hours, delaying ${Math.round(delay / 60000)}m`)
      await sleep(delay)
    }

    // 3. Mid-session break
    sessionSendCount++
    if (sessionSendCount > 0 && sessionSendCount % BREAK_EVERY === 0) {
      const breakDuration = randomBreakDuration()
      console.log(`[worker] mid-session break: ${Math.round(breakDuration / 60000)}m`)
      await db.campaign.updateMany({
        where: { id: campaignId },
        data: {},  // TODO: emit SSE break event via Redis pub/sub
      })
      await sleep(breakDuration)
    }

    // 4. Claude message variation
    let variedBody = body
    try {
      const { varyMessage } = await import('@anthropic-ai/sdk').then(() =>
        // Inline variation to avoid circular dep with api package
        import('./lib/claude').then((m) => ({ varyMessage: m.varyMessage }))
      )
      variedBody = await varyMessage(body)
    } catch (err) {
      console.warn('[worker] claude variation failed, using original body:', err)
    }

    // 5. Gaussian delay
    const delay = gaussianDelay()
    console.log(`[worker] waiting ${Math.round(delay / 1000)}s before send`)
    await sleep(delay)

    // 6. Send via Playwright
    await browserManager.sendMessage(phone, variedBody)

    // 7. Update message status
    await db.message.update({
      where: { id: messageId },
      data: { status: 'SENT', sentAt: new Date(), body: variedBody },
    })
    await incrementDailyCount()

    // 8. Update campaign sent count
    await db.campaign.update({
      where: { id: campaignId },
      data: { sentCount: { increment: 1 } },
    })

    console.log(`[worker] sent message ${messageId} to ${phone}`)

    // 9. TODO: start delivery-status polling (10s intervals, 3 min max)
    // 10. TODO: emit SSE campaign:progress event via Redis pub/sub
  },
  {
    connection: redis,
    concurrency: 1,  // Single serial send — never parallel
  },
)

worker.on('failed', async (job, err) => {
  if (!job) return
  console.error(`[worker] job ${job.id} failed:`, err)
  await db.message.update({
    where: { id: job.data.messageId },
    data: { status: 'FAILED', failedAt: new Date(), failReason: String(err) },
  }).catch(() => {})
})

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main() {
  await validateStartup()
  await browserManager.launch()
  console.log(`[worker] browser status: ${browserManager.status}`)
  console.log(`[worker] listening on queue: ${QUEUE_NAME}`)
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err)
  process.exit(1)
})
