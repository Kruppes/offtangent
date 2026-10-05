/**
 * In-process registry of running native local Ollama inference (plan
 * 2026-10-05-native-ollama-prefill-fix, addendum H5 + review F9/F3/F10).
 *
 * Incident 2026-10-05 (strand 17213ea5): while a long native turn was in
 * prefill, the session-summary job (Legacy /v1, same server, same model) and
 * the provider health check (a real completion request) landed in the SAME
 * serial runner queue, so the turn request waited behind them and the health
 * check timed out behind the turn.
 *
 * Two kinds of leases:
 * - Request lease (`beginLocalInference`): held by the native stream wrapper
 *   while one request is in flight.
 * - Turn lease (`beginLocalTurn`): held by AgentCore for the lifetime of one
 *   turn of a strand (session id). A native request of a session with an
 *   active turn binds its server+model to that turn, so the key stays busy
 *   across the tool gaps between the turn's requests and is released the
 *   moment the turn ends — normally, by error or by cancel. No time-based
 *   linger: a summary right after the user's own finished turn (/new) does
 *   not wait.
 *
 * Background work (summary, health check) asks `isLocalInferenceBusy` /
 * `waitForLocalInferenceIdle` before it queues its own inference. Only native
 * requests register, so for every other provider nothing changes.
 *
 * Key = URL origin (lowercased; loopback aliases localhost / 127.x / [::1]
 * collapse to one host, the port is kept) + model id (lowercased, `:latest`
 * stripped), so `/v1` Legacy and native `/api` of one server match.
 *
 * Stale bound (F10): a key without ANY activity (request start, streamed
 * event, request end) for LOCAL_INFERENCE_STALE_MS counts as idle and is
 * dropped, so a leaked lease (iterator abandoned without return()) can never
 * block background work for good. The bound is above the native first-token
 * hard cap (15 min), during which a healthy prefill legitimately streams
 * nothing.
 */

export const LOCAL_INFERENCE_STALE_MS = 20 * 60_000

interface Entry {
  /** Request leases in flight. */
  active: number
  /** Session ids of active turns that used this key. */
  turns: Set<string>
  lastActivityAt: number
}
const entries = new Map<string, Entry>()
/** Active turn leases per session id (a counter: nested/parallel turns of one strand). */
const activeTurns = new Map<string, number>()

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function localInferenceKey(baseUrl: unknown, modelId: unknown): string | null {
  if (typeof baseUrl !== 'string' || typeof modelId !== 'string' || !baseUrl || !modelId) return null
  let origin: string
  try {
    const url = new URL(baseUrl)
    const host = url.hostname.toLowerCase()
    const loopback = LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    origin = loopback ? `${url.protocol}//loopback:${url.port}` : url.origin.toLowerCase()
  } catch {
    return null
  }
  const model = modelId.trim().toLowerCase().replace(/:latest$/, '')
  return model ? `${origin}|${model}` : null
}

/**
 * Mark one turn of a strand as running. Native requests of this session made
 * while it runs keep their server+model busy until the returned (idempotent)
 * release is called.
 */
export function beginLocalTurn(sessionId: unknown): () => void {
  if (typeof sessionId !== 'string' || !sessionId) return () => {}
  activeTurns.set(sessionId, (activeTurns.get(sessionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (activeTurns.get(sessionId) ?? 1) - 1
    if (left > 0) {
      activeTurns.set(sessionId, left)
      return
    }
    activeTurns.delete(sessionId)
    for (const [key, entry] of entries) {
      entry.turns.delete(sessionId)
      if (entry.active === 0 && entry.turns.size === 0) entries.delete(key)
    }
  }
}

export interface LocalInferenceLease {
  /** Idempotent end of the request. */
  (): void
  /** Record activity (a streamed event) for the stale bound. */
  touch: () => void
}

/**
 * Mark one inference request as running. With the session id of an active
 * turn the key additionally stays bound to that turn until the turn ends.
 */
export function beginLocalInference(
  baseUrl: unknown,
  modelId: unknown,
  opts: { sessionId?: string; now?: () => number } = {},
): LocalInferenceLease {
  const now = opts.now ?? Date.now
  const key = localInferenceKey(baseUrl, modelId)
  if (!key) return Object.assign(() => {}, { touch: () => {} })
  const entry = entries.get(key) ?? { active: 0, turns: new Set<string>(), lastActivityAt: now() }
  entry.active += 1
  entry.lastActivityAt = now()
  if (opts.sessionId && activeTurns.has(opts.sessionId)) entry.turns.add(opts.sessionId)
  entries.set(key, entry)
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.active = Math.max(0, entry.active - 1)
    entry.lastActivityAt = now()
    if (entry.active === 0 && entry.turns.size === 0 && entries.get(key) === entry) entries.delete(key)
  }
  return Object.assign(release, { touch: () => { if (!released) entry.lastActivityAt = now() } })
}

/** True while a request runs on this server+model, or a turn that used it is still active. */
export function isLocalInferenceBusy(baseUrl: unknown, modelId: unknown, now: number = Date.now()): boolean {
  const key = localInferenceKey(baseUrl, modelId)
  if (!key) return false
  const entry = entries.get(key)
  if (!entry) return false
  if (now - entry.lastActivityAt >= LOCAL_INFERENCE_STALE_MS) {
    console.warn(`[local-inference] dropping stale lease (no activity for ${now - entry.lastActivityAt}ms)`)
    entries.delete(key)
    return false
  }
  return entry.active > 0 || entry.turns.size > 0
}

export interface WaitIdleResult { waitedMs: number; timedOut: boolean }

/**
 * Wait (bounded) until the server+model is idle. Never waits longer than
 * `maxWaitMs`; afterwards the caller proceeds anyway (timedOut=true) so a
 * stuck lease can never block background work forever.
 */
export async function waitForLocalInferenceIdle(
  baseUrl: unknown,
  modelId: unknown,
  opts: { maxWaitMs: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<WaitIdleResult> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const pollMs = Math.max(1, opts.pollMs ?? 5_000)
  const start = now()
  while (isLocalInferenceBusy(baseUrl, modelId, now())) {
    const waited = now() - start
    if (waited >= opts.maxWaitMs) return { waitedMs: waited, timedOut: true }
    await sleep(Math.min(pollMs, opts.maxWaitMs - waited))
  }
  return { waitedMs: now() - start, timedOut: false }
}

/** Counts for leak checks in tests: keys held and turns registered. */
export function localInferenceActivitySizeForTest(): { keys: number; turns: number } {
  return { keys: entries.size, turns: activeTurns.size }
}

export function resetLocalInferenceActivityForTest(): void {
  entries.clear()
  activeTurns.clear()
}
