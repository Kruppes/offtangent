import type { TaskStatus, TaskTriggerType } from '@axiom/core'
import type { TaskEventsCursor } from './types.js'

const VALID_STATUSES: TaskStatus[] = ['running', 'paused', 'completed', 'failed']
const VALID_TRIGGER_TYPES: TaskTriggerType[] = ['user', 'agent', 'cronjob', 'heartbeat', 'consolidation']

export interface ListTasksQuery {
  page: number
  limit: number
  offset: number
  status?: TaskStatus
  triggerType?: TaskTriggerType
  provider?: string
  model?: string
  isDefaultModel?: boolean
  createdFrom?: string
  createdTo?: string
}

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

type ParseResult<T> = ParseSuccess<T> | ParseFailure

function toOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0]
  }
  return undefined
}

function isValidDateOnly(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function normalizeDateBoundary(value: string, boundary: 'start' | 'end'): string | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnlyMatch) {
    const [, yearRaw, monthRaw, dayRaw] = dateOnlyMatch
    const year = Number(yearRaw)
    const month = Number(monthRaw)
    const day = Number(dayRaw)
    if (!isValidDateOnly(year, month, day)) {
      return null
    }

    return `${yearRaw}-${monthRaw}-${dayRaw} ${boundary === 'start' ? '00:00:00' : '23:59:59'}`
  }

  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) {
    return null
  }

  return date.toISOString().replace('T', ' ').slice(0, 19)
}

