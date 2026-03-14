import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import type { MessageJob } from '@aice/shared'

export const QUEUE_NAME = 'whatsapp-messages'

export const redis = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required for bullmq
})

export const messageQueue = new Queue<MessageJob>(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 500 },
  },
})
