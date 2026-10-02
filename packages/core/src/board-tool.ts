/**
 * `publish_board` (plan 2026-09-25): the one way an agent writes a board.
 *
 * The tool is deliberately generic. It knows nothing about portfolios,
 * depots or any other subject — a board is a `key`, a `kind` (the renderer
 * contract) and a JSON payload. The only kind-specific code in this file is
 * an OPTIONAL payload check for `portfolio_digest.v1`, which exists because
 * that contract is published in the docs and a silently malformed payload
 * would render as an empty card on two clients.
 *
 * Validation rules that are not obvious:
 *
 *  - every failure is returned as a tool error (`isError: true`), never
 *    thrown: a publishing cronjob must get a readable reason back instead of
 *    dying with a stack trace,
 *  - the user is taken from the running task/strand, never from the model —
 *    a tool argument for the owner would be a cross-user write primitive,
 *  - the payload size is measured on the serialized JSON, because that is
 *    what the database and the app have to carry.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { upsertBoard, upsertBoardSeries, type BoardSeriesInput } from './board-store.js'
import { HTML_VIEW_KIND, HTML_VIEW_PAYLOAD_MAX_BYTES, validateHtmlViewPayload } from './board-html-view.js'
import {
  NEWS_DIGEST_KIND, NEWS_DIGEST_V2_KIND, validateNewsDigestPayload, validateNewsDigestV2Payload,
} from './board-news-digest.js'

export const BOARD_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/
export const BOARD_KIND_PATTERN = /^[a-z0-9_]+\.v[0-9]+$/
export const BOARD_TITLE_MAX = 80
export const BOARD_ICON_MAX = 16
export const BOARD_SUMMARY_MAX = 2000
/** Serialized payload bytes. */
export const BOARD_PAYLOAD_MAX_BYTES = 256 * 1024

/**
 * The payload budget of one kind. Only `html_view.v1` differs: its payload
 * carries the renderer (a whole self-contained document), not just the data
 * for a renderer the client already ships. See `board-html-view.ts`.
 */
export function boardPayloadMaxBytes(kind: string): number {
  return kind === HTML_VIEW_KIND ? HTML_VIEW_PAYLOAD_MAX_BYTES : BOARD_PAYLOAD_MAX_BYTES
}
export const BOARD_SERIES_MAX_POINTS = 500
export const BOARD_SERIES_NAME_MAX = 64
export const BOARD_DEDUPE_KEY_MAX = 128
/**
 * Series names travel through `GET /api/boards/:key/series?series=a,b`, so a
 * name must not contain a comma or whitespace. `:` and upper case stay
 * allowed: producers namespace per-instrument series as `pos:<ISIN>`, and a
 * canonical ISIN is upper case.
 */
export const BOARD_SERIES_NAME_PATTERN = /^[A-Za-z0-9_:.-]{1,64}$/
/** Per point, serialized. Series rows are never pruned. */
export const BOARD_SERIES_META_MAX_BYTES = 4096
/** All series of one call, serialized. */
export const BOARD_SERIES_MAX_BYTES = 256 * 1024

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** What the feed/push/ws side has to do after a board was written. */
export interface BoardPublication {
  userId: number
  agentId: string | null
  key: string
  kind: string
  title: string
  summary: string | null
  revision: number
  asOf: string
  notify: boolean
  dedupeKey: string | null
}

export interface BoardPublicationResult {
  feedItemId: string | null
  deduped: boolean
  /** True only when a push doorbell was actually handed to a sender. */
  notified: boolean
}

export interface PublishBoardToolOptions {
  db: Database
  /** Numeric user id of the running task/strand owner (`users.id`). */
  getCurrentToolUserId: () => number | undefined
  /** Persona whose runtime is executing the call; stored on the board. */
  getCurrentAgentId?: () => string | undefined
  /**
   * Announce the new state: feed item, doorbell, websocket. Optional so the
   * store side is testable alone; without it the board is written and the
   * result reports `feedItemId: null`.
   */
  publish?: (publication: BoardPublication) => BoardPublicationResult | Promise<BoardPublicationResult>
}

type Validated = {
  key: string
  kind: string
  title: string
  icon: string | null
  summary: string | null
  payload: Record<string, unknown>
  asOf: string
  notify: boolean
  dedupeKey: string | null
  series: BoardSeriesInput[]
}

