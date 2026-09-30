/**
 * `news_digest.v1` — a daily news digest board: one card per story, every
 * story carrying its own set of clickable sources.
 *
 * The producer (a skill with its own strict validator) is the instance that
 * enforces style, length and ranking rules. This file is the backend gate and
 * it only ever REJECTS a payload that no client could render sensibly; it
 * never rewrites one, never trims a string and never fills in a default.
 * Everything a renderer can degrade gracefully on — an unknown `category`, an
 * unknown source `type`, an unknown `action.kind`, an extra field — passes.
 *
 *   {
 *     "schema_version": "news_digest.v1",  // optional, must match when present
 *     "date": "2026-09-28",
 *     "headline": "…",                      // required, non-empty
 *     "items": [ {                          // required, 1…20
 *       "id": "slug", "rank": 1, "title": "…", "summary": "…",
 *       "verdict": "hot|relevant|watch|hype",
 *       "sources": [{ "name": "…", "url": "https://…", "type": "primary" }]
 *     } ],
 *     "quick_hits": [{ "title": "…", "url": "https://…" }],  // optional, ≤ 20
 *     "stats": { "sources_checked": 31 }
 *   }
 *
 * Length caps are deliberately about twice the producer's own limits: a digest
 * that is slightly too wordy should reach the user, only an abusive payload is
 * refused. See `docs/reference/boards-api.md#news_digestv1`.
 */

export const NEWS_DIGEST_KIND = 'news_digest.v1'

/** Items per digest. One story is the minimum; 20 is a long scroll already. */
export const NEWS_DIGEST_MAX_ITEMS = 20
export const NEWS_DIGEST_MAX_QUICK_HITS = 20
export const NEWS_DIGEST_MAX_SOURCES = 20
export const NEWS_DIGEST_MAX_TAGS = 12

/** Generous string caps (~2× the producer contract), measured in characters. */
export const NEWS_DIGEST_HEADLINE_MAX = 440
export const NEWS_DIGEST_TITLE_MAX = 280
export const NEWS_DIGEST_TEXT_MAX = 1400
export const NEWS_DIGEST_RELEVANCE_MAX = 900
export const NEWS_DIGEST_ACTION_TEXT_MAX = 440
export const NEWS_DIGEST_NAME_MAX = 120
export const NEWS_DIGEST_NOTE_MAX = 360
export const NEWS_DIGEST_URL_MAX = 2048

/** The four verdicts a renderer has a badge for. Anything else is rejected. */
export const NEWS_DIGEST_VERDICTS = ['hot', 'relevant', 'watch', 'hype'] as const
export type NewsDigestVerdict = (typeof NEWS_DIGEST_VERDICTS)[number]

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Non-empty after trimming and within the cap, else the reason. */
function checkString(value: unknown, path: string, max: number, required: boolean): string | null {
  if (value === undefined || value === null) {
    return required ? `payload.${path} is required and must be a non-empty string` : null
  }
  if (typeof value !== 'string') return `payload.${path} must be a string`
  if (required && value.trim().length === 0) {
    return `payload.${path} is required and must be a non-empty string`
  }
  if (value.length > max) return `payload.${path} must be at most ${max} characters (got ${value.length})`
  return null
}

/**
 * Only `https://` is accepted. A digest is a list of links a user taps on a
 * phone: `http://` would be a downgrade the user cannot see beforehand, and
 * `javascript:`/`data:` are not links at all.
 */
function checkUrl(value: unknown, path: string): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `payload.${path} is required and must be an https:// URL`
  }
  if (value.length > NEWS_DIGEST_URL_MAX) {
    return `payload.${path} must be at most ${NEWS_DIGEST_URL_MAX} characters (got ${value.length})`
  }
  if (!value.startsWith('https://')) {
    return `payload.${path} must start with "https://" (got ${JSON.stringify(value.slice(0, 32))})`
  }
  return null
}

