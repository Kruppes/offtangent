/**
 * Defensive reader for news digest payloads. One model, two wire formats:
 * `news_digest.v2` (current contract) and `news_digest.v1` (older revisions of
 * the same board), see `docs/reference/boards-api.md`.
 *
 * The payload is written by an agent from web input, so the renderer treats
 * every field as untrusted:
 *
 *  - a broken item is skipped, never thrown on: one bad story must not take
 *    the whole digest down,
 *  - only `https://` URLs survive as links; anything else is dropped to plain
 *    text (the backend already rejects them, but an older revision may carry
 *    one, and a link is the one thing a user taps blindly),
 *  - nothing is ever shortened, summarised or substituted: a v1 item has no
 *    `take`, so the take line is simply absent — never a trimmed `summary`,
 *  - unknown `category` / `verdict` / source `type` / `action.kind` values are
 *    kept verbatim so the UI can show them neutrally,
 *  - `null` is returned when nothing is renderable, which makes the board page
 *    fall back to the generic renderer instead of showing an empty shell.
 */
export const NEWS_DIGEST_V1_KIND = 'news_digest.v1'
export const NEWS_DIGEST_V2_KIND = 'news_digest.v2'

/** Source types that count as firsthand ("Erstquelle") per the contract. */
export const FIRSTHAND_SOURCE_TYPES = ['primary', 'release', 'paper'] as const

export interface NewsSource {
  name: string
  /** Only set when it is an `https://` URL; otherwise the name stays text. */
  url?: string
  type?: string
  /** primary | release | paper — the story's own voice, not a report about it. */
  firsthand: boolean
  /** Raw `published_at` as delivered (v2 only, optional). */
  publishedAt?: string
  /** Parsed `published_at` for sorting; undefined when unparsable. */
  publishedAtMs?: number
  /** Host of `url`, for the "Primary · example.com · 01 Sep" line. */
  host?: string
}

export interface NewsAction {
  kind?: string
  text?: string
}

export interface NewsStory {
  /** `story_id` (v2) or `id` (v1): stable across revisions, key of the read state. */
  storyId: string
  rank?: number
  /** Two digits, tabular: "02". Empty when the payload has no rank. */
  rankLabel: string
  status: 'new' | 'update'
  /** What is new about a returning story (v2, required there for updates). */
  delta?: string
  title: string
  /** One sentence verdict. v2 only — a v1 story has none and shows none. */
  take?: string
  /** Raw category id. */
  category?: string
  /** Display label: payload `categories` map, v1 fallback map, else the raw id. */
  categoryLabel?: string
  verdict?: string
  summary?: string
  critique?: string
  relevance?: string
  action?: NewsAction
  /** Firsthand sources first, then by publication date ascending. */
  sources: NewsSource[]
  /** `source_count` when given and plausible, otherwise the number of sources. */
  sourceCount: number
  firsthandCount: number
}

export interface NewsQuickHit {
  title: string
  url?: string
  source?: string
  note?: string
}

export interface NewsDigest {
  /** Which wire format this revision used. */
  schemaVersion: typeof NEWS_DIGEST_V1_KIND | typeof NEWS_DIGEST_V2_KIND
  date?: string
  generatedAt?: string
  headline?: string
  items: NewsStory[]
  quickHits: NewsQuickHit[]
  sourcesChecked?: number
  candidates?: number
  sourcesFailed: string[]
  /** Items with verdict `hot` — drives the counter line and signal discipline. */
  hotCount: number
}

type Record_ = Record<string, unknown>

