import { PrismaClient } from '@prisma/client'

// Worker has its own Prisma client instance.
// Schema lives in packages/api/prisma/schema.prisma.
// Run `pnpm db:generate` from the repo root before starting the worker.
export const db = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})
