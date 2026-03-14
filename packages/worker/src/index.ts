import 'dotenv/config'
import { Worker, type Job } from 'bullmq'
import type { MessageJob, PhoneCheckJob } from '@aice/shared'
import { db } from './lib/db'
import { redis } from './lib/redis'
import { browserManager, setStatusPublisher } from './lib/browser'
import { validateStartup } from './lib/validate'
import {
  isWorkingHours,
  msUntilNextOpen,
  gaussianDelay,
  randomBreakDuration,
  sleep,
} from './lib/scheduler'

const QUEUE_NAME = 'whatsapp-messages'
const PHONE_CHECK_QUEUE_NAME = 'phone-check'
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

    // 0a. Verify message still exists — stale jobs remain in Redis after db:fresh
    const messageExists = await db.message.findUnique({
      where: { id: messageId },
      select: { id: true },
    })
    if (!messageExists) {
      console.warn(`[worker] message ${messageId} not found in DB — stale job, skipping`)
      return
    }

    // 0b. Wait until browser is connected — poll every 10s, up to 10 min
    const BROWSER_WAIT_INTERVAL = 10_000
    const BROWSER_WAIT_TIMEOUT = 10 * 60 * 1000
    const browserWaitStart = Date.now()
    while (browserManager.status !== 'connected') {
      if (Date.now() - browserWaitStart > BROWSER_WAIT_TIMEOUT) {
        throw new Error('Browser not connected after 10 minutes — scan the QR code in Settings')
      }
      console.log(`[worker] browser not ready (${browserManager.status}), waiting 10s...`)
      await sleep(BROWSER_WAIT_INTERVAL)
      await browserManager.getStatus()
    }

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

    // 4. Gaussian delay
    const delay = gaussianDelay()
    console.log(`[worker] waiting ${Math.round(delay / 1000)}s before send`)
    await sleep(delay)

    // 5. Send via Playwright
    await browserManager.sendMessage(phone, body)

    // 7. Update message status (updateMany never throws if record is missing)
    await db.message.updateMany({
      where: { id: messageId },
      data: { status: 'SENT', sentAt: new Date(), body: body },
    })
    await incrementDailyCount()

    // 8. Update campaign sent count
    await db.campaign.updateMany({
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

  const failReason = String(err)

  await db.message.update({
    where: { id: job.data.messageId },
    data: { status: 'FAILED', failedAt: new Date(), failReason },
  }).catch(() => {})

  // If the failure is because the number is not on WhatsApp,
  // mark the contact as invalid so it's excluded from future campaigns.
  if (failReason.includes('tidak terdaftar')) {
    await db.contact.update({
      where: { id: job.data.contactId },
      data: { phoneValid: false, waChecked: true },
    }).catch(() => {})
    console.log(`[worker] contact ${job.data.contactId} (${job.data.phone}) marked invalid — tidak terdaftar di WA`)
  }
})

// ─── Phone-check worker ───────────────────────────────────────────────────────
// Processes jobs from the `phone-check` queue (queued via POST /api/contacts/validate-wa).
// Checks each phone number against WhatsApp Web and updates contact.phoneValid in DB.

const phoneCheckWorker = new Worker<PhoneCheckJob>(
  PHONE_CHECK_QUEUE_NAME,
  async (job: Job<PhoneCheckJob>) => {
    const { phone, contactId } = job.data

    // Wait for browser to be ready — up to 5 minutes
    const start = Date.now()
    while (browserManager.status !== 'connected') {
      if (Date.now() - start > 5 * 60 * 1000) {
        throw new Error('Browser not connected — cannot check phone')
      }
      await sleep(5000)
      await browserManager.getStatus()
    }

    const registered = await browserManager.checkPhoneRegistered(phone)

    if (contactId) {
      await db.contact.update({
        where: { id: contactId },
        data: { phoneValid: registered, waChecked: true },
      }).catch(() => {})
    }

    console.log(`[phone-check] ${phone} → ${registered ? 'terdaftar' : 'TIDAK terdaftar'}`)
    return { phone, registered }
  },
  {
    connection: redis as never,
    concurrency: 1,
  },
)

