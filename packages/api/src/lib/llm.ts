import type { ColumnMapping, ReplyAnalysis } from '@aice/shared'
import * as claude from './claude'
import * as gemini from './gemini'
import * as openai from './openai'
import * as opencode from './opencode'

type Provider = 'anthropic' | 'openai' | 'gemini' | 'opencode'

const PROVIDER: Provider = (process.env.LLM_PROVIDER?.toLowerCase() ?? 'anthropic') as Provider

function getProvider() {
  switch (PROVIDER) {
    case 'opencode':
      return opencode
    case 'openai':
      return openai
    case 'gemini':
      return gemini
    case 'anthropic':
    default:
      return claude
  }
}

/** Human-readable LLM model name for display in the UI. */
export function getModelDisplayName(): string {
  switch (PROVIDER) {
    case 'opencode': {
      const m = process.env.OPCODE_MODEL ?? 'deepseek-v4-flash'
      const names: Record<string, string> = {
        'deepseek-v4-flash': 'DeepSeek V4 Flash',
        'deepseek-v4-pro':   'DeepSeek V4 Pro',
        'qwen3.5-plus':      'Qwen 3.5 Plus',
        'qwen3.6-plus':      'Qwen 3.6 Plus',
        'glm-5':             'GLM-5',
        'glm-5.1':           'GLM-5.1',
        'kimi-k2.5':         'Kimi K2.5',
        'kimi-k2.6':         'Kimi K2.6',
        'mimo-v2.5':         'MiMo V2.5',
        'mimo-v2.5-pro':     'MiMo V2.5 Pro',
        'minimax-m2.5':      'MiniMax M2.5',
        'minimax-m2.7':      'MiniMax M2.7',
      }
      return names[m] ?? m
    }
    case 'openai': {
      const m = process.env.OPENAI_MODEL ?? 'gpt-4o-mini'
      const names: Record<string, string> = {
        'gpt-4o':        'GPT-4o',
        'gpt-4o-mini':   'GPT-4o Mini',
        'gpt-4-turbo':   'GPT-4 Turbo',
        'o1-mini':       'o1 Mini',
        'o1-preview':    'o1 Preview',
      }
      return names[m] ?? m
    }
    case 'gemini': {
      const m = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash'
      const names: Record<string, string> = {
        'gemini-2.0-flash':      'Gemini 2.0 Flash',
        'gemini-2.0-pro':        'Gemini 2.0 Pro',
        'gemini-1.5-flash':      'Gemini 1.5 Flash',
        'gemini-1.5-pro':        'Gemini 1.5 Pro',
      }
      return names[m] ?? m
    }
    case 'anthropic': {
      const m = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5'
      const names: Record<string, string> = {
        'claude-sonnet-4-20250514':     'Claude Sonnet 4',
        'claude-3-5-haiku-20241022':    'Claude 3.5 Haiku',
        'claude-3-opus-20240229':       'Claude 3 Opus',
        'claude-3-haiku-20240307':      'Claude 3 Haiku',
        'claude-haiku-4-5':            'Claude Haiku 4.5',
      }
      return names[m] ?? m
    }
    default:
      return 'AI'
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
  if (process.env.DISABLE_REPLY_ANALYSIS === 'true') {
    return {
      category: 'unclear',
      sentiment: 'neutral',
      summary: `Auto-skipped (DISABLE_REPLY_ANALYSIS is set)`,
      jawaban: null,
    }
  }
  return getProvider().analyzeReply(replyText, bulan)
}

export async function varyMessage(renderedMessage: string): Promise<string> {
  return getProvider().varyMessage(renderedMessage)
}
