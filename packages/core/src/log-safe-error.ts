import { createHash } from 'node:crypto'

/**
 * Map a thrown error to a fixed, log-safe class (review K0-K2-2, MAJOR-5).
 *
 * Provider and model errors are free text: an upstream error body can quote
 * the request (= the dictation) or echo a key. Notes that end up in a server
 * log or an API response therefore never carry `Error.message`, only one of
 * the classes below. The message is READ to pick a class, it is never
 * returned, so the result is always a member of `LogSafeErrorClass` (plus a
 * three digit HTTP status, which is a number and not user content).
 */
export type LogSafeErrorClass =
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'auth'
  | 'network'
  | 'model_unavailable'
  | 'context_overflow'
  | `http_${number}`
  | 'type_error'
  | 'syntax_error'
  | 'range_error'
  | 'error'
  | 'non_error'

const NAMED: Record<string, LogSafeErrorClass> = {
  TypeError: 'type_error',
  SyntaxError: 'syntax_error',
  RangeError: 'range_error',
}

export function errorClass(err: unknown): LogSafeErrorClass {
  if (typeof err !== 'object' || err === null) return 'non_error'
  const e = err as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
  const name = typeof e.name === 'string' ? e.name : ''
  const message = typeof e.message === 'string' ? e.message : ''
  const code = typeof e.code === 'string' ? e.code : ''

  if (name === 'TimeoutError' || /time(d)?\s*out|timeout|ETIMEDOUT/i.test(message) || code === 'ETIMEDOUT') return 'timeout'
  if (name === 'AbortError' || /\baborted\b/i.test(message)) return 'aborted'
  const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : null
  if (status === 429 || /rate.?limit|too many requests|\b429\b/i.test(message)) return 'rate_limited'
  if (status === 401 || status === 403 || /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.{0,20}(api.?)?key/i.test(message)) return 'auth'
  if (status !== null && Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`
  const httpInMessage = /\b([45]\d\d)\b/.exec(message)
  if (httpInMessage) return `http_${Number(httpInMessage[1])}`
  if (/^E(CONNREFUSED|CONNRESET|NOTFOUND|AI_AGAIN|PIPE)$/.test(code)
    || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|connection refused|socket hang up|fetch failed|network/i.test(message)) return 'network'
  if (/is not available|no available (model|entry)/i.test(message)) return 'model_unavailable'
  return NAMED[name] ?? (err instanceof Error ? 'error' : 'non_error')
}

/**
 * Class of a provider error that only exists as text (an assistant
 * `errorMessage`, the `error` field of a runtime chunk). Same classes as
 * {@link errorClass}, plus `context_overflow` so the user still learns that
 * the conversation got too long. Unknown text is plain `error`.
 */
export function errorTextClass(text: string | null | undefined): LogSafeErrorClass {
  const message = typeof text === 'string' ? text : ''
  if (/context.{0,20}(length|window|limit|overflow)|prompt is too long|too many (input )?tokens|maximum context/i.test(message)) {
    return 'context_overflow'
  }
  return errorClass(new Error(message))
}

/**
 * The one provider-error text a user ever sees (chat bubble, persisted error
 * row, retry notice, task-injection frame) — review K0-K2-4 #2/#3. A fixed,
 * readable sentence plus the class; the provider's own message stays inside
 * the process (retry and auth classifiers) and is never shown, stored or
 * logged, because it can echo the request (= a dictation).
 */
export function publicProviderError(text: string | null | undefined): string {
  return `The model provider reported an error (${errorTextClass(text)}).`
}

/**
 * Attach the raw provider text to an `error` chunk as a NON-enumerable
 * property (review K0-K2-5, hardening): the in-process classifiers still read
 * `chunk.rawError`, but `JSON.stringify`, `util.inspect`/`console.*`,
 * `Object.keys` and object spread never see it. A spread copy therefore loses
 * the field; a forwarder that must keep it calls this helper again.
 */
export function withRawError<T extends object>(chunk: T, rawError: string | undefined): T & { rawError?: string } {
  if (rawError !== undefined) {
    Object.defineProperty(chunk, 'rawError', { value: rawError, enumerable: false, writable: true, configurable: true })
  }
  return chunk as T & { rawError?: string }
}

/**
 * Record of a provider rejection (http_400 incident 2026-11-12) that keeps no
 * free text of the provider message (it can echo the request). Guarantees per
 * field:
 * - `status`: a number 400-499.
 * - `type`: a member of {@link PROVIDER_ERROR_TYPES} or the fixed word
 *   {@link OTHER_ERROR_TYPE}; any other provider value is dropped.
 * - `path`: a root from the fixed root list, followed only by numeric indexes
 *   and members of {@link PATH_FIELD_NAMES}; the first other segment and
 *   everything after it are replaced by {@link PATH_CUT_MARKER}.
 * - `phrases`: members of the fixed phrase list only.
 * - `fingerprint`: 12 hex characters of the sha256 of the provider message,
 *   so two occurrences can be matched (a hash, not the text).
 * - `window`: built from our own request structure, not from the provider text.
 */
export interface ProviderErrorDiagnostic {
  status?: number
  type?: string
  path?: string
  phrases?: string[]
  fingerprint: string
  /** `describeHistoryStructure` of the window that was sent (roles, block types, tool-call ordinals; no ids, capped at MAX_STRUCTURE_CHARS). */
  window?: string
}

/** Fixed phrases of provider validation errors that say WHAT is wrong, never with user content. */
const DIAGNOSTIC_PHRASES: readonly string[] = [
  'system message', 'tool blocks', 'first message', 'first user message', 'tools[]',
  'tool_use', 'tool_result', 'tool_use_id', 'tool_addition', 'tool_removal', 'tool_reference',
  'thinking', 'redacted_thinking', 'signature', 'cache_control', 'output_config', 'effort',
  'must be followed', 'must immediately follow', 'must start with', 'cannot be empty', 'empty',
  'non-empty', 'alternate', 'roles', 'user', 'assistant', 'final assistant', 'prefill',
  'duplicate', 'not found', 'unexpected', 'too long', 'too many', 'maximum', 'invalid', 'unknown',
]

/**
 * Provider `error.type` values kept as they are: the Anthropic error types and
 * the OpenAI-style ones this code base already handles. Anything else becomes
 * {@link OTHER_ERROR_TYPE}, so a provider can never put request text here.
 */
export const PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  // Anthropic
  'invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error',
  'request_too_large', 'rate_limit_error', 'api_error', 'overloaded_error', 'billing_error',
  'timeout_error',
  // OpenAI-style / OpenAI-compatible servers
  'server_error', 'insufficient_quota', 'exceed_context_size_error',
])
export const OTHER_ERROR_TYPE = 'other'

/**
 * Request field names a provider path may name after its root (Anthropic
 * Messages API and the OpenAI-style chat fields the runtime sends). A path
 * segment that is neither a number nor in this list is never kept.
 */
export const PATH_FIELD_NAMES: ReadonlySet<string> = new Set([
  'content', 'role', 'type', 'text', 'name', 'input', 'id', 'tool_use_id', 'is_error',
  'source', 'data', 'media_type', 'url', 'file_id', 'cache_control', 'ttl',
  'thinking', 'redacted_thinking', 'signature', 'citations', 'title', 'context',
  'input_schema', 'properties', 'items', 'required', 'description', 'custom', 'strict',
  'budget_tokens', 'disable_parallel_tool_use', 'effort', 'format', 'schema', 'user_id',
  'edits', 'trigger', 'keep',
  'tool_calls', 'tool_call_id', 'function', 'arguments', 'parameters', 'image_url', 'detail',
  'reasoning_content',
])
/** Replaces the first path segment that is neither a number nor a known field, and everything after it. */
export const PATH_CUT_MARKER = '<cut>'

const PATH_RE = /\b((?:messages|system|tools|tool_choice|thinking|output_config|metadata|context_management)(?:\.[A-Za-z_]{1,40}|\.\d{1,6}){0,8})\s*:/

/** Keep the root and the leading numeric / known-field segments; cut at the first other segment. */
function safePath(matched: string | undefined): string | undefined {
  if (matched === undefined) return undefined
  const [root, ...segments] = matched.split('.')
  const kept = [root]
  for (const segment of segments) {
    if (!/^\d{1,6}$/.test(segment) && !PATH_FIELD_NAMES.has(segment)) {
      kept.push(PATH_CUT_MARKER)
      break
    }
    kept.push(segment)
  }
  return kept.join('.')
}

/**
 * Structural diagnostic of a raw provider error text (pi-ai `errorMessage`,
 * e.g. `400 {"type":"error","error":{"type":"invalid_request_error","message":"..."}}`).
 * Returns null when the text carries no 4xx status (5xx, network, abort: the
 * existing class already says everything).
 */
export function providerErrorDiagnostic(raw: string | null | undefined): ProviderErrorDiagnostic | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const statusMatch = /^\s*(4\d\d)\b/.exec(raw) ?? /"status"\s*:\s*(4\d\d)\b/.exec(raw)
  if (!statusMatch) return null
  const status = Number(statusMatch[1])
  let type: string | undefined
  let message = raw
  const brace = raw.indexOf('{')
  if (brace >= 0) {
    try {
      const body = JSON.parse(raw.slice(brace)) as { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown }
      const err = body.error && typeof body.error === 'object' ? body.error : body
      if (typeof err.type === 'string') type = err.type
      if (typeof err.message === 'string') message = err.message
    } catch {
      // Not JSON: fall back to the raw text for path and phrases.
    }
  }
  if (type !== undefined && !PROVIDER_ERROR_TYPES.has(type)) type = OTHER_ERROR_TYPE
  const path = safePath(PATH_RE.exec(message)?.[1])
  const lower = message.toLowerCase()
  const phrases = DIAGNOSTIC_PHRASES.filter(p => lower.includes(p))
  return {
    status,
    ...(type ? { type } : {}),
    ...(path ? { path } : {}),
    ...(phrases.length > 0 ? { phrases } : {}),
    fingerprint: createHash('sha256').update(message).digest('hex').slice(0, 12),
  }
}

/**
 * One log line for a diagnostic. It prints only the fields of
 * {@link ProviderErrorDiagnostic}, so it carries no provider free text (see the
 * per-field guarantees there).
 */
export function formatProviderErrorDiagnostic(d: ProviderErrorDiagnostic): string {
  return `status=${d.status ?? 'n/a'} type=${d.type ?? 'n/a'} path=${d.path ?? 'n/a'} `
    + `phrases=[${(d.phrases ?? []).join('|')}] fp=${d.fingerprint}`
    + (d.window !== undefined ? ` window=${d.window}` : '')
}
