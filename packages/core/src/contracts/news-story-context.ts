/**
 * news-story-context.ts — how ONE story of a news digest board travels into a
 * conversation.
 *
 * A reader looking at a story on a news board ("Use in question") should be
 * able to ask about exactly that story without copying fields by hand. Two
 * properties decide whether that is trustworthy:
 *
 *  - The context is a SNAPSHOT, not a reference that is read again later. A
 *    board is overwritten every day (`publish_board` bumps the revision), so a
 *    pointer alone would silently change meaning under the conversation. The
 *    text carries the fields as they were on the revision the reader saw.
 *  - The snapshot never claims more than the board holds: title, take,
 *    summary, what is new, verdict, category, digest date and the source
 *    LINKS. The article full text is not in the payload, so the block says so
 *    in its header instead of pretending.
 *
 * Alongside the snapshot every block carries a stable code
 * (`ot-news:<board>/<story>@r<revision>`, see `formatNewsStoryRef`) so a later
 * turn, a second strand or a log line can name the same story unambiguously
 * even after the board has been republished.
 *
 * Everything here is a pure string function and lives in `contracts/` on
 * purpose: the board renderer in the browser builds the block, and the backend
 * (or a future agent tool) parses the code, from the same source.
 *
 * ## Untrusted input
 *
 * Every field originates in a model-written payload built from web sources.
 * The block is plain text that ends up inside a chat message, so
 * `sanitizeContextValue` collapses each value to a single line, strips control
 * characters, caps the length and breaks up hyphen runs, which is what keeps a
 * value from forging the `---` fence lines of the block. Links survive only as
 * `https://` URLs — the same rule the renderer and the backend validator
 * already apply.
 */

/** Scheme of the stable story code. Deliberately not a real URL scheme. */
export const NEWS_STORY_REF_SCHEME = 'ot-news'

/** Board keys are lowercase slugs (mirrors `BOARD_KEY_PATTERN`). */
const BOARD_KEY_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
/**
 * `story_id` is producer-chosen. Accepted are the characters a slug needs;
 * `/` and `@` are excluded because they are the separators of the code.
 */
const STORY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

/** Field caps in characters. Generous: a board payload is capped already. */
export const NEWS_CONTEXT_TITLE_MAX = 300
export const NEWS_CONTEXT_TAKE_MAX = 400
export const NEWS_CONTEXT_SUMMARY_MAX = 1200
export const NEWS_CONTEXT_DELTA_MAX = 400
export const NEWS_CONTEXT_NAME_MAX = 160
export const NEWS_CONTEXT_URL_MAX = 2048
export const NEWS_CONTEXT_MAX_SOURCES = 20

/** The fence lines of the block. Both are stripped from every value. */
export const NEWS_CONTEXT_HEADER = '--- Off-Tangent news article (board snapshot, not the full text) ---'
export const NEWS_CONTEXT_FOOTER = '--- end of article snapshot ---'

export interface NewsStoryRef {
  boardKey: string
  storyId: string
  /** Board revision the snapshot was taken from, null when unknown. */
  revision: number | null
}

export interface NewsStoryContextSource {
  name: string
  /** Only an `https://` URL is kept; anything else is dropped to the name. */
  url?: string | null
  type?: string | null
  publishedAt?: string | null
}

export interface NewsStoryContextInput {
  boardKey: string
  boardTitle?: string | null
  /** Revision of the board the reader was looking at. */
  revision?: number | null
  /** `date` of the digest payload (the day the reader opened). */
  date?: string | null
  storyId: string
  title: string
  /** v2 only: the one sentence verdict. A v1 story has none. */
  take?: string | null
  summary?: string | null
  /** What is new about a returning story. */
  delta?: string | null
  verdict?: string | null
  /** Display label of the category, not the raw id, when the payload has one. */
  category?: string | null
  sources?: NewsStoryContextSource[] | null
  /** In-app deep link to the story, e.g. `/boards/ki-news?date=…&story=…`. */
  boardLink?: string | null
}

/**
 * `ot-news:<board>/<story>@r<revision>` — or without `@r…` when the revision
 * is unknown. Returns an empty string for a board key or story id that could
 * never be parsed back, so a caller cannot mint an unresolvable code.
 */
export function formatNewsStoryRef(ref: {
  boardKey: string
  storyId: string
  revision?: number | null
}): string {
  const boardKey = String(ref.boardKey ?? '').trim()
  const storyId = String(ref.storyId ?? '').trim()
  if (!BOARD_KEY_RE.test(boardKey) || !STORY_ID_RE.test(storyId)) return ''
  const revision = ref.revision
  const suffix = typeof revision === 'number' && Number.isInteger(revision) && revision > 0
    ? `@r${revision}`
    : ''
  return `${NEWS_STORY_REF_SCHEME}:${boardKey}/${storyId}${suffix}`
}

