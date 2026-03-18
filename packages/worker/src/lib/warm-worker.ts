import { Worker, Queue, type Job } from 'bullmq'
import type { WarmJob } from '@aice/shared'
import { db } from './db'
import { redis } from './redis'
import { agentManager } from './agent-manager'
import warmMessages from './warm-messages.json'

// ─── Environment ──────────────────────────────────────────────────────────────

const WARM_EXCHANGE_MEAN_MS   = parseInt(process.env.WARM_EXCHANGE_MEAN_MS   ?? '1500000', 10) // 25 min
const WARM_EXCHANGE_STDDEV_MS = parseInt(process.env.WARM_EXCHANGE_STDDEV_MS ?? '300000',  10) // ±5 min
const WARM_EXCHANGE_MIN_MS    = parseInt(process.env.WARM_EXCHANGE_MIN_MS    ?? '600000',  10) // floor 10 min
const WARM_EXCHANGE_MAX_MS    = parseInt(process.env.WARM_EXCHANGE_MAX_MS    ?? '2700000', 10) // ceiling 45 min
const WARM_REPLY_MIN_MS       = parseInt(process.env.WARM_REPLY_MIN_MS       ?? '120000',  10) // 2 min
const WARM_REPLY_MAX_MS       = parseInt(process.env.WARM_REPLY_MAX_MS       ?? '480000',  10) // 8 min

const WARM_QUEUE_NAME = 'warm-queue'

