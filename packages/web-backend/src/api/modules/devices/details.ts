/**
 * On-demand details for status devices (Pi dashboard v2, PLAN-F step 3).
 *
 *   GET /api/status/task/:id     one running/finished task of the caller
 *   GET /api/status/strand/:id   one strand of the caller
 *   GET /api/status/tokens       tokens per day, last 7 days, Europe/Berlin
 *
 * Same auth as GET /api/status (device token with `status:read` from the LAN,
 * or a user JWT). Nothing here is part of the polled payload: a device asks
 * only when the user taps a row, so the 10 s poll stays small.
 *
 * Rules:
 * - Ownership first. A task or strand of another user answers 404, exactly
 *   like an unknown id, so ids cannot be probed.
 * - Privacy mode blanks every text (names, summaries, models stay out); only
 *   counts and times leave the server.
 * - Unknown is null, never 0. Progress is not recorded anywhere, so
 *   `progress` is always null with `progress_basis: 'none'`; the time budget
 *   used is reported separately and named as what it is.
 * - Tokens are the provider-reported counters (`tasks.*`, `sessions.*`,
 *   `token_usage.*`): `input` = uncached input, `cache_read` / `cache_write`
 *   separate, `output` = completion. `total` = all four.
 */
import {
  resolveTaskOwnerUserIdForTask,
  type Database,
} from '@axiom/core'
import { personaId } from '../clock-device/text.js'
import { lineText } from './status.js'

export const DETAIL_VERSION = 1
export const DETAIL_SUMMARY_MAX = 280
export const DETAIL_LIST_MAX = 4
export const DETAIL_LINE_MAX = 120
export const DETAIL_SUBTASKS_MAX = 8
export const TOKENS_DAYS = 7
export const TOKENS_TIMEZONE = 'Europe/Berlin'
export const TOKENS_COUNTING =
  'Provider-Zählung: input = ungecachte Eingabe, cache_read = aus dem Cache gelesen, '
  + 'cache_write = in den Cache geschrieben, output = Ausgabe; total = Summe aller vier. '
  + 'Zugeordnet: eigene Strands und eigene Tasks; System-Läufe (Heartbeat, Konsolidierung) zählen nicht mit. '
  + 'Gezählt werden nur gemessene Provider-Requests (token_usage.kind = request); Nebenbuchungen wie '
  + 'Sprachnotizen oder Bildgenerierung (teils lokale Schätzungen) sind ausgeschlossen. '
  + 'Ein Tag ohne Messung ist null (unbekannt), nicht 0.'

/** Ids are UUIDs (tasks) or UUID/ULID-like strand ids; nothing else is looked up. */
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export function isDetailId(raw: unknown): raw is string {
  return typeof raw === 'string' && ID_RE.test(raw)
}

/**
 * Owner of a `sessions` row, fail closed like core's strandOwnerId (agent.ts):
 * `user_id` must be a real integer, `session_user` a strict id string, and two
 * set columns must agree. Anything else is "no owner".
 */
export function sessionOwnerId(userIdColumn: unknown, sessionUserColumn: unknown): number | null {
  const strict = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null
    if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) return null
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  const hasUserId = userIdColumn !== null && userIdColumn !== undefined
  const hasSessionUser = sessionUserColumn !== null && sessionUserColumn !== undefined
  if (!hasUserId && !hasSessionUser) return null
  const a = hasUserId ? (typeof userIdColumn === 'number' ? strict(userIdColumn) : null) : undefined
  const b = hasSessionUser ? (typeof sessionUserColumn === 'string' ? strict(sessionUserColumn) : null) : undefined
  if (a === null || b === null) return null
  if (a !== undefined && b !== undefined && a !== b) return null
  return a ?? b ?? null
}

export interface TokenCounts {
  input: number
  output: number
  cache_read: number
  cache_write: number
  total: number
}

function counts(row: { p: number | null; c: number | null; cr: number | null; cw: number | null } | undefined): TokenCounts | null {
  if (!row) return null
  // Unknown is null: a row without a single numeric counter is "not measured".
  if (row.p == null && row.c == null && row.cr == null && row.cw == null) return null
  const input = Number(row.p ?? 0)
  const output = Number(row.c ?? 0)
  const cacheRead = Number(row.cr ?? 0)
  const cacheWrite = Number(row.cw ?? 0)
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, total: input + output + cacheRead + cacheWrite }
}

