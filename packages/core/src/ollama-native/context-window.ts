/**
 * Per-strand Eco context window for the NATIVE Ollama provider (pure policy).
 *
 * Semantics (see docs/plans: ollama-native-context):
 * - `null` = "Unverändert": no `options.num_ctx` is ever sent, the server keeps
 *   whatever window it has configured (modelfile / server env / defaults).
 * - A chosen preset can only RAISE the window for one request:
 *   num_ctx = max(baseline, choice). A smaller choice never lowers it.
 * - The baseline must be ESTABLISHED (explicit provider setting or the
 *   modelfile `num_ctx` from /api/show). `/api/ps` (loaded context) is volatile
 *   and shared with other strands, so it is never used as baseline. Unknown
 *   baseline → no override, no guessed floor.
 * - The architecture maximum (`<arch>.context_length`) is a separate
 *   supported maximum; choices above it are rejected, unknown → no override.
 * - Nothing here mutates server config, modelfiles, env or other strands.
 */

export const ECO_CONTEXT_PRESETS = [32768, 49152, 65536, 131072] as const

/** Hard sanity ceiling independent of model metadata (no arbitrary resource requests). */
export const MAX_NUM_CTX = 1_048_576

export type ContextWindowChoice = number | null

export function isValidNumCtx(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_NUM_CTX
}

/**
 * Smallest configurable per-model baseline: below this no current chat model
 * is usable, so a smaller value is almost certainly a typo (e.g. "40" for 40k).
 */
export const MIN_NUM_CTX_BASELINE = 1024

/** A configured per-model baseline: integer MIN_NUM_CTX_BASELINE…MAX_NUM_CTX. */
export function isValidNumCtxBaseline(value: unknown): value is number {
  return isValidNumCtx(value) && value >= MIN_NUM_CTX_BASELINE
}

export function parseContextWindowChoice(raw: unknown): { ok: true; value: ContextWindowChoice } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { ok: false, error: 'contextWindow must be null or an integer preset' }
  if (!(ECO_CONTEXT_PRESETS as readonly number[]).includes(raw)) {
    return { ok: false, error: `contextWindow must be one of ${ECO_CONTEXT_PRESETS.join(', ')} or null` }
  }
  return { ok: true, value: raw }
}

/** One value of the native `/api/show` `thinking.values` list (Ollama ≥ 0.3x). */
export type OllamaThinkValue = boolean | OllamaThinkLevel
export const OLLAMA_THINK_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type OllamaThinkLevel = typeof OLLAMA_THINK_LEVELS[number]

export interface OllamaModelFacts {
  /** `num_ctx` from the modelfile parameters (/api/show `parameters`). */
  modelfileNumCtx?: number
  /**
   * Explicit per-MODEL num_ctx baseline configured on the Offtangent provider
   * (operator setting, measured server default for models whose modelfile has
   * no num_ctx). Outranks the provider-wide setting and the modelfile.
   */
  modelNumCtx?: number
  /** Explicit num_ctx configured on the Offtangent provider (operator setting). */
  providerNumCtx?: number
  /** Architecture maximum from /api/show `model_info["<arch>.context_length"]`. */
  supportedMax?: number
  /**
   * Accepted `think` values from /api/show `thinking.values` (e.g. Qwen
   * `[false,'low','medium','xhigh']`, Gemma `[false,true]`). Undefined = the
   * server advertises nothing → the legacy `resolveThink` wire is kept.
   */
  thinkValues?: OllamaThinkValue[]
}

/** Extract facts from an /api/show response. Garbage is ignored, never guessed. */
export function parseOllamaShow(raw: unknown): OllamaModelFacts {
  const facts: OllamaModelFacts = {}
  if (!raw || typeof raw !== 'object') return facts
  const r = raw as { parameters?: unknown; model_info?: unknown; thinking?: unknown }
  if (typeof r.parameters === 'string') {
    for (const lineRaw of r.parameters.split('\n')) {
      const m = /^\s*num_ctx\s+(\S+)\s*$/.exec(lineRaw)
      if (m) {
        const n = Number(m[1])
        if (isValidNumCtx(n)) facts.modelfileNumCtx = n
      }
    }
  }
  if (r.model_info && typeof r.model_info === 'object') {
    for (const [key, value] of Object.entries(r.model_info as Record<string, unknown>)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        facts.supportedMax = value
      }
    }
  }
  if (r.thinking && typeof r.thinking === 'object') {
    const values = (r.thinking as { values?: unknown }).values
    if (Array.isArray(values)) {
      const kept = values.filter((v): v is OllamaThinkValue => typeof v === 'boolean' || (typeof v === 'string' && (OLLAMA_THINK_LEVELS as readonly string[]).includes(v)))
      if (kept.length > 0) facts.thinkValues = [...new Set(kept)]
    }
  }
  return facts
}

