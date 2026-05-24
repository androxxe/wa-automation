import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  const messages = await db.message.findMany({
    where: {
      status: { in: ['FAILED', 'EXPIRED'] },
      reply: { isNot: null },
    },
    include: {
      reply: { select: { body: true } },
      campaign: { select: { name: true, bulan: true } },
    },
  })

  console.log(`Found ${messages.length} FAILED/EXPIRED messages with a reply attached:\n`)

  for (const m of messages.slice(0, 30)) {
    const body = m.reply!.body.slice(0, 60)
    console.log(`  [${m.status.padEnd(7)}] ${m.phone.padEnd(18)} "${body}"`)
  }

  if (messages.length > 30) {
    console.log(`  ... and ${messages.length - 30} more`)
  }

  if (!dryRun && messages.length > 0) {
    const result = await db.message.updateMany({
      where: { id: { in: messages.map((m) => m.id) } },
      data: { status: 'READ', readAt: new Date() },
    })
    console.log(`\n→ Updated ${result.count} messages to READ`)

    // Decrement failedCount on affected campaigns
    for (const m of messages) {
      if (m.status === 'FAILED') {
        await db.campaign.update({
          where: { id: m.campaignId },
          data: { failedCount: { decrement: 1 } },
        }).catch(() => {})
      }
    }
    console.log('→ Decremented failedCount for affected campaigns')
  } else {
    console.log('\nDry run — pass --no-dry-run to apply.')
  }
}

main().catch(console.error).finally(() => db.$disconnect())