export function sqliteToIso(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

interface TaskDetailRow {
  id: string
  name: string
  status: string
  trigger_type: string
  trigger_source_id: string | null
  session_id: string | null
  agent_id: string | null
  model: string | null
  max_duration_minutes: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  tool_call_count: number | null
  result_summary: string | null
  result_status: string | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
}

export interface TaskSubtask {
  id: string
  name: string
  status: string
  persona: string
  started_at: string | null
  runtime_s: number | null
  tokens: TokenCounts | null
}

export interface TaskDetail {
  v: number
  kind: 'task'
  privacy: boolean
  generated_at: string
  id: string
  name: string
  persona: string
  status: string
  result_status: string | null
  model: string | null
  started_at: string | null
  completed_at: string | null
  runtime_s: number | null
  budget_minutes: number | null
  /** Share of the time budget used (0..1+). Not progress. Null without a budget or start. */
  budget_used: number | null
  /** Never estimated. Always null until a task reports real progress. */
  progress: null
  progress_basis: 'none'
  tool_calls: number | null
  tokens: TokenCounts | null
  /** Tokens of this task plus all its (recursive) subtasks. */
  tokens_with_subtasks: TokenCounts | null
  summary: string | null
  summary_source: 'result' | null
  subtasks: TaskSubtask[]
  subtasks_total: number
  subtasks_running: number
}

function runtimeSeconds(start: string | null, end: string | null, now: number): number | null {
  const s = start ? Date.parse(start) : NaN
  if (!Number.isFinite(s)) return null
  const e = end ? Date.parse(end) : now
  if (!Number.isFinite(e)) return null
  return Math.max(0, Math.round((e - s) / 1000))
}

const TASK_COLUMNS = `id, name, status, trigger_type, trigger_source_id, session_id, agent_id, model,
  max_duration_minutes, prompt_tokens, completion_tokens, cache_read, cache_write, tool_call_count,
  result_summary, result_status, created_at, started_at, completed_at`

function ownerOf(db: Database, row: TaskDetailRow): number | null {
  return resolveTaskOwnerUserIdForTask(db, {
    id: row.id,
    triggerType: row.trigger_type,
    triggerSourceId: row.trigger_source_id,
    sessionId: row.session_id,
  })
}

/**
 * All descendants (breadth first, bounded) of a task that belong to `userId`.
 *
 * Only real delegation edges are followed (`trigger_type = 'agent'`; for other
 * trigger types `trigger_source_id` is a cronjob/heartbeat id, not a task id)
 * and EVERY child is authorized on its own. A foreign, contradictory or
 * otherwise unresolvable child is dropped together with its whole branch —
 * it contributes neither text, ids, status nor token counts (review F2).
 */
function descendants(db: Database, rootId: string, userId: number, limit = 200): TaskDetailRow[] {
  const stmt = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE trigger_source_id = ? AND trigger_type = 'agent' ORDER BY COALESCE(started_at, created_at) ASC, id ASC`)
  const out: TaskDetailRow[] = []
  const queue = [rootId]
  const seen = new Set<string>([rootId])
  while (queue.length > 0 && out.length < limit) {
    const parent = queue.shift()!
    for (const row of stmt.all(parent) as TaskDetailRow[]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      if (ownerOf(db, row) !== userId) continue
      out.push(row)
      queue.push(row.id)
      if (out.length >= limit) break
    }
  }
  return out
}

function taskTokens(row: TaskDetailRow): TokenCounts | null {
  return counts({ p: row.prompt_tokens, c: row.completion_tokens, cr: row.cache_read, cw: row.cache_write })
}

export function buildTaskDetail(
  db: Database,
  input: { userId: number; privacy: boolean; taskId: string; now?: number },
): TaskDetail | null {
  const now = input.now ?? Date.now()
  const { privacy } = input
  if (!isDetailId(input.taskId)) return null
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(input.taskId) as TaskDetailRow | undefined
  if (!row || ownerOf(db, row) !== input.userId) return null

  const startedAt = sqliteToIso(row.started_at)
  const completedAt = sqliteToIso(row.completed_at)
  const runtime = runtimeSeconds(startedAt, row.status === 'running' ? null : completedAt, now)
  const budget = row.max_duration_minutes != null && row.max_duration_minutes > 0 ? row.max_duration_minutes : null
  const budgetUsed = budget != null && runtime != null ? Math.round((runtime / (budget * 60)) * 100) / 100 : null

  const children = descendants(db, row.id, input.userId)
  const direct = children.filter(child => child.trigger_source_id === row.id)
  const own = taskTokens(row)
  let withSubs: TokenCounts | null = own
  if (own) {
    withSubs = { ...own }
    for (const child of children) {
      const t = taskTokens(child)
      if (!t) continue
      withSubs.input += t.input
      withSubs.output += t.output
      withSubs.cache_read += t.cache_read
      withSubs.cache_write += t.cache_write
      withSubs.total += t.total
    }
  }
  const subtasks: TaskSubtask[] = direct.slice(-DETAIL_SUBTASKS_MAX).map(child => {
    const childStart = sqliteToIso(child.started_at)
    return {
      id: child.id,
      name: privacy ? '' : lineText(child.name, 60),
      status: child.status,
      persona: personaId(child.agent_id),
      started_at: childStart,
      runtime_s: runtimeSeconds(childStart, child.status === 'running' ? null : sqliteToIso(child.completed_at), now),
      tokens: taskTokens(child),
    }
  })
  const summary = !privacy && row.status !== 'running' && row.result_summary
    ? lineText(row.result_summary, DETAIL_SUMMARY_MAX)
    : null

  return {
    v: DETAIL_VERSION,
    kind: 'task',
    privacy,
    generated_at: new Date(now).toISOString(),
    id: row.id,
    name: privacy ? '' : lineText(row.name, 60),
    persona: personaId(row.agent_id),
    status: row.status,
    result_status: row.result_status,
    model: privacy ? null : (row.model || null),
    started_at: startedAt,
    completed_at: completedAt,
    runtime_s: runtime,
    budget_minutes: budget,
    budget_used: budgetUsed,
    progress: null,
    progress_basis: 'none',
    // The counter is written while the task runs; a task that never started has none.
    tool_calls: startedAt ? Number(row.tool_call_count ?? 0) : null,
    tokens: startedAt ? own : null,
    tokens_with_subtasks: startedAt ? withSubs : null,
    summary: summary || null,
    summary_source: summary ? 'result' : null,
    subtasks,
    subtasks_total: direct.length,
    subtasks_running: direct.filter(child => child.status === 'running').length,
  }
}

export interface StrandDetail {
  v: number
  kind: 'strand'
  privacy: boolean
  generated_at: string
  id: string
  title: string
  persona: string
  last_activity: string | null
  /** From the newest structured strand summary; null when none exists yet. */
  goal: string | null
  open: string[]
  next: string[]
  summary_at: string | null
  tokens: TokenCounts | null
  running_tasks: Array<{ id: string; name: string; started_at: string | null }>
}

function textList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .slice(0, DETAIL_LIST_MAX)
    .map(item => lineText(item, DETAIL_LINE_MAX))
}

/**
 * Strand counters without side accounting. `logTokenUsage` also adds voice
 * notes / image generations (partly local estimates) to the session counters;
 * those rows are subtracted again so only measured requests remain (review
 * F5). An inconsistent result (negative) is reported as unknown.
 */
function strandTokens(
  db: Database,
  session: { id: string; prompt_tokens: number | null; completion_tokens: number | null; cache_read: number | null; cache_write: number | null },
): TokenCounts | null {
  const base = counts({ p: session.prompt_tokens, c: session.completion_tokens, cr: session.cache_read, cw: session.cache_write })
  if (!base) return null
  const side = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c,
            COALESCE(SUM(cache_read), 0) AS cr, COALESCE(SUM(cache_write), 0) AS cw
       FROM token_usage WHERE session_id = ? AND kind <> ?`,
  ).get(session.id, TOKENS_MEASURED_KIND) as { p: number; c: number; cr: number; cw: number }
  const input = base.input - Number(side.p)
  const output = base.output - Number(side.c)
  const cacheRead = base.cache_read - Number(side.cr)
  const cacheWrite = base.cache_write - Number(side.cw)
  if (input < 0 || output < 0 || cacheRead < 0 || cacheWrite < 0) return null
  return { input, output, cache_read: cacheRead, cache_write: cacheWrite, total: input + output + cacheRead + cacheWrite }
}

