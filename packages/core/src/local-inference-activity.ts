/**
 * In-process registry of running native local Ollama inference (plan
 * 2026-10-05-native-ollama-prefill-fix, addendum H5).
 *
 * Incident 2026-10-05 (strand 17213ea5): while a long native turn was in
 * prefill, the session-summary job (Legacy /v1, same server, same model) and
 * the provider health check (a real completion request) landed in the SAME
 * serial runner queue, so the turn request waited behind them and the health
 * check timed out behind the turn.
 *
 * The native stream wrapper holds a lease per request. After the last lease of
 * a key ends, the key stays busy for a short linger so the tool gaps between
 * two requests of one turn are covered. Background work (summary, health
 * check) asks `isLocalInferenceBusy` / `waitForLocalInferenceIdle` before it
 * queues its own inference. Only native requests register, so for every other
 * provider nothing changes.
 *
 * Key = URL origin (lowercased, so `/v1` Legacy and native `/api` of one
 * server match) + model id (lowercased, `:latest` stripped).
 */

export const LOCAL_INFERENCE_LINGER_MS = 60_000

interface Entry { active: number; lastEndAt: number }
const entries = new Map<string, Entry>()

export function localInferenceKey(baseUrl: unknown, modelId: unknown): string | null {
  if (typeof baseUrl !== 'string' || typeof modelId !== 'string' || !baseUrl || !modelId) return null
  let origin: string
  try {
    origin = new URL(baseUrl).origin.toLowerCase()
  } catch {
    return null
  }
  const model = modelId.trim().toLowerCase().replace(/:latest$/, '')
  return model ? `${origin}|${model}` : null
}

/** Mark one inference request as running; the returned release is idempotent. */
export function beginLocalInference(baseUrl: unknown, modelId: unknown, now: () => number = Date.now): () => void {
  const key = localInferenceKey(baseUrl, modelId)
  if (!key) return () => {}
  const entry = entries.get(key) ?? { active: 0, lastEndAt: 0 }
  entry.active += 1
  entries.set(key, entry)
  let released = false
  return () => {
    if (released) return
    released = true
    entry.active = Math.max(0, entry.active - 1)
    entry.lastEndAt = now()
  }
}

/** True while a request runs on this server+model, or within the linger after the last one. */
export function isLocalInferenceBusy(baseUrl: unknown, modelId: unknown, now: number = Date.now()): boolean {
  const key = localInferenceKey(baseUrl, modelId)
  if (!key) return false
  const entry = entries.get(key)
  if (!entry) return false
  if (entry.active > 0) return true
  if (now - entry.lastEndAt < LOCAL_INFERENCE_LINGER_MS) return true
  entries.delete(key)
  return false
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

export function resetLocalInferenceActivityForTest(): void {
  entries.clear()
}
