/**
 * Defensive reader for the `portfolio_digest.v1` payload.
 *
 * The payload is produced by an agent from LLM and web input, so the renderer
 * treats every field as untrusted: unknown fields are ignored, missing blocks
 * become `undefined` (the renderer skips them) and a wrong type never throws.
 */
export interface DigestDelta {
  deltaEur?: number
  deltaPct?: number
}

export interface DigestOverview {
  securitiesEur?: number
  cashEur?: number
  totalEur?: number
  day?: DigestDelta
  week?: DigestDelta
  month?: DigestDelta
  ytd?: DigestDelta
}

export interface DigestIssue {
  severity?: string
  code?: string
  message?: string
  valueEur?: number
}

export interface DigestSignal {
  id?: string
  urgency?: string
  name?: string
  headline?: string
  rationale?: string
  status?: string
  firstSeen?: string
  expiresAt?: string
  trigger?: { type?: string; op?: string; value?: number }
}

export interface DigestMover {
  name?: string
  priceEur?: number
  deltaPct?: number
  impactEur?: number
  explanation?: string
}

export interface DigestPosition {
  name?: string
  weightPct?: number
  valueEur?: number
  driftPp1w?: number
}

export interface DigestCluster {
  label?: string
  weightPct?: number
  members: string[]
}

export interface DigestMacro {
  label?: string
  value?: number
  deltaPct?: number
}

export interface DigestNews {
  name?: string
  title?: string
  publisher?: string
  url?: string
  publishedAt?: string
  summary?: string
}

export interface DigestCalendarEntry {
  name?: string
  event?: string
  date?: string
  when?: string
}

export interface PortfolioDigest {
  slot?: string
  runId?: string
  asOf?: string
  marketState?: string
  overview?: DigestOverview
  digest?: string
  dataIssues: DigestIssue[]
  signals: DigestSignal[]
  gainers: DigestMover[]
  losers: DigestMover[]
  positions: DigestPosition[]
  clusters: DigestCluster[]
  macro: DigestMacro[]
  macroNote?: string
  news: DigestNews[]
  calendar: DigestCalendarEntry[]
  changesSince: string[]
  comparedToRun?: string
  footer?: { sources: string[]; positionsValid?: number; positionsTotal?: number; costEur?: number }
}

type Record_ = Record<string, unknown>

function record(value: unknown): Record_ {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : {}
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}
function strings(value: unknown): string[] {
  return list(value).filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}
function delta(value: unknown): DigestDelta | undefined {
  const source = record(value)
  const deltaEur = num(source.delta_eur)
  const deltaPct = num(source.delta_pct)
  return deltaEur === undefined && deltaPct === undefined ? undefined : { deltaEur, deltaPct }
}
function mover(value: unknown): DigestMover {
  const source = record(value)
  return {
    name: str(source.name),
    priceEur: num(source.price_eur),
    deltaPct: num(source.delta_pct),
    impactEur: num(source.impact_eur),
    explanation: str(source.explanation) ?? str(source.driver),
  }
}

export function parsePortfolioDigest(payload: unknown): PortfolioDigest {
  const source = record(payload)
  const overviewSource = record(source.overview)
  const overview: DigestOverview = {
    securitiesEur: num(overviewSource.securities_eur),
    cashEur: num(overviewSource.cash_eur),
    totalEur: num(overviewSource.total_eur),
    day: delta(overviewSource.day),
    week: delta(overviewSource.week),
    month: delta(overviewSource.month),
    ytd: delta(overviewSource.ytd),
  }
  const hasOverview = Object.values(overview).some(value => value !== undefined)
  const movers = record(source.movers)
  const allocation = record(source.allocation)
  const changes = record(source.changes_since)
  const footerSource = record(source.footer)
  const footerSources = strings(footerSource.sources)
  const footer = {
    sources: footerSources,
    positionsValid: num(footerSource.positions_valid),
    positionsTotal: num(footerSource.positions_total),
    costEur: num(footerSource.cost_eur),
  }
  const hasFooter = footerSources.length > 0 || footer.positionsValid !== undefined
    || footer.positionsTotal !== undefined || footer.costEur !== undefined

  return {
    slot: str(source.slot),
    runId: str(source.run_id),
    asOf: str(source.as_of),
    marketState: str(source.market_state),
    overview: hasOverview ? overview : undefined,
    digest: str(source.digest),
    dataIssues: list(source.data_issues).map((entry) => {
      const issue = record(entry)
      return { severity: str(issue.severity), code: str(issue.code), message: str(issue.message), valueEur: num(issue.value_eur) }
    }),
    signals: list(source.signals).map((entry) => {
      const signal = record(entry)
      const trigger = record(signal.trigger)
      return {
        id: str(signal.id),
        urgency: str(signal.urgency),
        name: str(signal.name),
        headline: str(signal.headline),
        rationale: str(signal.rationale),
        status: str(signal.status),
        firstSeen: str(signal.first_seen),
        expiresAt: str(signal.expires_at),
        trigger: Object.keys(trigger).length ? { type: str(trigger.type), op: str(trigger.op), value: num(trigger.value) } : undefined,
      }
    }),
    gainers: list(movers.gainers).map(mover),
    losers: list(movers.losers).map(mover),
    positions: list(allocation.positions).map((entry) => {
      const position = record(entry)
      return { name: str(position.name), weightPct: num(position.weight_pct), valueEur: num(position.value_eur), driftPp1w: num(position.drift_pp_1w) }
    }),
    clusters: list(allocation.clusters).map((entry) => {
      const cluster = record(entry)
      return { label: str(cluster.label), weightPct: num(cluster.weight_pct), members: strings(cluster.members) }
    }),
    macro: list(source.macro).map((entry) => {
      const macro = record(entry)
      return { label: str(macro.label), value: num(macro.value), deltaPct: num(macro.delta_pct) }
    }),
    macroNote: str(source.macro_note),
    news: list(source.news).map((entry) => {
      const news = record(entry)
      return {
        name: str(news.name),
        title: str(news.title),
        publisher: str(news.publisher),
        url: str(news.url),
        publishedAt: str(news.published_at),
        summary: str(news.summary_de) ?? str(news.summary),
      }
    }),
    calendar: list(source.calendar).map((entry) => {
      const event = record(entry)
      return { name: str(event.name), event: str(event.event), date: str(event.date), when: str(event.when) }
    }),
    changesSince: strings(changes.items),
    comparedToRun: str(changes.compared_to_run),
    footer: hasFooter ? footer : undefined,
  }
}

/** Urgency → emoji, unknown urgencies stay neutral instead of disappearing. */
const URGENCY_ICONS: Record<string, string> = {
  buy: '🟢',
  add: '➕',
  trim: '✂️',
  sell: '🔴',
  hedge: '🛡',
  watch: '👀',
  idea: '💡',
  urgent: '🔥',
}

export function urgencyIcon(urgency: string | undefined): string {
  return (urgency && URGENCY_ICONS[urgency]) || '•'
}