function record(value: unknown): Record_ {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record_ : {}
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A link is rendered only for `https://`. No http, no javascript:, no data:. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Host without `www.`, for the source meta line. Never the full URL. */
export function sourceHost(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function parseSource(value: unknown): NewsSource | null {
  const source = record(value)
  const name = str(source.name)
  const url = isHttpsUrl(source.url) ? source.url : undefined
  if (!name && !url) return null
  const type = str(source.type)
  const publishedAt = str(source.published_at)
  const stamp = publishedAt ? Date.parse(publishedAt) : Number.NaN
  return {
    name: name ?? url ?? '',
    url,
    type,
    firsthand: type !== undefined && (FIRSTHAND_SOURCE_TYPES as readonly string[]).includes(type),
    publishedAt,
    publishedAtMs: Number.isNaN(stamp) ? undefined : stamp,
    host: sourceHost(url),
  }
}

/**
 * Detail order per the design: firsthand first, inside a group by publication
 * date ascending, undated last, payload order as the tie break.
 */
function orderSources(sources: NewsSource[]): NewsSource[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      if (a.source.firsthand !== b.source.firsthand) return a.source.firsthand ? -1 : 1
      const left = a.source.publishedAtMs ?? Number.MAX_SAFE_INTEGER
      const right = b.source.publishedAtMs ?? Number.MAX_SAFE_INTEGER
      return left - right || a.index - b.index
    })
    .map(entry => entry.source)
}

/** Category labels of the v1 payloads, which shipped ids without labels. */
const V1_CATEGORY_LABELS: Record<string, string> = {
  frontier: 'Frontier',
  open_weights: 'Open weights',
  tts_stt: 'Speech',
  agentic_coding: 'Agentic coding',
  video: 'Video',
  image: 'Image',
  tooling: 'Tooling',
  skills_loops: 'Skills & loops',
  hardware: 'Hardware',
  research: 'Research',
  policy: 'Policy',
  other: 'Other',
}

function parseItem(value: unknown, index: number, categories: Record<string, string>): NewsStory | null {
  const item = record(value)
  const title = str(item.title)
  // The title is the one thing a list row cannot be built without.
  if (!title) return null

  const sources = orderSources(
    list(item.sources).map(parseSource).filter((entry): entry is NewsSource => entry !== null),
  )
  const actionSource = record(item.action)
  const actionKind = str(actionSource.kind)
  const actionText = str(actionSource.text)
  const declared = num(item.source_count)
  const rank = num(item.rank)
  const category = str(item.category)
  const status = str(item.status)

  return {
    storyId: str(item.story_id) ?? str(item.id) ?? `item-${index}`,
    rank,
    rankLabel: rank === undefined ? '' : String(Math.trunc(rank)).padStart(2, '0'),
    status: status === 'update' || item.is_update === true ? 'update' : 'new',
    delta: str(item.delta),
    title,
    take: str(item.take),
    category,
    categoryLabel: category ? categories[category] ?? V1_CATEGORY_LABELS[category] ?? category : undefined,
    verdict: str(item.verdict),
    summary: str(item.summary),
    critique: str(item.critique),
    relevance: str(item.relevance),
    action: actionKind || actionText ? { kind: actionKind, text: actionText } : undefined,
    sources,
    sourceCount: declared !== undefined && declared >= sources.length ? declared : sources.length,
    firsthandCount: sources.filter(source => source.firsthand).length,
  }
}

function parseQuickHit(value: unknown): NewsQuickHit | null {
  const hit = record(value)
  const title = str(hit.title)
  if (!title) return null
  return {
    title,
    url: isHttpsUrl(hit.url) ? hit.url : undefined,
    source: str(hit.source),
    note: str(hit.note),
  }
}

/** Payload `categories`, keeping only string labels. */
function parseCategories(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [id, label] of Object.entries(record(value))) {
    const text = str(label)
    if (text) out[id] = text
  }
  return out
}

/**
 * Read a payload of either version into the shape the renderer needs, or
 * `null` when there is nothing to show (no headline and no usable item) so the
 * caller can fall back to the generic board.
 */
