/**
 * Context gauge of a strand (W4b, N2 / review must 1).
 *
 * Source is `GET /api/strands/:id/context` (backend
 * `api/modules/strands/service.ts` `StrandContextReport`, the same endpoint
 * the companion app reads): what the LAST model request of this strand
 * carried, divided by the window of the model the next turn uses. Anything
 * the server could not derive is null and is drawn as a dash, never as 0.
 */

export const CAUTION_RATIO = 0.7
export const FULL_RATIO = 0.9

export interface StrandContextView {
  measured: boolean
  requestTokens: number | null
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  contextWindow: number | null
  outputCapTokens: number | null
  measuredAt: string | null
  measuredModelId: string | null
  /** Measured on another model than the next turn's: percentage refers to a foreign window. */
  stale: boolean
  estimated: boolean
  transcriptTokens: number | null
  transcriptBudget: number | null
  lastCompaction: { at: string; droppedMessages: number } | null
  modelLabel: string | null
  /** requestTokens / contextWindow, null when either is unknown. */
  ratio: number | null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

/** Tolerant mapping of the report: unknown or missing fields become null. */
export function mapContextReport(raw: unknown): StrandContextView {
  const root = obj(raw)
  const m = obj(root.measurement)
  const b = obj(root.budget)
  const t = obj(root.transcript)
  const model = obj(root.model)
  const compaction = obj(root.lastCompaction)
  const measured = m.state === 'measured'
  const requestTokens = measured ? num(m.requestTokens) : null
  const contextWindow = num(b.contextWindow)
  const ratio = requestTokens !== null && contextWindow ? requestTokens / contextWindow : null
  const transcriptKnown = t.state === 'measured'
  return {
    measured,
    requestTokens,
    inputTokens: measured ? num(m.inputTokens) : null,
    cacheReadTokens: measured ? num(m.cacheReadTokens) : null,
    cacheWriteTokens: measured ? num(m.cacheWriteTokens) : null,
    outputTokens: measured ? num(m.outputTokens) : null,
    contextWindow,
    outputCapTokens: num(b.outputCapTokens),
    measuredAt: measured ? str(m.measuredAt) : null,
    measuredModelId: measured ? str(m.measuredModelId) : null,
    stale: m.stale === true,
    estimated: m.estimated === true,
    transcriptTokens: transcriptKnown ? num(t.estimatedTokens) : null,
    transcriptBudget: transcriptKnown ? num(t.budgetTokens) : null,
    lastCompaction: str(compaction.at) ? { at: compaction.at as string, droppedMessages: num(compaction.droppedMessages) ?? 0 } : null,
    modelLabel: str(model.displayName) ?? str(model.modelId),
    ratio,
  }
}

export type GaugeBand = 'unknown' | 'ok' | 'caution' | 'full'

export function gaugeBand(ratio: number | null): GaugeBand {
  if (ratio === null) return 'unknown'
  if (ratio >= FULL_RATIO) return 'full'
  if (ratio >= CAUTION_RATIO) return 'caution'
  return 'ok'
}

/** Whole percent for display; above 100 stays visible as such (overflow is real). */
export function gaugePercent(ratio: number | null): number | null {
  return ratio === null ? null : Math.round(ratio * 100)
}

/** `950`, `12.3k`, `200k`, `1.2M` — compact token counts; null is a dash. */
export function formatTokens(value: number | null): string {
  if (value === null) return '–'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = value / 1000
    return `${k < 100 ? Number(k.toFixed(1)) : Math.round(k)}k`
  }
  const mio = value / 1_000_000
  return `${Number(mio.toFixed(mio < 10 ? 1 : 0))}M`
}

/**
 * Geometry of the ring, all as fractions of the circumference. The arc is
 * drawn clockwise from 12 o'clock. The 70 % and 90 % thresholds are tick
 * marks on the track (form, not only colour), and from 70 % on the fill is
 * split into a caution segment so the crossing is visible without colour.
 */
export interface RingGeometry {
  /** Fill up to the 70 % mark (or the whole fill below it). */
  base: number
  /** Fill beyond the 70 % mark, 0 below it. */
  over: number
  ticks: number[]
  band: GaugeBand
}

export function ringGeometry(ratio: number | null): RingGeometry {
  const band = gaugeBand(ratio)
  const clamped = ratio === null ? 0 : Math.min(1, Math.max(0, ratio))
  const base = Math.min(clamped, CAUTION_RATIO)
  const over = Math.max(0, clamped - CAUTION_RATIO)
  return { base, over, ticks: [CAUTION_RATIO, FULL_RATIO], band }
}

/** stroke-dasharray / -dashoffset for an arc from `start` of `length` (fractions). */
export function arcDash(circumference: number, start: number, length: number): { dasharray: string; dashoffset: number } {
  const visible = Math.max(0, Math.min(1, length)) * circumference
  return { dasharray: `${visible} ${circumference}`, dashoffset: -Math.max(0, start) * circumference }
}

/** End point of a tick at `fraction` on a circle (12 o'clock, clockwise). */
export function tickPoint(cx: number, cy: number, radius: number, fraction: number): { x: number; y: number } {
  const angle = fraction * 2 * Math.PI - Math.PI / 2
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
}