phoneCheckWorker.on('failed', (job, err) => {
  console.error(`[phone-check] job failed for ${job?.data.phone}:`, err)
})

// ─── Startup ──────────────────────────────────────────────────────────────────

// ─── Reply polling loop ───────────────────────────────────────────────────────

const REPLY_POLL_INTERVAL = parseInt(process.env.REPLY_POLL_INTERVAL_MS ?? '60000', 10)

async function getUnrepliedPhones(): Promise<Set<string>> {
  const messages = await db.message.findMany({
    where: {
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      reply: null,  // only contacts we haven't received a reply from yet
    },
    select: { phone: true },
  })
  return new Set(messages.map((m) => m.phone))
}

async function handleReply(params: {
  phone: string
  text: string
  screenshotPath: string | null
}) {
  const { phone, text, screenshotPath } = params

  // Find the latest sent message to this phone without a reply yet
  const message = await db.message.findFirst({
    where: {
      phone,
      status: { in: ['SENT', 'DELIVERED', 'READ'] },
      reply: null,
    },
    orderBy: { sentAt: 'desc' },
    include: { campaign: true },
  })

  if (!message) {
    console.log(`[worker] no pending message found for ${phone}, skipping reply`)
    return
  }

  // Save reply to DB
  const reply = await db.reply.create({
    data: {
      messageId: message.id,
      phone,
      body: text,
      screenshotPath,
    },
  })

  // Mark message as READ (a reply implies the message was read)
  if (message.status !== 'READ') {
    await db.message.update({
      where: { id: message.id },
      data: { status: 'READ', readAt: new Date() },
    })
    await db.campaign.update({
      where: { id: message.campaignId },
      data: { readCount: { increment: 1 } },
    })
  }

  // Update campaign reply count
  await db.campaign.update({
    where: { id: message.campaignId },
    data: { replyCount: { increment: 1 } },
  })

  console.log(`[worker] reply saved for ${phone} — message: "${text.slice(0, 50)}"`)

  // Trigger Claude analysis via API
  try {
    const apiUrl = `http://localhost:${process.env.PORT ?? 3001}`
    await fetch(`${apiUrl}/api/analyze/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        replyId: reply.id,
        replyText: text,
        bulan: message.campaign.bulan,
      }),
    })
  } catch (err) {
    console.warn('[worker] analyze/reply call failed:', err)
  }
}

function startReplyPolling() {
  console.log(`[worker] reply polling every ${REPLY_POLL_INTERVAL / 1000}s`)

  const poll = async () => {
    if (browserManager.status !== 'connected') {
      console.log(`[poll] skipping — browser not connected (${browserManager.status})`)
      return
    }
    try {
      const unrepliedPhones = await getUnrepliedPhones()
      if (unrepliedPhones.size === 0) {
        console.log('[poll] all contacts have replied, nothing to check')
        return
      }
      console.log(`[poll] checking ${unrepliedPhones.size} unreplied contact(s)...`)
      await browserManager.pollReplies(handleReply, unrepliedPhones)
      console.log('[poll] done')
    } catch (err) {
      console.error('[worker] reply poll error:', err)
    }
  }

  // Run immediately on startup to catch any replies that came in while worker was down
  poll()
  setInterval(poll, REPLY_POLL_INTERVAL)
}

async function main() {
  await validateStartup()
  setStatusPublisher(redis)
  await browserManager.launch()
  console.log(`[worker] browser status: ${browserManager.status}`)
  console.log(`[worker] listening on queue: ${QUEUE_NAME}`)
  startReplyPolling()
}

main().catch((err) => {
  console.error('[worker] fatal startup error:', err)
  process.exit(1)
})

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Give Chrome time to flush the session to disk before exiting.
// Without this, Ctrl+C kills the process before Chrome can save cookies/session.

async function shutdown() {
  console.log('[worker] shutting down gracefully...')
  await Promise.all([worker.close(), phoneCheckWorker.close()])
  await db.$disconnect()
  redis.disconnect()
  // Close browser last and give Chrome 2s to flush session to disk
  await browserManager.close()
  await sleep(2000)
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