export type BoardParamsResult = { ok: true; value: Validated } | { ok: false; error: string }

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Object parameters arrive as objects from most providers, but a model may also
 * hand over the serialized form. Both are accepted; anything that does not
 * decode to a plain object (arrays, scalars, broken JSON) is rejected upstream.
 */
function coerceJsonObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const decoded: unknown = JSON.parse(trimmed)
    return isPlainObject(decoded) ? decoded : null
  } catch {
    return null
  }
}

/** ISO 8601 with a date part; anything else is rejected rather than guessed. */
function normalizeTimestamp(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 40) return null
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) return null
  if (Number.isNaN(Date.parse(trimmed))) return null
  return trimmed
}

/**
 * Strict parameter validation. Returned, not thrown, and written by hand
 * rather than with a schema library: the repository has no validation
 * dependency and the tool surface is small enough that one is not worth a new
 * runtime dependency in `@axiom/core`.
 */
export function validateBoardParams(raw: unknown, now: () => Date = () => new Date()): BoardParamsResult {
  if (!isPlainObject(raw)) return fail('parameters must be an object')

  const key = typeof raw.key === 'string' ? raw.key.trim() : ''
  if (!BOARD_KEY_PATTERN.test(key)) {
    return fail('key must match ^[a-z0-9][a-z0-9-]{1,39}$ (lowercase letters, digits and dashes, 2 to 40 chars)')
  }

  const kind = typeof raw.kind === 'string' ? raw.kind.trim() : ''
  if (!BOARD_KIND_PATTERN.test(kind)) {
    return fail('kind must match ^[a-z0-9_]+\\.v[0-9]+$, for example "portfolio_digest.v1"')
  }

  if (typeof raw.title !== 'string') return fail('title is required and must be a string')
  const title = raw.title.replace(/\s+/g, ' ').trim()
  if (title.length === 0) return fail('title must not be empty')
  if (title.length > BOARD_TITLE_MAX) return fail(`title must be at most ${BOARD_TITLE_MAX} characters`)

  let icon: string | null = null
  if (raw.icon !== undefined && raw.icon !== null) {
    if (typeof raw.icon !== 'string') return fail('icon must be a string')
    const trimmed = raw.icon.trim()
    if (trimmed.length > BOARD_ICON_MAX) return fail(`icon must be at most ${BOARD_ICON_MAX} characters`)
    icon = trimmed.length > 0 ? trimmed : null
  }

  let summary: string | null = null
  if (raw.summary !== undefined && raw.summary !== null) {
    if (typeof raw.summary !== 'string') return fail('summary must be a string')
    const trimmed = raw.summary.trim()
    if (trimmed.length > BOARD_SUMMARY_MAX) return fail(`summary must be at most ${BOARD_SUMMARY_MAX} characters`)
    summary = trimmed.length > 0 ? trimmed : null
  }

  const payload = coerceJsonObject(raw.payload)
  if (!payload) return fail('payload is required and must be a JSON object')
  let serialized: string
  try {
    serialized = JSON.stringify(payload)
  } catch (err) {
    if (err instanceof RangeError) return fail('payload is nested too deeply to be serialized')
    return fail('payload must be JSON-serializable (no cycles, no functions)')
  }
  if (serialized === undefined) return fail('payload must be JSON-serializable')
  const bytes = Buffer.byteLength(serialized, 'utf8')
  const payloadMax = boardPayloadMaxBytes(kind)
  if (bytes > payloadMax) {
    return fail(`payload must be at most ${payloadMax} bytes serialized (got ${bytes})`)
  }

  let asOf = now().toISOString()
  if (raw.as_of !== undefined && raw.as_of !== null) {
    if (typeof raw.as_of !== 'string') return fail('as_of must be an ISO 8601 string')
    const normalized = normalizeTimestamp(raw.as_of)
    if (!normalized) return fail('as_of must be an ISO 8601 timestamp, for example "2026-09-25T22:00:04+02:00"')
    asOf = normalized
  }

  if (raw.notify !== undefined && raw.notify !== null && typeof raw.notify !== 'boolean') {
    return fail('notify must be a boolean')
  }
  const notify = raw.notify === true

  let dedupeKey: string | null = null
  if (raw.dedupe_key !== undefined && raw.dedupe_key !== null) {
    if (typeof raw.dedupe_key !== 'string') return fail('dedupe_key must be a string')
    const trimmed = raw.dedupe_key.trim()
    if (trimmed.length > BOARD_DEDUPE_KEY_MAX) {
      return fail(`dedupe_key must be at most ${BOARD_DEDUPE_KEY_MAX} characters`)
    }
    dedupeKey = trimmed.length > 0 ? trimmed : null
  }

  const series: BoardSeriesInput[] = []
  if (raw.series !== undefined && raw.series !== null) {
    if (!Array.isArray(raw.series)) return fail('series must be an array')
    if (raw.series.length > BOARD_SERIES_MAX_POINTS) {
      return fail(`series must have at most ${BOARD_SERIES_MAX_POINTS} entries (got ${raw.series.length})`)
    }
    for (const [index, entry] of raw.series.entries()) {
      if (!isPlainObject(entry)) return fail(`series[${index}] must be an object`)
      const name = typeof entry.series === 'string' ? entry.series.trim() : ''
      if (name.length === 0 || name.length > BOARD_SERIES_NAME_MAX) {
        return fail(`series[${index}].series must be a non-empty string of at most ${BOARD_SERIES_NAME_MAX} characters`)
      }
      if (!BOARD_SERIES_NAME_PATTERN.test(name)) {
        return fail(`series[${index}].series must match ${BOARD_SERIES_NAME_PATTERN.source}, for example "total_eur"`)
      }
      const day = typeof entry.day === 'string' ? entry.day.trim() : ''
      if (!DAY_PATTERN.test(day) || Number.isNaN(Date.parse(day))) {
        return fail(`series[${index}].day must be a calendar day as YYYY-MM-DD`)
      }
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
        return fail(`series[${index}].value must be a finite number`)
      }
      const meta = entry.meta === undefined || entry.meta === null ? null : coerceJsonObject(entry.meta)
      if (entry.meta !== undefined && entry.meta !== null && !meta) {
        return fail(`series[${index}].meta must be an object`)
      }
      if (meta) {
        let metaBytes: number
        try {
          metaBytes = Buffer.byteLength(JSON.stringify(meta) ?? '', 'utf8')
        } catch (err) {
          if (err instanceof RangeError) return fail(`series[${index}].meta is nested too deeply to be serialized`)
          return fail(`series[${index}].meta must be JSON-serializable (no cycles, no functions)`)
        }
        if (metaBytes > BOARD_SERIES_META_MAX_BYTES) {
          return fail(
            `series[${index}].meta must be at most ${BOARD_SERIES_META_MAX_BYTES} bytes serialized (got ${metaBytes})`,
          )
        }
      }
      series.push({
        series: name,
        day,
        value: entry.value,
        ...(meta ? { meta } : {}),
      })
    }
    const seriesBytes = Buffer.byteLength(JSON.stringify(series), 'utf8')
    if (seriesBytes > BOARD_SERIES_MAX_BYTES) {
      return fail(`series must be at most ${BOARD_SERIES_MAX_BYTES} bytes serialized in total (got ${seriesBytes})`)
    }
  }

  if (kind === PORTFOLIO_DIGEST_KIND) {
    const problem = validatePortfolioDigestPayload(payload)
    if (problem) return fail(problem)
  }

  if (kind === HTML_VIEW_KIND) {
    const problem = validateHtmlViewPayload(payload)
    if (problem) return fail(problem)
  }

  if (kind === NEWS_DIGEST_KIND) {
    const problem = validateNewsDigestPayload(payload)
    if (problem) return fail(problem)
  }

  if (kind === NEWS_DIGEST_V2_KIND) {
    const problem = validateNewsDigestV2Payload(payload)
    if (problem) return fail(problem)
  }

  return { ok: true, value: { key, kind, title, icon, summary, payload, asOf, notify, dedupeKey, series } }
}

