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
