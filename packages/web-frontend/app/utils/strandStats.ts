/**
 * Strand statistics (`GET /api/strands/:id/stats`, schema strand_stats.v1):
 * path, the subset of the payload the panel renders, and pure formatters.
 */
export const STRAND_STATS_PATH = (id: string, include: string[] = ['tasks', 'series']) =>
  `/api/strands/${encodeURIComponent(id)}/stats${include.length ? `?include=${include.join(',')}` : ''}`

export type Billing = 'subscription' | 'metered' | 'local'

export interface StatsBucket { requests: number; uncached: number; cacheRead: number; cacheWrite: number; out: number; in: number; cacheHitRatio: number | null; costUsd: number }
export interface StatsPart { runs: number; durationSec: number; tokensIn: number; tokensOut: number; costUsd: number }

export interface StrandStatsView {
  schema: 'strand_stats.v1'
  strandId: string
  persona: string
  contextWindow: number | null
  span: { firstAt: string; lastAt: string; wallSec: number }
  prompts: { total: number; typed: number; voice: number; answers: number }
  turns: { user: number; auto: number; source: 'recorded' | 'estimated' | 'mixed' }
  tokens: { main: StatsBucket; tasks: StatsBucket; voice: StatsBucket; total: StatsBucket }
  cost: { totalUsd: number; subscriptionUsd: number; meteredUsd: number; localUsd: number; subscriptionShare: number | null }
  models: Array<{ provider: string; model: string; billing: Billing; requests: number; tokensIn: number; tokensOut: number; cacheHitRatio: number | null; costUsd: number }>
  local: { requests: number; requestShare: number; tokenShare: number }
  personas: Array<StatsPart & { id: string; isStrandPersona: boolean; ok: number; failed: number; running: number; successRatio: number | null; models: string[]; split: { chat: StatsPart; tasks: StatsPart } | null }>
  tools: { main: number; total: number; errors: number; distinct: number; top: Array<{ name: string; calls: number; callsMain: number; errors: number; avgMs: number }> }
  taskCount: number
  taskStatus: { completed: number; failed: number; running: number; paused: number }
  nestedTasks: number
  delegations: { task: number; askAgent: number }
  autarky: { agentSec: number; effortSec: number; mainSec: number; tasksSec: number; longestSec: number; perPromptSec: number | null; latencyMedianSec: number | null; parallelPeak: number; wallSec: number; estimated: boolean }
  compaction: { summaries: number; trimmedTurns: number; trimmedMessages: number; lastKeptTokens: number | null; budgetTokens: number | null }
  failedRequests: number
  tasks?: Array<{ id: string; name: string; persona: string; model: string | null; status: string; depth: number; startedAt: string; endedAt: string | null; durationSec: number; costUsd: number; toolCalls: number; toolErrors: number }>
  series?: Array<{ at: string; kind: 'user' | 'task_result' | 'system'; maxRequestTokens: number; out: number; requests: number; durationSec: number }>
}

export function isStrandStats(raw: unknown): raw is StrandStatsView {
  return typeof raw === 'object' && raw !== null && (raw as { schema?: unknown }).schema === 'strand_stats.v1'
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function compactNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}G`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e4) return `${Math.round(n / 1e3)}k`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** Seconds → "42 s", "7 min", "3 h 46 min". */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–'
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

export function formatUsd(v: number | null | undefined, locale = 'de'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–'
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', maximumFractionDigits: v < 10 ? 2 : 0 }).format(v)
}

export function percent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–'
  return `${Math.round(ratio * 100)} %`
}

/** Short model label: provider prefixes and date suffixes dropped. */
export function shortModel(model: string | null | undefined): string {
  if (!model) return '–'
  return model.replace(/^.*\//, '').replace(/-\d{8}$/, '')
}

/** Polyline points for the per-turn sparkline (viewBox 0 0 w h). */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length === 0) return ''
  const max = Math.max(...values, 1)
  const step = values.length > 1 ? w / (values.length - 1) : 0
  return values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ')
}
