import { analyzeReply } from './llm.js'

async function main() {
  const args = process.argv.slice(2)
  if (!args[0]) throw new Error('Usage: pnpm test:analyze "<reply text>" [bulan]')
  const replyText = args[0]
  const bulan = args[1] ?? 'Januari'

  console.log(`\nInput  : "${replyText}" (bulan: "${bulan}")`)
  console.log('─'.repeat(50))

  const result = await analyzeReply(replyText, bulan)

  console.log('\nOutput:')
  console.log('  category :', result.category)
  console.log('  sentiment:', result.sentiment)
  console.log('  summary  :', result.summary)
  console.log('  jawaban  :', result.jawaban)
  console.log()
}

main().catch(console.error)