export const warmQueue = new Queue<WarmJob>(WARM_QUEUE_NAME, {
  connection: redis as never,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Box-Muller transform — Gaussian sample clamped to [min, max] */
function gaussianMs(): number {
  const u1  = Math.random()
  const u2  = Math.random()
  const z   = Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2)
  const raw = WARM_EXCHANGE_MEAN_MS + z * WARM_EXCHANGE_STDDEV_MS
  return Math.min(Math.max(raw, WARM_EXCHANGE_MIN_MS), WARM_EXCHANGE_MAX_MS)
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

type MessageEntry = { id: number; category: string; text: string }

/**
 * Pick a random (message, reply) pair from warm-messages.json.
 * Avoids repeating IDs already used in the session.
 * Falls back to any available category if the preferred one is exhausted.
 */
function pickMessagePair(
  usedIds: Set<number>,
  preferredCategory?: string,
): { message: MessageEntry; reply: MessageEntry } | null {
  const messages: MessageEntry[] = warmMessages.messages as MessageEntry[]
  const replies:  MessageEntry[] = warmMessages.replies  as MessageEntry[]

  // Try preferred category first, then fall back to all categories
  const categoriesToTry = preferredCategory
    ? [preferredCategory, ...['greeting', 'food', 'weather', 'weekend', 'chit-chat', 'work-life'].filter((c) => c !== preferredCategory)]
    : ['greeting', 'food', 'weather', 'weekend', 'chit-chat', 'work-life']

  for (const cat of categoriesToTry) {
    const available = messages.filter((m) => m.category === cat && !usedIds.has(m.id))
    if (available.length === 0) continue
    const msg    = available[Math.floor(Math.random() * available.length)]
    const replyPool = replies.filter((r) => r.category === cat)
    if (replyPool.length === 0) continue
    const reply  = replyPool[Math.floor(Math.random() * replyPool.length)]
    return { message: msg, reply }
  }

  // All pairs exhausted — should not happen if totalExchanges ≤ 200
  console.warn('[warm-worker] message bank exhausted for session')
  return null
}

/**
 * Build all directed pairs from a list of agent IDs, interleaved so that
 * every agent appears as a SENDER within the first `n` exchanges
 * (where n = number of agents), rather than exhausting one sender first.
 *
 * Example — 3 agents [A, B, C]:
 *   Old: [(A→B),(A→C),(B→A),(B→C),(C→A),(C→B)]  — C sends at index 4
 *   New: [(A→B),(B→C),(C→A),(A→C),(C→B),(B→A)]  — C sends at index 2
 *
 * Algorithm:
 *   1. Group all directed pairs by sender.
 *   2. Round-robin pick one pair per sender in each pass until all are used.
 *   3. Within each sender's group, vary the recipient so consecutive exchanges
 *      with the same sender go to different recipients.
 */
function buildPairings(agentIds: number[]): Array<[number, number]> {
  const n = agentIds.length

  // Build per-sender recipient lists (excluding self)
  const bySender: Map<number, number[]> = new Map()
  for (const sender of agentIds) {
    bySender.set(sender, agentIds.filter((id) => id !== sender))
  }

  const result: Array<[number, number]> = []
  // Pointers tracking which recipient index to use next per sender
  const ptr: Map<number, number> = new Map(agentIds.map((id) => [id, 0]))

  // Total pairs = n * (n - 1)
  const total = n * (n - 1)
  let added = 0

  while (added < total) {
    for (const sender of agentIds) {
      const recipients = bySender.get(sender)!
      const p = ptr.get(sender)!
      if (p < recipients.length) {
        result.push([sender, recipients[p]])
        ptr.set(sender, p + 1)
        added++
      }
    }
  }

  return result
}

// ─── Session management ───────────────────────────────────────────────────────

/**
 * Drain all warm-queue jobs (waiting + delayed) that belong to a specific session.
 * BullMQ has no native per-session drain — iterate and remove manually.
 */
export async function drainSessionJobs(sessionId: string): Promise<void> {
  const jobs = await warmQueue.getJobs(['waiting', 'delayed'])
  await Promise.all(
    jobs
      .filter((j) => j.data.warmSessionId === sessionId)
      .map((j) => j.remove().catch(() => {})),
  )
}

/**
 * Complete a warm session — idempotent via conditional updateMany.
 * Only one concurrent caller can win the `status = 'RUNNING'` check.
 */
async function completeWarmSession(sessionId: string): Promise<void> {
  const session = await db.warmSession.findUnique({ where: { id: sessionId } })
  if (!session) return

  const repliedCount = await db.warmExchange.count({
    where: { warmSessionId: sessionId, status: 'REPLIED' },
  })
  const partialFailure = repliedCount < session.totalExchanges / 2

  // Atomic idempotency guard — only proceeds if status is still RUNNING
  const updated = await db.warmSession.updateMany({
    where: { id: sessionId, status: 'RUNNING' },
    data:  { status: 'COMPLETED', completedAt: new Date(), partialFailure },
  })
  if (updated.count === 0) return // already completed or cancelled — skip

  const sessionAgents = await db.warmSessionAgent.findMany({
    where: { warmSessionId: sessionId },
  })
  await db.agent.updateMany({
    where: { id: { in: sessionAgents.map((a) => a.agentId) } },
    data:  { isWarmed: true, warmedAt: new Date() },
  })

  redis
    .publish(
      `warm:events:${sessionId}`,
      JSON.stringify({ event: 'warm:completed', sessionId, partialFailure }),
    )
    .catch(() => {})

  console.log(
    `[warm-worker] session ${sessionId} COMPLETED (partialFailure=${partialFailure})`,
  )
}

/**
 * Check if all exchanges for a session are resolved (REPLIED or FAILED).
 * Called after persistent failure to detect early completion.
 */
async function checkSessionCompletion(sessionId: string): Promise<void> {
  const session = await db.warmSession.findUnique({ where: { id: sessionId } })
  if (!session || session.status !== 'RUNNING') return

  const resolvedCount = await db.warmExchange.count({
    where: { warmSessionId: sessionId, status: { in: ['REPLIED', 'FAILED'] } },
  })
  if (resolvedCount >= session.totalExchanges) {
    await completeWarmSession(sessionId)
  }
}

// ─── Optional reaction ────────────────────────────────────────────────────────

const REACTION_EMOJIS = ['👍', '❤️', '😂', '🔥', '😮']

async function maybeReact(job: WarmJob): Promise<void> {
  if (Math.random() > 0.25) return // only 25% chance
  const sender = agentManager.getAgent(job.senderAgentId)
  if (!sender || sender.status !== 'connected') return
  // BrowserAgent.reactToLastMessage is implemented if available on the agent
  const agent = sender as unknown as { reactToLastMessage?: (phone: string, emoji: string) => Promise<void> }
  if (typeof agent.reactToLastMessage !== 'function') return
  const emoji = REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)]
  await agent.reactToLastMessage(job.recipientPhone, emoji)
}

// ─── Job processor ────────────────────────────────────────────────────────────