function checkSources(raw: unknown, itemPath: string): string | null {
  if (!Array.isArray(raw)) return `payload.${itemPath}.sources must be an array`
  if (raw.length < 1 || raw.length > NEWS_DIGEST_MAX_SOURCES) {
    return `payload.${itemPath}.sources must have between 1 and ${NEWS_DIGEST_MAX_SOURCES} entries (got ${raw.length})`
  }
  for (const [index, entry] of raw.entries()) {
    const path = `${itemPath}.sources[${index}]`
    if (!isPlainObject(entry)) return `payload.${path} must be an object`
    const name = checkString(entry.name, `${path}.name`, NEWS_DIGEST_NAME_MAX, true)
    if (name) return name
    const url = checkUrl(entry.url, `${path}.url`)
    if (url) return url
    // `type` stays free text on purpose: a new source class must not break a
    // digest. The client shows an unknown type as the raw value.
    const type = checkString(entry.type, `${path}.type`, NEWS_DIGEST_NAME_MAX, false)
    if (type) return type
  }
  return null
}

function checkItem(raw: unknown, index: number): string | null {
  const path = `items[${index}]`
  if (!isPlainObject(raw)) return `payload.${path} must be an object`

  for (const [field, max] of [['id', NEWS_DIGEST_NAME_MAX], ['title', NEWS_DIGEST_TITLE_MAX]] as const) {
    const problem = checkString(raw[field], `${path}.${field}`, max, true)
    if (problem) return problem
  }
  const summary = checkString(raw.summary, `${path}.summary`, NEWS_DIGEST_TEXT_MAX, true)
  if (summary) return summary

  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !(NEWS_DIGEST_VERDICTS as readonly string[]).includes(verdict)) {
    return `payload.${path}.verdict must be one of ${NEWS_DIGEST_VERDICTS.join(', ')}`
  }

  // Optional prose. Unknown `category` values are allowed (forward compatible).
  for (const [field, max] of [
    ['critique', NEWS_DIGEST_TEXT_MAX],
    ['relevance', NEWS_DIGEST_RELEVANCE_MAX],
    ['category', NEWS_DIGEST_NAME_MAX],
    ['no_primary_reason', NEWS_DIGEST_NOTE_MAX],
  ] as const) {
    const problem = checkString(raw[field], `${path}.${field}`, max, false)
    if (problem) return problem
  }

  if (raw.rank !== undefined && raw.rank !== null
    && (typeof raw.rank !== 'number' || !Number.isFinite(raw.rank))) {
    return `payload.${path}.rank must be a finite number`
  }
  if (raw.score !== undefined && raw.score !== null
    && (typeof raw.score !== 'number' || !Number.isFinite(raw.score))) {
    return `payload.${path}.score must be a finite number`
  }
  if (raw.is_update !== undefined && raw.is_update !== null && typeof raw.is_update !== 'boolean') {
    return `payload.${path}.is_update must be a boolean`
  }

  if (raw.action !== undefined && raw.action !== null) {
    if (!isPlainObject(raw.action)) return `payload.${path}.action must be an object`
    // `action.kind` is free text as well: a new next-step verb renders neutrally.
    const kind = checkString(raw.action.kind, `${path}.action.kind`, NEWS_DIGEST_NAME_MAX, false)
    if (kind) return kind
    const text = checkString(raw.action.text, `${path}.action.text`, NEWS_DIGEST_ACTION_TEXT_MAX, false)
    if (text) return text
  }

  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) return `payload.${path}.tags must be an array of strings`
    if (raw.tags.length > NEWS_DIGEST_MAX_TAGS) {
      return `payload.${path}.tags must have at most ${NEWS_DIGEST_MAX_TAGS} entries (got ${raw.tags.length})`
    }
    for (const [tagIndex, tag] of raw.tags.entries()) {
      const problem = checkString(tag, `${path}.tags[${tagIndex}]`, NEWS_DIGEST_NAME_MAX, false)
      if (problem) return problem
      if (typeof tag !== 'string') return `payload.${path}.tags[${tagIndex}] must be a string`
    }
  }

  return checkSources(raw.sources, path)
}

function checkQuickHits(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'payload.quick_hits must be an array'
  if (raw.length > NEWS_DIGEST_MAX_QUICK_HITS) {
    return `payload.quick_hits must have at most ${NEWS_DIGEST_MAX_QUICK_HITS} entries (got ${raw.length})`
  }
  for (const [index, entry] of raw.entries()) {
    const path = `quick_hits[${index}]`
    if (!isPlainObject(entry)) return `payload.${path} must be an object`
    const title = checkString(entry.title, `${path}.title`, NEWS_DIGEST_TITLE_MAX, true)
    if (title) return title
    const url = checkUrl(entry.url, `${path}.url`)
    if (url) return url
    for (const [field, max] of [['source', NEWS_DIGEST_NAME_MAX], ['note', NEWS_DIGEST_NOTE_MAX]] as const) {
      const problem = checkString(entry[field], `${path}.${field}`, max, false)
      if (problem) return problem
    }
  }
  return null
}