export const PORTFOLIO_DIGEST_KIND = 'portfolio_digest.v1'

/**
 * The one kind-specific rule in the backend, and it only ever rejects — it
 * never rewrites a payload and never looks at anything but the required
 * fields of the published contract (`docs/reference/boards-api.md`). Unknown
 * fields are ignored on purpose (forward compatibility).
 *
 * Returns null when the payload is acceptable, otherwise the reason.
 */
export function validatePortfolioDigestPayload(payload: Record<string, unknown>): string | null {
  const required = ['schema_version', 'run_id', 'slot', 'as_of', 'overview', 'digest']
  for (const field of required) {
    if (payload[field] === undefined || payload[field] === null) {
      return `payload.${field} is required for kind ${PORTFOLIO_DIGEST_KIND}`
    }
  }
  for (const field of ['schema_version', 'run_id', 'slot', 'as_of', 'digest']) {
    if (typeof payload[field] !== 'string' || (payload[field] as string).trim().length === 0) {
      return `payload.${field} must be a non-empty string`
    }
  }
  const overview = payload.overview
  if (!isPlainObject(overview)) return 'payload.overview must be an object'
  for (const field of ['securities_eur', 'cash_eur', 'total_eur']) {
    if (typeof overview[field] !== 'number' || !Number.isFinite(overview[field] as number)) {
      return `payload.overview.${field} must be a finite number`
    }
  }
  const day = overview.day
  if (!isPlainObject(day)) return 'payload.overview.day must be an object'
  for (const field of ['delta_eur', 'delta_pct']) {
    if (typeof day[field] !== 'number' || !Number.isFinite(day[field] as number)) {
      return `payload.overview.day.${field} must be a finite number`
    }
  }
  return null
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
    details: { error: true, message },
  }
}