export function buildStrandDetail(
  db: Database,
  input: { userId: number; privacy: boolean; strandId: string; now?: number },
): StrandDetail | null {
  const now = input.now ?? Date.now()
  const { privacy, userId } = input
  if (!isDetailId(input.strandId)) return null
  const session = db.prepare(
    `SELECT id, title, agent_id, last_activity, user_id, session_user, prompt_tokens, completion_tokens, cache_read, cache_write
       FROM sessions WHERE id = ? AND type = 'interactive'`,
  ).get(input.strandId) as {
    id: string; title: string | null; agent_id: string | null; last_activity: string | null
    user_id: unknown; session_user: unknown
    prompt_tokens: number | null; completion_tokens: number | null; cache_read: number | null; cache_write: number | null
  } | undefined
  if (!session || sessionOwnerId(session.user_id, session.session_user) !== userId) return null

  let goal: string | null = null
  let open: string[] = []
  let next: string[] = []
  let summaryAt: string | null = null
  const summaryRow = db.prepare(
    'SELECT schema_json, created_at FROM session_summaries WHERE session_id = ? ORDER BY version DESC LIMIT 1',
  ).get(session.id) as { schema_json: string; created_at: string } | undefined
  if (summaryRow && !privacy) {
    try {
      const parsed = JSON.parse(summaryRow.schema_json) as Record<string, unknown>
      goal = typeof parsed.goal === 'string' && parsed.goal.trim() ? lineText(parsed.goal, DETAIL_SUMMARY_MAX) : null
      open = textList(parsed.open)
      next = textList(parsed.next)
      summaryAt = sqliteToIso(summaryRow.created_at)
    } catch {
      // A broken summary row is "no summary", never a server error.
    }
  }

  const running = (db.prepare(
    `SELECT ${TASK_COLUMNS.replace(/(^|,\s*)(\w+)/g, '$1t.$2')} FROM tasks t JOIN sessions s ON s.id = t.session_id
      WHERE t.status = 'running' AND s.parent_session_id = ? ORDER BY COALESCE(t.started_at, t.created_at) ASC LIMIT 10`,
  ).all(session.id) as TaskDetailRow[])
    .filter(row => ownerOf(db, row) === userId)
    .map(row => ({ id: row.id, name: privacy ? '' : lineText(row.name, 60), started_at: sqliteToIso(row.started_at) }))

  return {
    v: DETAIL_VERSION,
    kind: 'strand',
    privacy,
    generated_at: new Date(now).toISOString(),
    id: session.id,
    title: privacy ? '' : lineText(session.title || 'Ohne Titel', 60),
    persona: personaId(session.agent_id),
    last_activity: sqliteToIso(session.last_activity),
    goal,
    open,
    next,
    summary_at: summaryAt,
    tokens: strandTokens(db, session),
    running_tasks: running,
  }
}