const REF_RE = new RegExp(
  `${NEWS_STORY_REF_SCHEME}:([a-z0-9][a-z0-9-]{1,39})/([A-Za-z0-9][A-Za-z0-9._:-]{0,119}?)(?:@r(\\d{1,9}))?(?![A-Za-z0-9._:@/-])`,
)

/**
 * First story code inside `text`, or null. Tolerant on purpose: the code is
 * meant to be pasted into a sentence, so it is found in prose, in a code
 * fence, in brackets — but never with a broken board key or story id.
 */
export function parseNewsStoryRef(text: unknown): NewsStoryRef | null {
  if (typeof text !== 'string' || !text) return null
  const match = REF_RE.exec(text)
  if (!match) return null
  const [, boardKey, storyId, revision] = match
  if (!boardKey || !storyId) return null
  const parsed = revision ? Number.parseInt(revision, 10) : NaN
  return {
    boardKey,
    storyId,
    revision: Number.isInteger(parsed) && parsed > 0 ? parsed : null,
  }
}

/** True when `value` is a usable `https://` link. */
export function isHttpsContextUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > NEWS_CONTEXT_URL_MAX) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One payload value as it may appear in the block: a single line, without
 * control characters, without a hyphen run that could forge a fence, capped.
 */
export function sanitizeContextValue(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/-{3,}/g, '--')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

function sourceLine(source: NewsStoryContextSource): string | null {
  const name = sanitizeContextValue(source.name, NEWS_CONTEXT_NAME_MAX)
  const type = sanitizeContextValue(source.type, NEWS_CONTEXT_NAME_MAX)
  const published = sanitizeContextValue(source.publishedAt, NEWS_CONTEXT_NAME_MAX)
  const url = isHttpsContextUrl(source.url) ? source.url : ''
  if (!name && !url) return null
  const meta = [type, published].filter(Boolean).join(', ')
  const label = [name || url, meta ? `(${meta})` : ''].filter(Boolean).join(' ')
  return url ? `- ${label}: ${url}` : `- ${label} (no link in the payload)`
}

/**
 * The context block for one story: a fenced, single-purpose plain text
 * snapshot plus its stable code. Never returns an empty block — the title and
 * the code are always there, everything else only when the payload has it.
 */
export function formatNewsStoryContext(input: NewsStoryContextInput): string {
  const code = formatNewsStoryRef(input)
  const boardTitle = sanitizeContextValue(input.boardTitle, NEWS_CONTEXT_NAME_MAX)
  const boardKey = sanitizeContextValue(input.boardKey, NEWS_CONTEXT_NAME_MAX)
  const storyId = sanitizeContextValue(input.storyId, NEWS_CONTEXT_NAME_MAX)
  const date = sanitizeContextValue(input.date, NEWS_CONTEXT_NAME_MAX)
  const revision = typeof input.revision === 'number' && Number.isInteger(input.revision) && input.revision > 0
    ? input.revision
    : null

  const lines: string[] = [NEWS_CONTEXT_HEADER]
  if (code) lines.push(`Code: ${code}`)

  const boardParts = [
    boardTitle ? `Board: ${boardTitle}${boardKey ? ` (${boardKey})` : ''}` : boardKey ? `Board: ${boardKey}` : '',
    date ? `Digest date: ${date}` : '',
    revision ? `Revision: ${revision}` : '',
  ].filter(Boolean)
  if (boardParts.length) lines.push(boardParts.join(' · '))

  const storyParts = [
    storyId ? `Story: ${storyId}` : '',
    sanitizeContextValue(input.verdict, NEWS_CONTEXT_NAME_MAX) ? `Verdict: ${sanitizeContextValue(input.verdict, NEWS_CONTEXT_NAME_MAX)}` : '',
    sanitizeContextValue(input.category, NEWS_CONTEXT_NAME_MAX) ? `Category: ${sanitizeContextValue(input.category, NEWS_CONTEXT_NAME_MAX)}` : '',
  ].filter(Boolean)
  if (storyParts.length) lines.push(storyParts.join(' · '))

  lines.push(`Title: ${sanitizeContextValue(input.title, NEWS_CONTEXT_TITLE_MAX)}`)

  const take = sanitizeContextValue(input.take, NEWS_CONTEXT_TAKE_MAX)
  if (take) lines.push(`Take: ${take}`)
  const summary = sanitizeContextValue(input.summary, NEWS_CONTEXT_SUMMARY_MAX)
  if (summary) lines.push(`Summary: ${summary}`)
  const delta = sanitizeContextValue(input.delta, NEWS_CONTEXT_DELTA_MAX)
  if (delta) lines.push(`What's new: ${delta}`)

  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .slice(0, NEWS_CONTEXT_MAX_SOURCES)
    .map(sourceLine)
    .filter((line): line is string => !!line)
  if (sources.length) lines.push('Sources:', ...sources)

  const boardLink = sanitizeContextValue(input.boardLink, NEWS_CONTEXT_URL_MAX)
  if (boardLink) lines.push(`Board link: ${boardLink}`)

  lines.push(NEWS_CONTEXT_FOOTER)
  return lines.join('\n')
}