async function processWarmJob(job: Job<WarmJob>): Promise<void> {
  const {
    senderAgentId,
    recipientAgentId,
    message,
    replyMessage,
    isReply,
    exchangeId,
    warmSessionId,
  } = job.data

  // Guard: discard if session is no longer active
  const sessionCheck = await db.warmSession.findUnique({
    where:  { id: warmSessionId },
    select: { status: true },
  })
  if (!sessionCheck || sessionCheck.status === 'CANCELLED' || sessionCheck.status === 'PAUSED') {
    console.log(`[warm-worker] exchange ${exchangeId} discarded — session ${warmSessionId} is ${sessionCheck?.status ?? 'gone'}`)
    return
  }

  const agentId     = isReply ? recipientAgentId : senderAgentId
  const targetPhone = isReply ? job.data.senderPhone : job.data.recipientPhone
  const text        = isReply ? replyMessage : message

  const agent = agentManager.getAgent(agentId)
  if (!agent || agent.status !== 'connected') {
    throw new Error(`Agent ${agentId} not connected`)
  }

  console.log(`[warm-worker] agent:${agentId} → ${targetPhone} (exchange:${exchangeId} isReply:${isReply})`)
  await agent.sendMessage(targetPhone, text)

  if (!isReply) {
    // Send leg: mark SENT, enqueue reply leg
    await db.warmExchange.update({
      where: { id: exchangeId },
      data:  { status: 'SENT', sentAt: new Date() },
    })
    const replyDelay = randomBetween(WARM_REPLY_MIN_MS, WARM_REPLY_MAX_MS)
    await warmQueue.add('warm-reply', { ...job.data, isReply: true }, { delay: replyDelay })
  } else {
    // Reply leg: mark REPLIED, increment doneExchanges, check completion
    await db.warmExchange.update({
      where: { id: exchangeId },
      data:  { status: 'REPLIED', repliedAt: new Date() },
    })
    await db.warmSession.update({
      where: { id: warmSessionId },
      data:  { doneExchanges: { increment: 1 } },
    })
    // Re-fetch for authoritative count after atomic increment
    const session = await db.warmSession.findUnique({ where: { id: warmSessionId } })
    if (session && session.doneExchanges >= session.totalExchanges) {
      await completeWarmSession(warmSessionId)
    }

    // Publish progress SSE (non-blocking)
    redis
      .publish(
        `warm:events:${warmSessionId}`,
        JSON.stringify({
          event:          'warm:progress',
          sessionId:      warmSessionId,
          exchangeId,
          status:         'REPLIED',
          doneExchanges:  session?.doneExchanges ?? 0,
          totalExchanges: session?.totalExchanges ?? 0,
        }),
      )
      .catch(() => {})

    // Optional reaction (25% chance) — silent fail
    maybeReact(job.data).catch(() => {})
  }
}

// ─── Worker instance ──────────────────────────────────────────────────────────

export const warmWorker = new Worker<WarmJob>(WARM_QUEUE_NAME, processWarmJob, {
  connection:   redis as never,
  concurrency:  2,
  lockDuration: 15 * 60 * 1000, // 15 min — covers reply delay window
})

warmWorker.on('failed', async (job, err) => {
  if (!job) return
  const { exchangeId, warmSessionId } = job.data

  // Only mark FAILED after all retries are exhausted (attempts = 3)
  if ((job.attemptsMade ?? 0) < (job.opts?.attempts ?? 3)) {
    console.warn(`[warm-worker] exchange ${exchangeId} attempt ${job.attemptsMade} failed, retrying:`, err.message)
    return
  }

  console.error(`[warm-worker] exchange ${exchangeId} FAILED permanently:`, err.message)
  await db.warmExchange
    .update({
      where: { id: exchangeId },
      data:  { status: 'FAILED', failReason: String(err) },
    })
    .catch(() => {})

  // Publish failure progress SSE (non-blocking)
  redis
    .publish(
      `warm:events:${warmSessionId}`,
      JSON.stringify({
        event:     'warm:progress',
        sessionId: warmSessionId,
        exchangeId,
        status:    'FAILED',
      }),
    )
    .catch(() => {})

  // Check if all exchanges are now resolved — session may be completable
  await checkSessionCompletion(warmSessionId).catch(() => {})
})

warmWorker.on('error', (err) => {
  console.error('[warm-worker] worker error:', err)
})

// ─── Session start helper (called by API route) ───────────────────────────────

/**
 * Generate all WarmExchange records + enqueue all send-leg jobs.
 * Called from POST /api/warmer/sessions/:id/start
 */
