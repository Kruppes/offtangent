/**
 * Data-minimal request diagnostics for the native Ollama path (plan
 * 2026-10-05-native-ollama-prefill-fix, goal 2).
 *
 * One log line per request, never any message text, tool arguments or
 * secrets: only counts, roles, character lengths, the conservative token
 * estimate, Eco markers (how many tool results in the request are Eco
 * projections) and the native request knobs. Timing lines follow at first
 * output and at the end (with Ollama's own prompt/eval counts when reported).
 *
 * Per-message hashes are OPT-IN (`AXIOM_NATIVE_DIAG_HASHES=1`): keyed
 * HMAC-SHA256 with a random per-process key, truncated to 8 hex chars. They
 * only answer "is message i of request A identical to message j of request B
 * inside this process lifetime" (e.g. a doubled session); they cannot be
 * reversed or compared across restarts or hosts.
 *
 * Output goes to the container log (console), so the existing log rotation of
 * the deployment applies; nothing is written to the database or the repo.
 */
import { createHmac, randomBytes } from 'node:crypto'
import type { Context } from '@earendil-works/pi-ai'

const HASH_KEY = randomBytes(32)

export function nativeDiagHashesEnabled(): boolean {
  return process.env.AXIOM_NATIVE_DIAG_HASHES === '1'
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown }
    if (typeof b.text === 'string') n += b.text.length
    else if (typeof b.thinking === 'string') n += b.thinking.length
    else if (b.type === 'toolCall') {
      try { n += JSON.stringify(b.arguments ?? null).length } catch { /* unmeasurable */ }
    }
  }
  return n
}

function keyedHash(value: unknown): string {
  let text: string
  try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? '' } catch { text = '' }
  return createHmac('sha256', HASH_KEY).update(text).digest('hex').slice(0, 8)
}

const ROLE_SHORT: Record<string, string> = { user: 'u', assistant: 'a', toolResult: 't', system: 's' }

export interface NativeRequestDiagnostics {
  messageCount: number
  roles: Record<string, number>
  totalChars: number
  maxMessageChars: number
  systemChars: number
  toolCount: number
  /** Tool results in this request that carry an Eco projection (`details.eco`). */
  ecoFrozenResults: number
  /** Per-message `role:chars[:hash]` (hash only when opted in). Bounded to the last 200. */
  perMessage: string[]
}

export function summarizeNativeRequest(context: Context, withHashes = nativeDiagHashesEnabled()): NativeRequestDiagnostics {
  const roles: Record<string, number> = {}
  let totalChars = 0
  let maxMessageChars = 0
  let ecoFrozenResults = 0
  const perMessage: string[] = []
  const messages = context.messages ?? []
  messages.forEach((m, i) => {
    const role = String((m as { role?: unknown }).role ?? '?')
    roles[role] = (roles[role] ?? 0) + 1
    const chars = contentChars((m as { content?: unknown }).content)
    totalChars += chars
    if (chars > maxMessageChars) maxMessageChars = chars
    const details = (m as { details?: unknown }).details
    if (role === 'toolResult' && details && typeof details === 'object' && (details as { eco?: unknown }).eco) ecoFrozenResults++
    if (i >= messages.length - 200) {
      const short = ROLE_SHORT[role] ?? '?'
      perMessage.push(withHashes ? `${short}:${chars}:${keyedHash((m as { content?: unknown }).content)}` : `${short}:${chars}`)
    }
  })
  return {
    messageCount: messages.length,
    roles,
    totalChars,
    maxMessageChars,
    systemChars: (context.systemPrompt ?? '').length,
    toolCount: context.tools?.length ?? 0,
    ecoFrozenResults,
    perMessage,
  }
}

export function formatNativeRequestDiagnostics(fields: {
  requestId: string
  sessionId?: string
  provider?: unknown
  model?: unknown
  numCtx?: number
  numCtxState?: string
  think?: unknown
  estimatedInputTokens: number
  diag: NativeRequestDiagnostics
}): string {
  const { diag } = fields
  const roles = Object.entries(diag.roles).map(([r, n]) => `${r}=${n}`).join(',')
  return `[native-diag] req=${fields.requestId} session=${fields.sessionId ?? '-'} provider=${String(fields.provider ?? '-')} `
    + `model=${String(fields.model ?? '-')} at=${new Date().toISOString()} msgs=${diag.messageCount} roles=${roles || '-'} `
    + `chars=${diag.totalChars} max_msg_chars=${diag.maxMessageChars} sys_chars=${diag.systemChars} tools=${diag.toolCount} `
    + `eco_frozen_results=${diag.ecoFrozenResults} think=${fields.think === undefined ? '-' : String(fields.think)} `
    + `num_ctx=${fields.numCtx ?? '-'} num_ctx_state=${fields.numCtxState ?? '-'} est_input_tokens=${fields.estimatedInputTokens} `
    + `per_msg=${boundedPerMessage(diag.perMessage)}`
}

/** Bounded log line: the newest entries matter most (what this request added). */
const PER_MSG_LOG_LIMIT = 80
function boundedPerMessage(entries: string[]): string {
  if (entries.length <= PER_MSG_LOG_LIMIT) return entries.join(' ')
  return `[+${entries.length - PER_MSG_LOG_LIMIT} older] ` + entries.slice(-PER_MSG_LOG_LIMIT).join(' ')
}