/** Only `kind = 'request'` rows are real, provider-reported request counts. */
export const TOKENS_MEASURED_KIND = 'request'

export interface TokenDay {
  /** Calendar day in Europe/Berlin, YYYY-MM-DD. */
  day: string
  /** True when at least one measured request row exists for this day. */
  measured: boolean
  /** All counters are null when the day has no measured row (unknown, not 0). */
  input: number | null
  output: number | null
  cache_read: number | null
  cache_write: number | null
  total: number | null
}

export interface TokensReport {
  v: number
  kind: 'tokens'
  generated_at: string
  timezone: string
  counting: string
  /** Which `token_usage.kind` values are counted; everything else is excluded. */
  measured_kinds: string[]
  /** Number of days (of the seven) with at least one measured row. */
  measured_days: number
  days: TokenDay[]
  /** Null when no day in the window has a measured row. */
  total: TokenCounts | null
}

/** YYYY-MM-DD shifted by whole calendar days (pure date arithmetic, no clock time). */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10)
}

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: TOKENS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

export function berlinDayOf(ms: number): string {
  return berlinDay.format(new Date(ms))
}

/**
 * Tokens per Berlin calendar day, today and the six days before. Rows are
 * grouped in SQL by session and UTC hour (Berlin is a whole-hour offset), so
 * the day split is exact across DST without loading single rows.
 */