/**
 * Reject a `news_digest.v1` payload that cannot be rendered. Returns null when
 * the payload is acceptable, otherwise the reason — same shape as
 * `validatePortfolioDigestPayload` and `validateHtmlViewPayload`, so the tool
 * reports one kind of error.
 */
export function validateNewsDigestPayload(payload: Record<string, unknown>): string | null {
  const version = payload.schema_version
  if (version !== undefined && version !== null && version !== NEWS_DIGEST_KIND) {
    return `payload.schema_version must be "${NEWS_DIGEST_KIND}" when present`
  }

  const headline = checkString(payload.headline, 'headline', NEWS_DIGEST_HEADLINE_MAX, true)
  if (headline) return headline

  const date = checkString(payload.date, 'date', NEWS_DIGEST_NAME_MAX, false)
  if (date) return date
  const generatedAt = checkString(payload.generated_at, 'generated_at', NEWS_DIGEST_NAME_MAX, false)
  if (generatedAt) return generatedAt

  const items = payload.items
  if (!Array.isArray(items)) return 'payload.items is required and must be an array'
  if (items.length < 1 || items.length > NEWS_DIGEST_MAX_ITEMS) {
    return `payload.items must have between 1 and ${NEWS_DIGEST_MAX_ITEMS} entries (got ${items.length})`
  }
  for (const [index, item] of items.entries()) {
    const problem = checkItem(item, index)
    if (problem) return problem
  }

  if (payload.quick_hits !== undefined && payload.quick_hits !== null) {
    const problem = checkQuickHits(payload.quick_hits)
    if (problem) return problem
  }

  if (payload.stats !== undefined && payload.stats !== null) {
    const stats = payload.stats
    if (!isPlainObject(stats)) return 'payload.stats must be an object'
    for (const field of ['sources_checked', 'candidates', 'clusters'] as const) {
      const value = stats[field]
      if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
        return `payload.stats.${field} must be a finite number`
      }
    }
    const failed = stats.sources_failed
    if (failed !== undefined && failed !== null) {
      if (!Array.isArray(failed)) return 'payload.stats.sources_failed must be an array of strings'
      for (const [index, entry] of failed.entries()) {
        if (typeof entry !== 'string') return `payload.stats.sources_failed[${index}] must be a string`
        if (entry.length > NEWS_DIGEST_NAME_MAX) {
          return `payload.stats.sources_failed[${index}] must be at most ${NEWS_DIGEST_NAME_MAX} characters`
        }
      }
    }
  }

  return null
}

/* ───────────────────────── news_digest.v2 ─────────────────────────────── */

/**
 * `news_digest.v2` — the current contract. Same idea as v1, but a story now
 * carries a stable `story_id` across revisions, a one sentence verdict (`take`)
 * that the list itself shows, an explicit `status`/`delta` pair for a story
 * that comes back with something new, and a `categories` map that ships the
 * display label with the payload, so a renderer needs no topic knowledge.
 *
 *   {
 *     "schema_version": "news_digest.v2",   // optional, must match when present
 *     "date": "2026-09-28", "headline": "…",
 *     "categories": { "tts_stt": "Speech" },        // optional, id → label
 *     "items": [ {
 *       "story_id": "slug", "rank": 1, "status": "new|update", "delta": "…",
 *       "title": "…", "take": "…", "summary": "…",
 *       "verdict": "hot|relevant|watch|hype",
 *       "sources": [{ "name": "…", "url": "https://…", "type": "primary",
 *                     "published_at": "2026-09-01" }]
 *     } ],
 *     "quick_hits": […], "stats": { "sources_checked": 31 }
 *   }
 *
 * Caps are again ~2× the producer's own limits (headline 120 → 240, title 90 →
 * 180, take 140 → 280, summary 420 → 840, critique 480 → 960, relevance 240 →
 * 480). Deliberately NOT rejected, because every client degrades on it: an
 * unknown `category` (shown as the raw value), an unknown source `type` or
 * `action.kind`, a `status: "update"` without `delta` (the "what's new" section
 * is simply left out), extra fields.
 * See `docs/reference/boards-api.md#news_digestv2`.
 */
export const NEWS_DIGEST_V2_KIND = 'news_digest.v2'