export function parseNewsDigest(payload: unknown): NewsDigest | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const source = record(payload)
  const categories = parseCategories(source.categories)

  const items = list(source.items)
    .map((entry, index) => parseItem(entry, index, categories))
    .filter((entry): entry is NewsStory => entry !== null)
  // Stable: items keep their payload order, ranked ones come first in rank order.
  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.rank ?? Number.MAX_SAFE_INTEGER) - (b.item.rank ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(entry => entry.item)

  const headline = str(source.headline)
  const quickHits = list(source.quick_hits).map(parseQuickHit).filter((hit): hit is NewsQuickHit => hit !== null)
  if (!headline && ordered.length === 0) return null

  const stats = record(source.stats)
  const declaredVersion = str(source.schema_version)
  // A v1 revision has no `take` and no `story_id`; either marker is enough.
  const looksV2 = ordered.some(item => item.take !== undefined)
    || list(source.items).some(entry => str(record(entry).story_id) !== undefined)

  return {
    schemaVersion: declaredVersion === NEWS_DIGEST_V1_KIND
      ? NEWS_DIGEST_V1_KIND
      : declaredVersion === NEWS_DIGEST_V2_KIND || looksV2 ? NEWS_DIGEST_V2_KIND : NEWS_DIGEST_V1_KIND,
    date: str(source.date),
    generatedAt: str(source.generated_at),
    headline,
    items: ordered,
    quickHits,
    sourcesChecked: num(stats.sources_checked),
    candidates: num(stats.candidates),
    sourcesFailed: list(stats.sources_failed).map(str).filter((name): name is string => name !== undefined),
    hotCount: ordered.filter(item => item.verdict === 'hot').length,
  }
}

const SOURCE_TYPE_KEYS = new Set(['primary', 'release', 'paper', 'press', 'community', 'aggregator'])

export function sourceTypeLabelKey(type: string | undefined): string | null {
  return type && SOURCE_TYPE_KEYS.has(type) ? `boards.news.sourceType.${type}` : null
}

const ACTION_KEYS = new Set(['try', 'bench', 'watch', 'skip'])

export function actionLabelKey(kind: string | undefined): string | null {
  return kind && ACTION_KEYS.has(kind) ? `boards.news.action.${kind}` : null
}

const VERDICT_KEYS = new Set(['hot', 'relevant', 'watch', 'hype'])

export function verdictLabelKey(verdict: string | undefined): string | null {
  return verdict && VERDICT_KEYS.has(verdict) ? `boards.news.verdict.${verdict}` : null
}

/**
 * The verdict pill works without colour: four different shapes, from filled
 * signal down to no surface at all. Colours are the seven mapped shell roles,
 * never a literal.
 */
export type VerdictShape = 'filled-signal' | 'filled-raised' | 'outlined' | 'bare'

export function verdictShape(verdict: string | undefined): VerdictShape {
  if (verdict === 'hot') return 'filled-signal'
  if (verdict === 'relevant') return 'filled-raised'
  if (verdict === 'watch') return 'outlined'
  // `hype` and anything unknown: no surface, no border, muted text.
  return 'bare'
}

/**
 * Key of the local read state: the story plus its last change.
 *
 * A story is remembered per `story_id` as long as it does not change. Comes it
 * back as `status: update` with a `delta`, that is a new state of the story and
 * the reader has not seen it yet — so the key changes with the delta and the
 * row is unread again. The plain `story_id` stays the key of the `new` state,
 * which is exactly what older entries in `boards.news.read` contain: they keep
 * working without a migration step.
 */
export function storyReadKey(story: Pick<NewsStory, 'storyId' | 'status' | 'delta'>): string {
  if (story.status !== 'update') return story.storyId
  const delta = story.delta?.trim()
  // An update without a delta has no change state to fingerprint; `update` is
  // one state then, distinct from the `new` state of the same story.
  return `${story.storyId}@${delta ? fingerprint(delta) : 'update'}`
}

/** FNV-1a (32 bit) in base 36: short, stable, no crypto needed for a cache key. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
