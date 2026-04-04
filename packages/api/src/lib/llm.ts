import type { ColumnMapping, ReplyAnalysis } from '@aice/shared'
import * as claude from './claude'
import * as gemini from './gemini'

type Provider = 'anthropic' | 'openai' | 'gemini'

const PROVIDER: Provider = (process.env.LLM_PROVIDER?.toLowerCase() ?? 'anthropic') as Provider

function getProvider() {
  switch (PROVIDER) {
    case 'gemini':
      return gemini
    case 'anthropic':
    default:
      return claude
  }
}

export async function mapHeaders(
  headers: string[],
  sampleRows: Record<string, unknown>[],
): Promise<ColumnMapping> {
  return getProvider().mapHeaders(headers, sampleRows)
}

export async function analyzeReply(
  replyText: string,
  bulan: string,
): Promise<ReplyAnalysis> {
  return getProvider().analyzeReply(replyText, bulan)
}

export async function varyMessage(renderedMessage: string): Promise<string> {
  return getProvider().varyMessage(renderedMessage)
}