export function createPublishBoardTool(options: PublishBoardToolOptions): AgentTool {
  return {
    name: 'publish_board',
    label: 'Publish Board',
    description:
      'Publish or update a board: a long-lived, overwritable object the user opens from the "Boards" card '
      + '(chooser -> board screen). Use it for recurring, structured results that should always show ONE current '
      + 'state instead of a new chat message or feed card per run (daily digests, dashboards, monitors). '
      + 'A board is identified by `key` and rendered according to `kind` (the renderer contract, e.g. '
      + '"portfolio_digest.v1"); an unknown kind falls back to a generic renderer that shows `summary` as Markdown '
      + 'plus the raw payload. Every publish overwrites the board, bumps its revision, keeps the previous state as a '
      + 'revision and writes one feed card (title = board title, body = summary). Set `notify: true` only when the '
      + 'update is worth a push notification. Pass `dedupe_key` (e.g. a run id) so a retried run updates the board '
      + 'without producing a second feed card; the key is scoped to this board, so the same run id may be reused '
      + 'for another board. Use `series` for numeric values that should form a trend line '
      + '(one entry per series and day; the last write of a day wins). '
      + 'To show a view no built-in renderer can draw, publish kind "html_view.v1" with '
      + '`payload.html` = one self-contained HTML document (no network, no CDN, no web fonts, no storage; '
      + 'inline CSS/SVG/JS only, at most 1 MB). It is served from a sandboxed content URL and rendered in an '
      + 'isolated iframe/WebView in web and app, so it can never read the app, its cookies or its token. '
      + 'Optional payload hints: `supports_theme` (the page reads `?theme=dark|light` from its own URL; dark is '
      + 'the default, so style for dark first), `aspect_ratio` (width / height) and `min_height_px`. '
      + 'Links work: an `<a href="https://…">` is opened by the host in a new tab (http/https only; '
      + '`javascript:`, `data:` and downloads do not work, and neither does storage — the document keeps no '
      + 'state between views). '
      + 'If a board kind should be drawn by a reusable renderer instead of a document per publish, the operator '
      + 'can place one HTML renderer per kind on the server '
      + '(`<DATA_DIR>/board-renderers/<kind>.html`); the server then injects the board state as '
      + '`<script type="application/json" id="board-data">` and serves it in the same sandbox, so the payload '
      + 'stays plain JSON and no app update is needed. '
      + 'For a daily news digest use kind "news_digest.v2": `payload` = { headline, optional categories '
      + '(id → label), items[1-20] with story_id/title/take/summary/verdict (hot|relevant|watch|hype), '
      + 'optional status (new|update) + delta, and 1-20 sources of { name, https:// url, type }, '
      + 'optional quick_hits and stats } — rendered as a divided list with a swipeable detail view. '
      + 'Kind "news_digest.v1" (id/title/summary, no take) stays accepted for old boards.',
    parameters: Type.Object({
      key: Type.String({
        description: 'Stable board id, lowercase letters, digits and dashes, 2-40 chars (e.g. "portfolio", "site-health"). Publishing again with the same key overwrites that board.',
      }),
      kind: Type.String({
        description: 'Renderer contract of the payload, e.g. "portfolio_digest.v1". Format: <name>.v<number>. Keep it stable; bump the version when the payload shape changes.',
      }),
      title: Type.String({
        description: 'Board title shown in the chooser and as the feed card title. At most 80 characters.',
      }),
      icon: Type.Optional(Type.String({
        description: 'Emoji or icon name shown next to the title, at most 16 characters.',
      })),
      summary: Type.Optional(Type.String({
        description: 'Short Markdown summary (at most 2000 chars). This is the text of the feed card and the fallback rendering, so write the two or three sentences that matter.',
      })),
      // Declared as an object so the model emits a nested JSON value; the validator additionally
      // accepts a JSON string that decodes to an object (the first live run sent exactly that).
      payload: Type.Record(Type.String(), Type.Unknown(), {
        description: 'The board content as a JSON object (not a string), matching `kind`. At most 256 KB serialized (1 MB for kind "html_view.v1", whose payload is { html, supports_theme?, aspect_ratio?, min_height_px? }). Unknown fields are kept but may not be rendered.',
      }),
      as_of: Type.Optional(Type.String({
        description: 'ISO 8601 timestamp the data refers to. Defaults to now.',
      })),
      notify: Type.Optional(Type.Boolean({
        description: 'Send a push notification for this update (default false). Use sparingly: a silent update still appears in the feed.',
      })),
      dedupe_key: Type.Optional(Type.String({
        description: 'Idempotency key, e.g. the run id. Publishing again with the same key updates the board but does not create a second feed card. Scoped to this board: the same key on another board still gets its own card.',
      })),
      series: Type.Optional(Type.Array(
        Type.Object({
          series: Type.String({ description: 'Series name, letters, digits and `_ : . -`, at most 64 chars, e.g. "total_eur" or "pos:XX0000000001". No commas or whitespace.' }),
          day: Type.String({ description: 'Calendar day as YYYY-MM-DD.' }),
          value: Type.Number({ description: 'Numeric value for that day.' }),
          meta: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Optional JSON object stored with the point, at most 4 KB serialized.' })),
        }),
        { description: 'Numeric history points, at most 500 per call. Re-publishing a day overwrites its value.' },
      )),
    }),
    execute: async (_toolCallId, params) => {
      const userId = options.getCurrentToolUserId()
      if (userId === undefined || userId === null) {
        return errorResult('publish_board needs a user context (running task or strand) and found none')
      }

      const parsed = validateBoardParams(params)
      if (!parsed.ok) return errorResult(parsed.error)
      const input = parsed.value

      let revision: number
      try {
        const board = upsertBoard(options.db, {
          userId: String(userId),
          key: input.key,
          kind: input.kind,
          title: input.title,
          icon: input.icon,
          agentId: options.getCurrentAgentId?.() ?? null,
          summary: input.summary,
          payload: input.payload,
          asOf: input.asOf,
        })
        revision = board.revision
        if (input.series.length > 0) {
          upsertBoardSeries(options.db, String(userId), input.key, input.series)
        }
      } catch (err) {
        return errorResult(`failed to store the board: ${(err as Error).message}`)
      }

      let feedItemId: string | null = null
      let deduped = false
      let notified = false
      if (options.publish) {
        try {
          const result = await options.publish({
            userId,
            agentId: options.getCurrentAgentId?.() ?? null,
            key: input.key,
            kind: input.kind,
            title: input.title,
            summary: input.summary,
            revision,
            asOf: input.asOf,
            notify: input.notify,
            dedupeKey: input.dedupeKey,
          })
          feedItemId = result.feedItemId
          deduped = result.deduped
          notified = result.notified
        } catch (err) {
          // The board IS updated at this point. Reporting a hard error would
          // invite the agent to publish again and write a second revision, so
          // the failure is reported as part of a successful publish.
          return {
            content: [{
              type: 'text' as const,
              text: `Board "${input.key}" updated to revision ${revision}, but announcing it failed: `
                + `${(err as Error).message}`,
            }],
            details: { key: input.key, revision, feedItemId: null, deduped: false, announceFailed: true },
          }
        }
      }

      const seriesNote = input.series.length > 0 ? `, ${input.series.length} series point(s) stored` : ''
      const feedNote = deduped
        ? ', no new feed card (dedupe_key already used)'
        : feedItemId
          ? `, feed card ${feedItemId}${notified ? ' with push' : ''}`
          : ''
      return {
        content: [{
          type: 'text' as const,
          text: `Board "${input.key}" updated to revision ${revision}${seriesNote}${feedNote}.`,
        }],
        details: { key: input.key, revision, feedItemId, deduped },
      }
    },
  }
}
