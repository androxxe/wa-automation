import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import type { MessageJob, PhoneCheckJob, WarmJob } from '@aice/shared'

export const QUEUE_NAME = 'whatsapp-messages'
export const PHONE_CHECK_QUEUE_NAME = 'phone-check'
export const WARM_QUEUE_NAME = 'warm-queue'

export const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required for bullmq
})

export const messageQueue = new Queue<MessageJob>(QUEUE_NAME, {
  connection: redis as never, // ioredis version mismatch between bullmq and app — safe at runtime
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
})

export const phoneCheckQueue = new Queue<PhoneCheckJob>(PHONE_CHECK_QUEUE_NAME, {
  connection: redis as never,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 500 },
  },
})

export const warmQueue = new Queue<WarmJob>(WARM_QUEUE_NAME, {
  connection: redis as never,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 500 },
    removeOnFail:     { count: 500 },
  },
})
