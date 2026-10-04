/**
 * Eco mode of one strand (plan 2026-10-04-eco-implementation).
 *
 *   GET   /api/strands/:id/context  -> report.eco (status + last view estimates)
 *   PATCH /api/strands/:id/eco      { enabled: boolean } -> { strandId, eco }
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
  inputBudgetTokens: number | null
  outputReserveTokens: number | null
  contextFallback: boolean
  last: EcoViewMetric | null
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
    inputBudgetTokens: num(value.inputBudgetTokens),
    outputReserveTokens: num(value.outputReserveTokens),
    contextFallback: value.contextFallback === true,
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
  }
}