export function buildTokensReport(db: Database, input: { userId: number; now?: number }): TokensReport {
  const now = input.now ?? Date.now()
  // Calendar days: today's Berlin date, then whole-day steps on the DATE
  // itself. Subtracting 24 h from the clock skipped a day after the spring
  // DST switch (review F6).
  const today = berlinDayOf(now)
  const days: string[] = []
  for (let i = TOKENS_DAYS - 1; i >= 0; i--) days.push(shiftDay(today, -i))
  // Earliest possible UTC instant of the first Berlin day (Berlin is UTC+1/+2).
  const fromMs = Date.parse(`${days[0]}T00:00:00Z`) - 2 * 3_600_000
  const from = new Date(fromMs).toISOString().slice(0, 19).replace('T', ' ')

  const rows = db.prepare(
    `SELECT t.session_id AS sid, substr(t.timestamp, 1, 13) AS hour, s.type AS type,
            s.user_id AS uid, s.session_user AS suser,
            SUM(t.prompt_tokens) AS p, SUM(t.completion_tokens) AS c, SUM(t.cache_read) AS cr, SUM(t.cache_write) AS cw
       FROM token_usage t LEFT JOIN sessions s ON s.id = t.session_id
      WHERE t.timestamp >= ? AND t.kind = ?
      GROUP BY t.session_id, hour`,
  ).all(from, TOKENS_MEASURED_KIND) as Array<{ sid: string | null; hour: string; type: string | null; uid: unknown; suser: unknown; p: number; c: number; cr: number; cw: number }>

  const taskBySession = db.prepare(
    'SELECT id, trigger_type, trigger_source_id, session_id FROM tasks WHERE session_id = ? LIMIT 1',
  )
  const ownerCache = new Map<string, boolean>()
  const isOwn = (row: typeof rows[number]): boolean => {
    if (!row.sid) return false
    const cached = ownerCache.get(row.sid)
    if (cached !== undefined) return cached
    let own = false
    if (row.type === 'interactive') {
      own = sessionOwnerId(row.uid, row.suser) === input.userId
    } else if (row.type === 'task') {
      const task = taskBySession.get(row.sid) as { id: string; trigger_type: string; trigger_source_id: string | null; session_id: string } | undefined
      own = !!task && resolveTaskOwnerUserIdForTask(db, {
        id: task.id, triggerType: task.trigger_type, triggerSourceId: task.trigger_source_id, sessionId: task.session_id,
      }) === input.userId
    }
    ownerCache.set(row.sid, own)
    return own
  }

  const byDay = new Map<string, TokenCounts>()
  for (const row of rows) {
    if (!isOwn(row)) continue
    const ms = Date.parse(`${row.hour.replace(' ', 'T')}:00:00Z`)
    if (!Number.isFinite(ms)) continue
    const label = berlinDayOf(ms)
    if (!days.includes(label)) continue
    const bucket = byDay.get(label) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 }
    bucket.input += Number(row.p ?? 0)
    bucket.output += Number(row.c ?? 0)
    bucket.cache_read += Number(row.cr ?? 0)
    bucket.cache_write += Number(row.cw ?? 0)
    bucket.total = bucket.input + bucket.output + bucket.cache_read + bucket.cache_write
    byDay.set(label, bucket)
  }
  let total: TokenCounts | null = null
  const list: TokenDay[] = days.map(day => {
    const d = byDay.get(day)
    if (!d) return { day, measured: false, input: null, output: null, cache_read: null, cache_write: null, total: null }
    total ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 }
    total.input += d.input
    total.output += d.output
    total.cache_read += d.cache_read
    total.cache_write += d.cache_write
    total.total += d.total
    return { day, measured: true, ...d }
  })
  return {
    v: DETAIL_VERSION,
    kind: 'tokens',
    generated_at: new Date(now).toISOString(),
    timezone: TOKENS_TIMEZONE,
    counting: TOKENS_COUNTING,
    measured_kinds: [TOKENS_MEASURED_KIND],
    measured_days: list.filter(d => d.measured).length,
    days: list,
    total,
  }
}