/** Generous caps for v2 (~2× the producer contract), in characters. */
export const NEWS_DIGEST_V2_HEADLINE_MAX = 240
export const NEWS_DIGEST_V2_TITLE_MAX = 180
export const NEWS_DIGEST_V2_TAKE_MAX = 280
export const NEWS_DIGEST_V2_SUMMARY_MAX = 840
export const NEWS_DIGEST_V2_CRITIQUE_MAX = 960
export const NEWS_DIGEST_V2_RELEVANCE_MAX = 480
export const NEWS_DIGEST_V2_DELTA_MAX = 280
export const NEWS_DIGEST_V2_ACTION_TEXT_MAX = 320
export const NEWS_DIGEST_V2_QUICK_HIT_TITLE_MAX = 200

/** A story is either new today or a known story with something new. */
export const NEWS_DIGEST_STATUSES = ['new', 'update'] as const
export type NewsDigestStatus = (typeof NEWS_DIGEST_STATUSES)[number]

function checkItemV2(raw: unknown, index: number): string | null {
  const path = `items[${index}]`
  if (!isPlainObject(raw)) return `payload.${path} must be an object`

  // The four strings without which no renderer has a list row or a detail view.
  for (const [field, max] of [
    ['story_id', NEWS_DIGEST_NAME_MAX],
    ['title', NEWS_DIGEST_V2_TITLE_MAX],
    ['take', NEWS_DIGEST_V2_TAKE_MAX],
    ['summary', NEWS_DIGEST_V2_SUMMARY_MAX],
  ] as const) {
    const problem = checkString(raw[field], `${path}.${field}`, max, true)
    if (problem) return problem
  }

  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !(NEWS_DIGEST_VERDICTS as readonly string[]).includes(verdict)) {
    return `payload.${path}.verdict must be one of ${NEWS_DIGEST_VERDICTS.join(', ')}`
  }

  const status = raw.status
  if (status !== undefined && status !== null
    && (typeof status !== 'string' || !(NEWS_DIGEST_STATUSES as readonly string[]).includes(status))) {
    return `payload.${path}.status must be one of ${NEWS_DIGEST_STATUSES.join(', ')}`
  }

  for (const [field, max] of [
    ['delta', NEWS_DIGEST_V2_DELTA_MAX],
    ['critique', NEWS_DIGEST_V2_CRITIQUE_MAX],
    ['relevance', NEWS_DIGEST_V2_RELEVANCE_MAX],
    ['category', NEWS_DIGEST_NAME_MAX],
  ] as const) {
    const problem = checkString(raw[field], `${path}.${field}`, max, false)
    if (problem) return problem
  }

  for (const field of ['rank', 'score', 'source_count'] as const) {
    const value = raw[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `payload.${path}.${field} must be a finite number`
    }
  }

  if (raw.action !== undefined && raw.action !== null) {
    if (!isPlainObject(raw.action)) return `payload.${path}.action must be an object`
    const kind = checkString(raw.action.kind, `${path}.action.kind`, NEWS_DIGEST_NAME_MAX, false)
    if (kind) return kind
    const text = checkString(raw.action.text, `${path}.action.text`, NEWS_DIGEST_V2_ACTION_TEXT_MAX, false)
    if (text) return text
  }

  if (raw.tags !== undefined && raw.tags !== null) {
    if (!Array.isArray(raw.tags)) return `payload.${path}.tags must be an array of strings`
    if (raw.tags.length > NEWS_DIGEST_MAX_TAGS) {
      return `payload.${path}.tags must have at most ${NEWS_DIGEST_MAX_TAGS} entries (got ${raw.tags.length})`
    }
    for (const [tagIndex, tag] of raw.tags.entries()) {
      if (typeof tag !== 'string') return `payload.${path}.tags[${tagIndex}] must be a string`
      if (tag.length > NEWS_DIGEST_NAME_MAX) {
        return `payload.${path}.tags[${tagIndex}] must be at most ${NEWS_DIGEST_NAME_MAX} characters`
      }
    }
  }

  const sources = checkSources(raw.sources, path)
  if (sources) return sources
  // `published_at` stays a free string: the renderer formats what it can parse
  // and shows nothing otherwise.
  for (const [sourceIndex, entry] of (raw.sources as unknown[]).entries()) {
    const publishedAt = checkString(
      (entry as Record<string, unknown>).published_at,
      `${path}.sources[${sourceIndex}].published_at`, NEWS_DIGEST_NAME_MAX, false,
    )
    if (publishedAt) return publishedAt
  }
  return null
}

