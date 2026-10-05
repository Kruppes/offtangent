/**
 * First-token wait of a native local Ollama request (plan
 * 2026-10-05-native-ollama-prefill-fix).
 *
 * A local model has to prefill the whole (uncached) prompt before it emits its
 * first token. On the Mac runner that is ~145 tok/s, so a 30k-token prompt
 * takes ~210 s of complete silence — which the turn watchdog (one global
 * 90 s idle abort) used to treat as a dead provider, abort, and retry, putting
 * the same prefill back into the same runner queue (incident 2026-10-05,
 * strand 17213ea5).
 *
 * This module is a tiny side channel, keyed by session id, from the native
 * Ollama stream wrapper (which knows when a request was dispatched and when
 * the first real output arrived) to the TurnRunner watchdog of that session
 * (which owns the abort). Nothing here touches other providers: only the
 * native path emits phases, so for every other api the watchdog behaves
 * exactly as before.
 *
 * Budget strategy (explicit and conservative — no invented precision): the
 * prompt cache hit rate is NOT known before the first token, so the whole
 * conservative input estimate (chars/3) is treated as uncached and divided by
 * an assumed prefill rate below the measured one, plus a fixed allowance for
 * model load / runner queue. The result is clamped between the normal stall
 * abort threshold (never shorter than before) and a hard ceiling.
 */

/** Fixed allowance for model load + other requests ahead in the runner queue. */
export const NATIVE_FIRST_TOKEN_BASE_MS = 120_000
/**
 * Assumed prefill rate in tokens/s. Deliberately below the 145 tok/s measured
 * for Qwen on the Mac runner (2026-10-05), so a slower moment still fits.
 */
export const NATIVE_ASSUMED_PREFILL_TOKENS_PER_S = 100
/** Hard ceiling: no first-token wait is ever longer than this. */
export const NATIVE_FIRST_TOKEN_HARD_CAP_MS = 15 * 60_000

/**
 * First-token budget for a native request with the given conservative input
 * estimate. Never below `floorMs` (the regular stall abort threshold), never
 * above the hard cap. Unknown/invalid estimates fall back to the base
 * allowance (still >= floor).
 */
export function nativeFirstTokenBudgetMs(estimatedInputTokens: number | undefined, floorMs: number): number {
  const tokens = typeof estimatedInputTokens === 'number' && Number.isFinite(estimatedInputTokens) && estimatedInputTokens > 0
    ? estimatedInputTokens : 0
  const raw = NATIVE_FIRST_TOKEN_BASE_MS + Math.ceil((tokens / NATIVE_ASSUMED_PREFILL_TOKENS_PER_S) * 1000)
  const floor = Number.isFinite(floorMs) && floorMs > 0 ? floorMs : 0
  return Math.min(NATIVE_FIRST_TOKEN_HARD_CAP_MS, Math.max(floor, raw))
}

export type ProviderPhaseEvent =
  | {
    /** The request was dispatched; no output yet (prefill / runner queue). */
    phase: 'awaiting_first_token'
    requestId: string
    /** Conservative input estimate (chars/3, not a tokenizer count). */
    estimatedInputTokens: number
  }
  | {
    /** First real output (thinking, text or tool call) or the end of the stream. */
    phase: 'first_token'
    requestId: string
    elapsedMs: number
  }
  | {
    /** The request is over (done, error or aborted). */
    phase: 'request_end'
    requestId: string
  }

type Listener = (event: ProviderPhaseEvent) => void
const listeners = new Map<string, Set<Listener>>()

/** Subscribe to the phases of native requests made for `sessionId`. */
export function subscribeProviderPhase(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(sessionId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(sessionId)
  }
}

/** Emit a phase; listener errors never reach the stream. */
export function emitProviderPhase(sessionId: string | undefined, event: ProviderPhaseEvent): void {
  if (!sessionId) return
  const set = listeners.get(sessionId)
  if (!set) return
  for (const listener of [...set]) {
    try {
      listener(event)
    } catch (err) {
      console.error('[provider-phase] listener failed:', err)
    }
  }
}