/**
 * Map the strand's thinking level onto the values the server advertises for
 * this model. OFF (or no level) → `false` when advertised, else the field is
 * omitted (the model cannot switch thinking off; never send a rejected value).
 * ON → the exact level, else the next LOWER advertised level (never more
 * compute than asked), else the lowest higher level, else `true`.
 */
export function resolveNativeThink(values: readonly OllamaThinkValue[], level: string | undefined): { think: OllamaThinkValue | undefined } {
  const on = typeof level === 'string' && level.length > 0 && level !== 'off'
  if (!on) return { think: values.includes(false) ? false : undefined }
  const levels = OLLAMA_THINK_LEVELS.filter(l => values.includes(l))
  if (levels.length > 0) {
    const wanted = OLLAMA_THINK_LEVELS.indexOf(level as OllamaThinkLevel)
    if (wanted >= 0 && levels.includes(level as OllamaThinkLevel)) return { think: level as OllamaThinkLevel }
    const lower = wanted >= 0 ? levels.filter(l => OLLAMA_THINK_LEVELS.indexOf(l) < wanted) : []
    if (lower.length > 0) return { think: lower[lower.length - 1] }
    return { think: levels[0] }
  }
  return { think: values.includes(true) ? true : undefined }
}

export type Baseline = { known: true; value: number; source: 'model_setting' | 'provider_setting' | 'modelfile' } | { known: false }

export function resolveBaseline(facts: OllamaModelFacts): Baseline {
  if (isValidNumCtx(facts.modelNumCtx)) return { known: true, value: facts.modelNumCtx, source: 'model_setting' }
  if (isValidNumCtx(facts.providerNumCtx)) return { known: true, value: facts.providerNumCtx, source: 'provider_setting' }
  if (isValidNumCtx(facts.modelfileNumCtx)) return { known: true, value: facts.modelfileNumCtx, source: 'modelfile' }
  return { known: false }
}

export type ContextWindowState =
  | 'unchanged' // no choice
  | 'applied' // num_ctx override sent
  | 'baseline_kept' // choice <= baseline, nothing sent
  | 'provider_unsupported' // not the native provider (e.g. /v1 adapter)
  | 'baseline_unknown'
  | 'supported_unknown'
  | 'exceeds_supported'
  | 'invalid_choice'

export interface NumCtxDecision {
  /** Value for `options.num_ctx`, or undefined = do not send the key at all. */
  numCtx: number | undefined
  state: ContextWindowState
  /** Window the native request guard must use (undefined when not established). */
  guardWindow: number | undefined
}

export function decideNumCtx(input: { nativeProvider: boolean; choice: ContextWindowChoice | undefined; facts: OllamaModelFacts }): NumCtxDecision {
  const baseline = resolveBaseline(input.facts)
  const baseWindow = baseline.known ? baseline.value : undefined
  if (!input.nativeProvider) return { numCtx: undefined, state: 'provider_unsupported', guardWindow: undefined }
  const choice = input.choice ?? null
  if (choice === null) return { numCtx: undefined, state: 'unchanged', guardWindow: baseWindow }
  if (!parseContextWindowChoice(choice).ok) return { numCtx: undefined, state: 'invalid_choice', guardWindow: baseWindow }
  if (!baseline.known) return { numCtx: undefined, state: 'baseline_unknown', guardWindow: undefined }
  if (choice <= baseline.value) return { numCtx: undefined, state: 'baseline_kept', guardWindow: baseline.value }
  const max = input.facts.supportedMax
  if (max === undefined || !Number.isSafeInteger(max) || max <= 0) return { numCtx: undefined, state: 'supported_unknown', guardWindow: baseline.value }
  if (choice > max) return { numCtx: undefined, state: 'exceeds_supported', guardWindow: baseline.value }
  return { numCtx: choice, state: 'applied', guardWindow: choice }
}