export function parseListTasksQuery(query: Record<string, unknown>): ParseResult<ListTasksQuery> {
  const page = Math.max(1, Number.parseInt(toOptionalString(query.page) ?? '', 10) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(toOptionalString(query.limit) ?? '', 10) || 20))
  const offset = (page - 1) * limit

  const statusParam = toOptionalString(query.status)
  const triggerTypeParam = toOptionalString(query.trigger_type)
  const providerParam = toOptionalString(query.provider)?.trim()
  const modelParam = toOptionalString(query.model)?.trim()
  const isDefaultModelParam = toOptionalString(query.is_default_model)
  const createdFromParam = toOptionalString(query.created_from)
  const createdToParam = toOptionalString(query.created_to)

  if (statusParam && !VALID_STATUSES.includes(statusParam as TaskStatus)) {
    return {
      ok: false,
      error: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}`,
    }
  }

  if (triggerTypeParam && !VALID_TRIGGER_TYPES.includes(triggerTypeParam as TaskTriggerType)) {
    return {
      ok: false,
      error: `Invalid trigger_type filter. Must be one of: ${VALID_TRIGGER_TYPES.join(', ')}`,
    }
  }

  let isDefaultModel: boolean | undefined
  if (isDefaultModelParam) {
    if (isDefaultModelParam !== 'true' && isDefaultModelParam !== 'false') {
      return { ok: false, error: 'Invalid is_default_model filter. Must be true or false.' }
    }
    isDefaultModel = isDefaultModelParam === 'true'
  }

  const createdFrom = createdFromParam ? normalizeDateBoundary(createdFromParam, 'start') : undefined
  if (createdFrom === null) {
    return { ok: false, error: 'Invalid created_from filter. Must be a date or ISO date-time.' }
  }

  const createdTo = createdToParam ? normalizeDateBoundary(createdToParam, 'end') : undefined
  if (createdTo === null) {
    return { ok: false, error: 'Invalid created_to filter. Must be a date or ISO date-time.' }
  }

  if (createdFrom && createdTo && createdTo < createdFrom) {
    return { ok: false, error: 'Invalid date range. created_to must be greater than or equal to created_from.' }
  }

  return {
    ok: true,
    value: {
      page,
      limit,
      offset,
      status: statusParam as TaskStatus | undefined,
      triggerType: triggerTypeParam as TaskTriggerType | undefined,
      provider: providerParam || undefined,
      model: modelParam || undefined,
      isDefaultModel,
      createdFrom,
      createdTo,
    },
  }
}

export function parseTaskIdParam(id: unknown): string {
  return String(id)
}

/**
 * Wire format of a timeline cursor: `t<toolCallId>-m<messageId>`, e.g.
 * `t106249-m90800`. Both numbers are row ids (see `TaskEventsCursor`), both
 * mandatory, both non-negative. It is meant to be copied from `nextSince`
 * and handed back, not to be constructed by a client.
 */
const TASK_EVENTS_CURSOR_PATTERN = /^t(\d{1,15})-m(\d{1,15})$/

export function formatTaskEventsCursor(cursor: TaskEventsCursor): string {
  return `t${cursor.toolCallId}-m${cursor.messageId}`
}

export function parseTaskEventsCursor(value: string): TaskEventsCursor | null {
  const match = TASK_EVENTS_CURSOR_PATTERN.exec(value)
  if (!match) return null
  const toolCallId = Number(match[1])
  const messageId = Number(match[2])
  if (!Number.isSafeInteger(toolCallId) || !Number.isSafeInteger(messageId)) return null
  return { toolCallId, messageId }
}

export interface TaskEventsQuery {
  /**
   * null means "no cursor given" — the caller returns the whole timeline,
   * byte for byte as before. There is deliberately no third state: an
   * unparsable value is a 400, never a silent fall back to everything.
   */
  since: TaskEventsCursor | null
}

export function parseTaskEventsQuery(query: Record<string, unknown>): ParseResult<TaskEventsQuery> {
  const raw = query.since
  if (raw === undefined) {
    return { ok: true, value: { since: null } }
  }

  // Present but not a single string: `?since=a&since=b` arrives as an array.
  // Guessing which one the client meant is exactly the silent fallback this
  // parameter must not have.
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Invalid since cursor. Expected one value of the form t<number>-m<number>.' }
  }

  const cursor = parseTaskEventsCursor(raw.trim())
  if (!cursor) {
    return {
      ok: false,
      // `?since=` (empty) lands here too: an empty cursor is not "no cursor".
      error: 'Invalid since cursor. Expected the nextSince value of a previous response, of the form t<number>-m<number>.',
    }
  }

  return { ok: true, value: { since: cursor } }
}


/** Upper bound of a reply text (API contract 2026-09-18, A). */
export const TASK_REPLY_MAX_LENGTH = 8000

export interface ReplyTaskInput {
  /** Trimmed, 1..8000 characters. */
  text: string
}

/**
 * Parse the body of `POST /api/tasks/:id/reply`. The text is trimmed first:
 * a body of only whitespace is an empty reply, and passing that to a paused
 * task would resume it with nothing to work on.
 */
export function parseReplyTaskBody(body: unknown): ParseResult<ReplyTaskInput> {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.text !== 'string') {
    return { ok: false, error: 'text must be a string' }
  }
  const trimmed = b.text.trim()
  if (trimmed.length === 0) {
    return { ok: false, error: 'text must not be empty' }
  }
  if (trimmed.length > TASK_REPLY_MAX_LENGTH) {
    return { ok: false, error: `text must be at most ${TASK_REPLY_MAX_LENGTH} characters` }
  }
  return { ok: true, value: { text: trimmed } }
}

export interface RestartTaskInput {
  name?: string
  prompt?: string
  provider?: string
  model?: string
  maxDurationMinutes?: number
}

/**
 * Parse and validate the body of `POST /api/tasks/:id/restart`. All fields
 * are optional — unspecified fields inherit from the original task. An empty
 * string is treated as "use original value", so the client can send the form
 * as-is without having to diff against the original.
 */
export function parseRestartTaskBody(body: unknown): ParseResult<RestartTaskInput> {
  const b = (body ?? {}) as Record<string, unknown>
  const out: RestartTaskInput = {}

  if (b.name !== undefined && b.name !== null && b.name !== '') {
    if (typeof b.name !== 'string') return { ok: false, error: 'name must be a string' }
    const trimmed = b.name.trim()
    if (trimmed.length === 0) return { ok: false, error: 'name must not be empty' }
    if (trimmed.length > 200) return { ok: false, error: 'name must be at most 200 characters' }
    out.name = trimmed
  }

  if (b.prompt !== undefined && b.prompt !== null && b.prompt !== '') {
    if (typeof b.prompt !== 'string') return { ok: false, error: 'prompt must be a string' }
    const trimmed = b.prompt.trim()
    if (trimmed.length === 0) return { ok: false, error: 'prompt must not be empty' }
    out.prompt = trimmed
  }

  if (b.provider !== undefined && b.provider !== null && b.provider !== '') {
    if (typeof b.provider !== 'string') return { ok: false, error: 'provider must be a string' }
    out.provider = b.provider.trim()
  }

  if (b.model !== undefined && b.model !== null && b.model !== '') {
    if (typeof b.model !== 'string') return { ok: false, error: 'model must be a string' }
    out.model = b.model.trim()
  }

  if (b.maxDurationMinutes !== undefined && b.maxDurationMinutes !== null) {
    const n = typeof b.maxDurationMinutes === 'number'
      ? b.maxDurationMinutes
      : Number.parseInt(String(b.maxDurationMinutes), 10)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: 'maxDurationMinutes must be a positive integer' }
    }
    out.maxDurationMinutes = n
  }

  return { ok: true, value: out }
}