function checkQuickHitsV2(raw: unknown): string | null {
  if (!Array.isArray(raw)) return 'payload.quick_hits must be an array'
  if (raw.length > NEWS_DIGEST_MAX_QUICK_HITS) {
    return `payload.quick_hits must have at most ${NEWS_DIGEST_MAX_QUICK_HITS} entries (got ${raw.length})`
  }
  for (const [index, entry] of raw.entries()) {
    const path = `quick_hits[${index}]`
    if (!isPlainObject(entry)) return `payload.${path} must be an object`
    const title = checkString(entry.title, `${path}.title`, NEWS_DIGEST_V2_QUICK_HIT_TITLE_MAX, true)
    if (title) return title
    const url = checkUrl(entry.url, `${path}.url`)
    if (url) return url
    for (const [field, max] of [['source', NEWS_DIGEST_NAME_MAX], ['note', NEWS_DIGEST_NOTE_MAX]] as const) {
      const problem = checkString(entry[field], `${path}.${field}`, max, false)
      if (problem) return problem
    }
  }
  return null
}

function checkStats(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'payload.stats must be an object'
  for (const field of ['sources_checked', 'candidates', 'clusters'] as const) {
    const value = raw[field]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
      return `payload.stats.${field} must be a finite number`
    }
  }
  const failed = raw.sources_failed
  if (failed !== undefined && failed !== null) {
    if (!Array.isArray(failed)) return 'payload.stats.sources_failed must be an array of strings'
    for (const [index, entry] of failed.entries()) {
      if (typeof entry !== 'string') return `payload.stats.sources_failed[${index}] must be a string`
      if (entry.length > NEWS_DIGEST_NAME_MAX) {
        return `payload.stats.sources_failed[${index}] must be at most ${NEWS_DIGEST_NAME_MAX} characters`
      }
    }
  }
  return null
}

/**
 * Reject a `news_digest.v2` payload that cannot be rendered, otherwise null.
 * Never rewrites, never trims, never fills a default — same contract as
 * `validateNewsDigestPayload` (v1), which stays in place for old boards.
 */
export function validateNewsDigestV2Payload(payload: Record<string, unknown>): string | null {
  const version = payload.schema_version
  if (version !== undefined && version !== null && version !== NEWS_DIGEST_V2_KIND) {
    return `payload.schema_version must be "${NEWS_DIGEST_V2_KIND}" when present`
  }

  const headline = checkString(payload.headline, 'headline', NEWS_DIGEST_V2_HEADLINE_MAX, true)
  if (headline) return headline

  for (const field of ['date', 'generated_at', 'profile'] as const) {
    const problem = checkString(payload[field], field, NEWS_DIGEST_NAME_MAX, false)
    if (problem) return problem
  }
  if (payload.window_hours !== undefined && payload.window_hours !== null
    && (typeof payload.window_hours !== 'number' || !Number.isFinite(payload.window_hours))) {
    return 'payload.window_hours must be a finite number'
  }

  if (payload.categories !== undefined && payload.categories !== null) {
    if (!isPlainObject(payload.categories)) return 'payload.categories must be an object of id → label'
    for (const [id, label] of Object.entries(payload.categories)) {
      if (typeof label !== 'string') return `payload.categories.${id} must be a string label`
      if (label.length > NEWS_DIGEST_NAME_MAX) {
        return `payload.categories.${id} must be at most ${NEWS_DIGEST_NAME_MAX} characters`
      }
    }
  }

  const items = payload.items
  if (!Array.isArray(items)) return 'payload.items is required and must be an array'
  if (items.length < 1 || items.length > NEWS_DIGEST_MAX_ITEMS) {
    return `payload.items must have between 1 and ${NEWS_DIGEST_MAX_ITEMS} entries (got ${items.length})`
  }
  for (const [index, item] of items.entries()) {
    const problem = checkItemV2(item, index)
    if (problem) return problem
  }

  if (payload.quick_hits !== undefined && payload.quick_hits !== null) {
    const problem = checkQuickHitsV2(payload.quick_hits)
    if (problem) return problem
  }
  if (payload.stats !== undefined && payload.stats !== null) {
    const problem = checkStats(payload.stats)
    if (problem) return problem
  }
  return null
}
