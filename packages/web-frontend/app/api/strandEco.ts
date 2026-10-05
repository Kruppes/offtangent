/**
 * Eco mode of one strand (plan 2026-10-04-eco-implementation).
 *
 *   GET   /api/strands/:id/context  -> report.eco (status + last view estimates)
 *   PATCH /api/strands/:id/eco      { enabled?: boolean, contextWindow?: number | null } -> { strandId, eco }
 *
 * Token numbers are estimates of the server's conservative counter, never
 * measured provider usage; the UI labels them as such.
 */
export interface EcoViewMetric {
  estimatedTokensBefore: number | null
  estimatedTokensAfter: number | null
  inputBudgetTokens: number | null
  compactedResults: number
  droppedMessages: number
  degraded: boolean
  at: string | null
}
export interface StrandEcoStatus {
  enabled: boolean
  /** Runner limit seen in an overflow; the budget above is already sized against it. */
  observedContextLimitTokens: number | null
  inputBudgetTokens: number | null
  outputReserveTokens: number | null
  contextFallback: boolean
  last: EcoViewMetric | null
  /** Absent on older servers: the context-window picker is then hidden. */
  contextWindow?: EcoContextWindowStatus
}
export type EcoContextWindowState = 'unchanged' | 'applied' | 'baseline_kept' | 'provider_unsupported' | 'baseline_unknown'
  | 'supported_unknown' | 'exceeds_supported' | 'invalid_choice' | 'runner_fixed' | 'no_model'
export interface EcoContextWindowStatus {
  /** null = "Unverändert" (no num_ctx override). */
  choice: number | null
  presets: number[]
  supported: boolean
  state: EcoContextWindowState
  /** num_ctx a request would send right now (null = none; the server keeps its own window). Omitted by older servers. */
  effective?: number | null
  /** Whether the /api/show facts behind `state` are known, still being fetched, or failed. */
  facts?: 'known' | 'pending' | 'failed'
  /** Native only: window kept without override (null = unknown). Omitted by older servers. */
  baseline?: number | null
  baselineSource?: 'model_setting' | 'provider_setting' | 'modelfile' | 'runner_max' | null
}
const CW_SOURCES = ['model_setting', 'provider_setting', 'modelfile', 'runner_max'] as const
const CW_STATES: readonly EcoContextWindowState[] = ['unchanged', 'applied', 'baseline_kept', 'provider_unsupported', 'baseline_unknown', 'supported_unknown', 'exceeds_supported', 'invalid_choice', 'runner_fixed', 'no_model']
export function mapContextWindow(raw: unknown): EcoContextWindowStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  const okInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
  if (!Array.isArray(v.presets) || !v.presets.every(okInt)) return undefined
  if (typeof v.state !== 'string' || !CW_STATES.includes(v.state as EcoContextWindowState)) return undefined
  return {
    choice: okInt(v.choice) ? v.choice : null,
    presets: v.presets as number[],
    supported: v.supported === true,
    state: v.state as EcoContextWindowState,
    ...(v.effective === null || okInt(v.effective) ? { effective: v.effective as number | null } : {}),
    ...(v.facts === 'known' || v.facts === 'pending' || v.facts === 'failed' ? { facts: v.facts } : {}),
    ...(v.baseline === null || okInt(v.baseline) ? { baseline: v.baseline as number | null } : {}),
    ...(v.baselineSource === null || CW_SOURCES.includes(v.baselineSource as typeof CW_SOURCES[number])
      ? { baselineSource: v.baselineSource as EcoContextWindowStatus['baselineSource'] } : {}),
  }
}
export const STRAND_ECO_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/eco`
const CONTEXT_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/context`

/** Older servers omit `eco`: treat as "not available" (null), never as "off". */
export function mapEcoStatus(raw: unknown): StrandEcoStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.enabled !== 'boolean') return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const last = value.last && typeof value.last === 'object' ? value.last as Record<string, unknown> : null
  return {
    enabled: value.enabled,
    observedContextLimitTokens: num(value.observedContextLimitTokens),
    inputBudgetTokens: num(value.inputBudgetTokens),
    outputReserveTokens: num(value.outputReserveTokens),
    contextFallback: value.contextFallback === true,
    ...(mapContextWindow(value.contextWindow) ? { contextWindow: mapContextWindow(value.contextWindow) } : {}),
    last: last
      ? {
          estimatedTokensBefore: num(last.estimatedTokensBefore),
          estimatedTokensAfter: num(last.estimatedTokensAfter),
          inputBudgetTokens: num(last.inputBudgetTokens),
          compactedResults: num(last.compactedResults) ?? 0,
          droppedMessages: num(last.droppedMessages) ?? 0,
          degraded: last.degraded === true,
          at: typeof last.at === 'string' ? last.at : null,
        }
      : null,
  }
}

/** Rough share saved by the last Eco view, in whole percent; null when unknown. */
export function ecoSavedPercent(last: EcoViewMetric | null): number | null {
  if (!last || !last.estimatedTokensBefore || last.estimatedTokensAfter === null) return null
  const saved = 1 - last.estimatedTokensAfter / last.estimatedTokensBefore
  return saved > 0 ? Math.round(saved * 100) : 0
}

export function useStrandEcoApi() {
  const { apiFetch } = useApi()
  return {
    async get(id: string): Promise<StrandEcoStatus | null> {
      return mapEcoStatus((await apiFetch<{ eco?: unknown }>(CONTEXT_PATH(id))).eco)
    },
    async set(id: string, enabled: boolean): Promise<StrandEcoStatus | null> {
      return mapEcoStatus((await apiFetch<{ eco?: unknown }>(STRAND_ECO_PATH(id), { method: 'PATCH', body: JSON.stringify({ enabled }) })).eco)
    },
    /** Only `contextWindow` is sent, so the Eco switch is never touched. */
    async setContextWindow(id: string, contextWindow: number | null): Promise<StrandEcoStatus | null> {
      return mapEcoStatus((await apiFetch<{ eco?: unknown }>(STRAND_ECO_PATH(id), { method: 'PATCH', body: JSON.stringify({ contextWindow }) })).eco)
    },
  }
}