export async function startWarmSession(sessionId: string): Promise<void> {
  const session = await db.warmSession.findUnique({
    where:   { id: sessionId },
    include: { agents: { include: { agent: true } } },
  })
  if (!session) throw new Error('Session not found')
  if (session.status !== 'IDLE') throw new Error(`Session is not IDLE (status: ${session.status})`)

  const agentIds = session.agents.map((a) => a.agentId)
  const agentPhones = Object.fromEntries(
    session.agents.map((a) => [a.agentId, a.agent.phoneNumber]),
  )
  const pairs = buildPairings(agentIds)
  const categories = ['greeting', 'food', 'weather', 'weekend', 'chit-chat', 'work-life']
  const usedIds = new Set<number>()

  // Generate all exchanges upfront
  const exchanges: Array<{
    warmSessionId:    string
    senderAgentId:    number
    recipientAgentId: number
    message:          string
    replyMessage:     string
  }> = []

  for (let k = 0; k < session.totalExchanges; k++) {
    const [senderId, recipientId] = pairs[k % pairs.length]
    const cat    = categories[k % categories.length]
    const pair   = pickMessagePair(usedIds, cat)
    if (!pair) throw new Error('Message bank exhausted — reduce totalExchanges')
    usedIds.add(pair.message.id)
    exchanges.push({
      warmSessionId:    sessionId,
      senderAgentId:    senderId,
      recipientAgentId: recipientId,
      message:          pair.message.text,
      replyMessage:     pair.reply.text,
    })
  }

  // Persist all WarmExchange records
  await db.warmExchange.createMany({ data: exchanges })

  // Fetch back with IDs
  const createdExchanges = await db.warmExchange.findMany({
    where:   { warmSessionId: sessionId },
    orderBy: { createdAt: 'asc' },
  })

  // Mark session as RUNNING
  await db.warmSession.update({
    where: { id: sessionId },
    data:  { status: 'RUNNING', startedAt: new Date() },
  })

  // Enqueue send-leg jobs with incremental Gaussian delays
  let cumulativeDelay = 0
  for (const exchange of createdExchanges) {
    await warmQueue.add(
      'warm-send',
      {
        warmSessionId:    sessionId,
        exchangeId:       exchange.id,
        senderAgentId:    exchange.senderAgentId,
        recipientAgentId: exchange.recipientAgentId,
        senderPhone:      agentPhones[exchange.senderAgentId],
        recipientPhone:   agentPhones[exchange.recipientAgentId],
        message:          exchange.message,
        replyMessage:     exchange.replyMessage,
        isReply:          false,
      } satisfies WarmJob,
      { delay: cumulativeDelay },
    )
    cumulativeDelay += gaussianMs()
  }

  console.log(`[warm-worker] session ${sessionId} started — ${createdExchanges.length} exchanges enqueued`)
}

/**
 * Resume a PAUSED session.
 * Re-enqueues PENDING exchanges (fresh delays) + SENT exchanges (reply legs, min delay).
 */
export async function resumeWarmSession(sessionId: string): Promise<void> {
  const session = await db.warmSession.findUnique({
    where:   { id: sessionId },
    include: { agents: { include: { agent: true } } },
  })
  if (!session) throw new Error('Session not found')
  if (session.status !== 'PAUSED') throw new Error(`Session is not PAUSED (status: ${session.status})`)

  const agentPhones = Object.fromEntries(
    session.agents.map((a) => [a.agentId, a.agent.phoneNumber]),
  )

  await db.warmSession.update({
    where: { id: sessionId },
    data:  { status: 'RUNNING' },
  })

  // Re-enqueue PENDING exchanges with fresh Gaussian delays
  const pendingExchanges = await db.warmExchange.findMany({
    where:   { warmSessionId: sessionId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  })

  let cumulativeDelay = 0
  for (const exchange of pendingExchanges) {
    await warmQueue.add(
      'warm-send',
      {
        warmSessionId:    sessionId,
        exchangeId:       exchange.id,
        senderAgentId:    exchange.senderAgentId,
        recipientAgentId: exchange.recipientAgentId,
        senderPhone:      agentPhones[exchange.senderAgentId],
        recipientPhone:   agentPhones[exchange.recipientAgentId],
        message:          exchange.message,
        replyMessage:     exchange.replyMessage,
        isReply:          false,
      } satisfies WarmJob,
      { delay: cumulativeDelay },
    )
    cumulativeDelay += gaussianMs()
  }

  // Re-enqueue SENT exchanges as reply legs (their reply job was drained during pause)
  const sentExchanges = await db.warmExchange.findMany({
    where: { warmSessionId: sessionId, status: 'SENT' },
  })

  for (const exchange of sentExchanges) {
    await warmQueue.add(
      'warm-reply',
      {
        warmSessionId:    sessionId,
        exchangeId:       exchange.id,
        senderAgentId:    exchange.senderAgentId,
        recipientAgentId: exchange.recipientAgentId,
        senderPhone:      agentPhones[exchange.senderAgentId],
        recipientPhone:   agentPhones[exchange.recipientAgentId],
        message:          exchange.message,
        replyMessage:     exchange.replyMessage,
        isReply:          true,
      } satisfies WarmJob,
      { delay: WARM_REPLY_MIN_MS },
    )
  }

  console.log(
    `[warm-worker] session ${sessionId} RESUMED — ${pendingExchanges.length} pending + ${sentExchanges.length} stranded SENT re-enqueued`,
  )
}
