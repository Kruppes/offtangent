/**
 * Strand statistics (`GET /api/strands/:id/stats`, schema `strand_stats.v1`).
 *
 * One read over the strand (main chat session) and its task tree: tokens and
 * API-equivalent cost split into chat and tasks, models with their billing,
 * personas (the strand persona as one row with a chat/tasks split), tools,
 * the sub-agent runs, autarky (how long the agent worked on its own) and the
 * per-turn series for the sparkline.
 *
 * Turns come from `strand_turns` where they were recorded; everything older
 * is reconstructed from message timestamps and flagged `estimated`. The
 * response is flat, versioned and carries raw numbers and ISO times only, so
 * the companion app can read the same route without a second schema.
 *
 * Read-only: no writes, no migrations here (they live in @axiom/core).
 */
import type { Database, BillingKind } from '@axiom/core'
import { activeStrandTurnId, billingForProvider, billingMapping, lastStrandTurnActivityMs, NON_WORK_TOOL_NAMES } from '@axiom/core'

export const STRAND_STATS_SCHEMA = 'strand_stats.v1'
export const AUTARKY_DEFINITION = 'union_turns_tasks.v1'

export interface StrandStatsOptions {
  includeTasks?: boolean
  includeSeries?: boolean
  /** Override "now" (tests). Epoch seconds. */
  now?: number
  /** Provider → billing mapping override (tests); defaults to the configured mapping. */
  billing?: Record<string, BillingKind>
  /**
   * Is this open turn really running in THIS process? Defaults to the core
   * active-turn registry. An open row that is not active (its process died)
   * is capped at its last evidenced activity instead of counting up to now.
   */
  isTurnActive?: (turnId: string, sessionId: string) => boolean
}

export interface TokenBucket {
  requests: number
  uncached: number
  cacheRead: number
  cacheWrite: number
  out: number
  /** uncached + cacheRead + cacheWrite */
  in: number
  cacheHitRatio: number | null
  costUsd: number
}

/**
 * One row per provider + model + billing class: a model that was used both
 * per subscription and metered (the mapping is configurable and stored per
 * usage row) appears twice, once per class, instead of being folded into one.
 */
export interface StrandStatsModel {
  provider: string
  model: string
  billing: BillingKind
  requests: number
  tokensIn: number
  tokensOut: number
  cacheHitRatio: number | null
  costUsd: number
  costMainUsd: number
  costTasksUsd: number
}

export interface PersonaPart {
  runs: number
  durationSec: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface StrandStatsPersona extends PersonaPart {
  id: string
  isStrandPersona: boolean
  ok: number
  failed: number
  running: number
  successRatio: number | null
  models: string[]
  /** Only for the strand persona: the same totals split into its chat and its own tasks. */
  split: { chat: PersonaPart; tasks: PersonaPart } | null
}

export interface StrandStatsTool {
  name: string
  calls: number
  callsMain: number
  errors: number
  avgMs: number
}

export interface StrandStatsTask {
  id: string
  name: string
  persona: string
  delegatedBy: string | null
  provider: string | null
  model: string | null
  status: string
  resultStatus: string | null
  depth: number
  parentId: string | null
  startedAt: string
  endedAt: string | null
  durationSec: number
  costUsd: number
  tokensIn: number
  tokensOut: number
  toolCalls: number
  toolErrors: number
}

export interface StrandStatsSeriesPoint {
  at: string
  kind: 'user' | 'task_result' | 'system'
  maxRequestTokens: number
  out: number
  requests: number
  durationSec: number
}

export interface StrandStats {
  schema: typeof STRAND_STATS_SCHEMA
  strandId: string
  asOf: string
  persona: string
  contextWindow: number | null
  span: { firstAt: string; lastAt: string; wallSec: number }
  prompts: { total: number; typed: number; voice: number; answers: number }
  turns: { user: number; auto: number; source: 'recorded' | 'estimated' | 'mixed'; recorded: number; estimated: number; interrupted: number }
  /**
   * `voice`: side accounting of the strand itself (voice notes, image
   * renders). `background`: one-shot background calls booked on the strand
   * (fact extraction, session summary, ...; kind `background`). `total`
   * includes both.
   */
  tokens: { main: TokenBucket; tasks: TokenBucket; voice: TokenBucket; background: TokenBucket; total: TokenBucket }
  cost: { currency: 'USD'; basis: 'api_equivalent'; totalUsd: number; subscriptionUsd: number; meteredUsd: number; localUsd: number; subscriptionShare: number | null }
  models: StrandStatsModel[]
  local: { requests: number; requestShare: number; tokenShare: number }
  personas: StrandStatsPersona[]
  tools: { main: number; total: number; errors: number; distinct: number; top: StrandStatsTool[] }
  taskCount: number
  taskStatus: { completed: number; failed: number; running: number; paused: number }
  nestedTasks: number
  delegations: { task: number; askAgent: number }
  autarky: {
    agentSec: number
    effortSec: number
    mainSec: number
    tasksSec: number
    longestSec: number
    longestAfter: string | null
    perPromptSec: number | null
    latencyMedianSec: number | null
    parallelPeak: number
    wallSec: number
    estimated: boolean
    definition: typeof AUTARKY_DEFINITION
  }
  compaction: { summaries: number; trimmedTurns: number; trimmedMessages: number; lastKeptTokens: number | null; budgetTokens: number | null }
  failedRequests: number
  tasks?: StrandStatsTask[]
  series?: StrandStatsSeriesPoint[]
}

// ---------------------------------------------------------------------------
// helpers

/** SQLite `datetime('now')` text ("YYYY-MM-DD HH:MM:SS", UTC) or ISO → epoch seconds. */
export function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null
  const s = value.includes('T') ? value : value.replace(' ', 'T')
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms / 1000 : null
}

function iso(sec: number): string {
  return new Date(Math.round(sec * 1000)).toISOString()
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/** Union of [start, end) intervals; overlapping or nested parts count once. */
export function unionIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

export function intervalSum(intervals: Array<[number, number]>): number {
  return intervals.reduce((s, [a, b]) => s + Math.max(0, b - a), 0)
}

/** Highest number of intervals open at the same moment. */
export function parallelPeak(intervals: Array<[number, number]>): number {
  const ev: Array<[number, number]> = []
  for (const [a, b] of intervals) if (b > a) { ev.push([a, 1]); ev.push([b, -1]) }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  let cur = 0, peak = 0
  for (const [, d] of ev) { cur += d; peak = Math.max(peak, cur) }
  return peak
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

interface UsageAgg { n: number; p: number; c: number; cr: number; cw: number; cost: number }

function bucket(rows: UsageAgg[]): TokenBucket {
  const b = { requests: 0, uncached: 0, cacheRead: 0, cacheWrite: 0, out: 0, costUsd: 0 }
  for (const r of rows) {
    b.requests += r.n; b.uncached += r.p; b.cacheRead += r.cr; b.cacheWrite += r.cw; b.out += r.c; b.costUsd += r.cost
  }
  const input = b.uncached + b.cacheRead + b.cacheWrite
  return { ...b, in: input, cacheHitRatio: input ? b.cacheRead / input : null, costUsd: round4(b.costUsd) }
}

/** Bound-parameter lists stay well below SQLite's variable limit on wide task trees. */
const IN_CHUNK = 500
function chunks<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',')
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column)
}

interface TaskRow {
  id: string
  name: string
  status: string
  result_status: string | null
  trigger_source_id: string | null
  provider: string | null
  model: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  session_id: string | null
  agent_id: string | null
  delegated_by: string | null
}

/** All tasks of a strand: tasks whose session hangs off the strand, plus their sub-tasks (any depth). */
function taskTree(db: Database, strandId: string): Map<string, TaskRow & { parent: string | null; depth: number }> {
  const cols = 'id, name, status, result_status, trigger_source_id, provider, model, created_at, started_at, completed_at, session_id, agent_id, delegated_by'
  const rows = new Map<string, TaskRow & { parent: string | null; depth: number }>()
  const direct = db.prepare(`SELECT ${cols.split(', ').map(c => `t.${c}`).join(', ')} FROM tasks t JOIN sessions s ON s.id = t.session_id WHERE s.parent_session_id = ?`).all(strandId) as TaskRow[]
  for (const r of direct) rows.set(r.id, { ...r, parent: null, depth: 0 })
  let frontier = [...rows.keys()]
  for (let guard = 0; frontier.length > 0 && guard < 10; guard++) {
    const kids = chunks(frontier).flatMap(part =>
      db.prepare(`SELECT ${cols} FROM tasks WHERE trigger_source_id IN (${placeholders(part.length)})`).all(...part) as TaskRow[])
    frontier = []
    for (const k of kids) {
      if (!rows.has(k.id)) { rows.set(k.id, { ...k, parent: null, depth: 0 }); frontier.push(k.id) }
    }
  }
  const sessionToTask = new Map<string, string>()
  for (const r of rows.values()) if (r.session_id) sessionToTask.set(r.session_id, r.id)
  const parentSession = db.prepare('SELECT parent_session_id AS p FROM sessions WHERE id = ?')
  for (const r of rows.values()) {
    let p = r.trigger_source_id && rows.has(r.trigger_source_id) ? r.trigger_source_id : null
    if (!p && r.session_id) {
      const ps = parentSession.get(r.session_id) as { p: string | null } | undefined
      p = ps?.p ? sessionToTask.get(ps.p) ?? null : null
    }
    r.parent = p
  }
  for (const r of rows.values()) {
    let d = 0, c = r.parent
    while (c && d < 10) { d++; c = rows.get(c)?.parent ?? null }
    r.depth = d
  }
  return rows
}

interface Turn { start: number; end: number; kind: 'user' | 'task_result' | 'system'; firstToken: number | null; recorded: boolean; interrupted?: boolean }

// ---------------------------------------------------------------------------

export function computeStrandStats(db: Database, strandId: string, options: StrandStatsOptions = {}): StrandStats {
  const now = options.now ?? Date.now() / 1000
  const mapping = options.billing ?? billingMapping()
  const billingOf = (provider: string, stored: string | null | undefined): BillingKind =>
    stored === 'subscription' || stored === 'metered' || stored === 'local' ? stored : billingForProvider(provider, mapping)

  const session = db.prepare('SELECT id, agent_id, started_at, model_id FROM sessions WHERE id = ?').get(strandId) as
    { id: string; agent_id: string | null; started_at: string; model_id: string | null } | undefined
  if (!session) throw new Error('strand not found')
  const strandPersona = session.agent_id || 'main'

  const msgs = db.prepare('SELECT id, role, timestamp, metadata FROM chat_messages WHERE session_id = ? ORDER BY id').all(strandId) as
    Array<{ id: number; role: string; timestamp: string; metadata: string | null }>

  // ---- prompts
  const prompts: Array<{ t: number; kind: 'typed' | 'voice' | 'answer' }> = []
  for (const m of msgs) {
    if (m.role !== 'user') continue
    let md: Record<string, unknown> = {}
    try { md = m.metadata ? JSON.parse(m.metadata) as Record<string, unknown> : {} } catch { md = {} }
    const files = Array.isArray(md.files) ? md.files as Array<{ originalName?: unknown }> : []
    const kind = md.type === 'interaction_answer' ? 'answer'
      : md.inputMode === 'voice' || files.some(f => String(f?.originalName ?? '').startsWith('recording-')) ? 'voice' : 'typed'
    prompts.push({ t: parseDbTime(m.timestamp)!, kind })
  }

  // ---- main requests
  const hasBillingCol = hasColumn(db, 'token_usage', 'billing')
  const reqs = db.prepare(`SELECT timestamp, provider, model, prompt_tokens p, completion_tokens c, cache_read cr, cache_write cw,
      estimated_cost cost, kind${hasBillingCol ? ', billing' : ''} FROM token_usage WHERE session_id = ? ORDER BY id`).all(strandId) as
    Array<{ timestamp: string; provider: string; model: string; p: number; c: number; cr: number; cw: number; cost: number; kind: string; billing?: string | null }>
  const isWork = (r: { p: number; c: number; cr: number; cw: number }) => r.p + r.c + r.cr + r.cw > 0
  const failedRequests = reqs.filter(r => r.kind === 'request' && !isWork(r)).length
  const activity = [
    ...reqs.filter(r => r.kind === 'request' && isWork(r)).map(r => parseDbTime(r.timestamp)!),
    ...msgs.filter(m => m.role === 'assistant' || m.role === 'tool').map(m => parseDbTime(m.timestamp)!),
  ].sort((a, b) => a - b)

  // ---- turns: recorded rows first, estimation only before the first recorded turn
  const recordedRows = hasColumn(db, 'strand_turns', 'id')
    ? db.prepare('SELECT id, trigger, started_at, first_token_at, ended_at, status FROM strand_turns WHERE session_id = ? ORDER BY started_at').all(strandId) as
      Array<{ id: string; trigger: string; started_at: string; first_token_at: string | null; ended_at: string | null; status: string }>
    : []
  const recordedFrom = recordedRows.length ? parseDbTime(recordedRows[0]!.started_at)! : Infinity

  const triggers: Array<[number, 'user' | 'task_result']> = prompts.map(p => [p.t, 'user'])
  for (const m of msgs) {
    if (m.role === 'system' && m.metadata && m.metadata.includes('"task_result"')) triggers.push([parseDbTime(m.timestamp)!, 'task_result'])
  }
  triggers.sort((a, b) => a[0] - b[0])
  const turns: Turn[] = []
  for (let i = 0; i < triggers.length; i++) {
    const [t0, kind] = triggers[i]!
    if (t0 >= recordedFrom) break
    const t1 = Math.min(i + 1 < triggers.length ? triggers[i + 1]![0] : Infinity, recordedFrom)
    let end = -Infinity
    for (const a of activity) if (a >= t0 && a < t1 && a > end) end = a
    if (end === -Infinity) continue
    turns.push({ start: t0, end, kind, firstToken: null, recorded: false })
  }
  const estimatedTurns = turns.length
  const isTurnActive = options.isTurnActive ?? ((turnId: string, sessionId: string) => activeStrandTurnId(sessionId) === turnId)
  for (const r of recordedRows) {
    const start = parseDbTime(r.started_at)!
    let end = parseDbTime(r.ended_at)
    // Closed at boot as interrupted: the end is the last evidence, an estimate.
    let interrupted = r.status === 'interrupted'
    if (end === null) {
      if (isTurnActive(r.id, strandId)) end = now
      else {
        // Open row without a live runner (process died, boot cleanup not yet
        // run): cap at the last evidenced activity so it does not grow with the clock.
        const last = lastStrandTurnActivityMs(db, { id: r.id, session_id: strandId, started_at: r.started_at })
        end = Math.min(now, last === null ? start : last / 1000)
        interrupted = true
      }
    }
    turns.push({
      interrupted,
      start, end,
      kind: r.trigger === 'task_injection' ? 'task_result' : r.trigger === 'system' ? 'system' : 'user',
      firstToken: parseDbTime(r.first_token_at),
      recorded: true,
    })
  }
  turns.sort((a, b) => a.start - b.start)

  // ---- tasks
  const tree = taskTree(db, strandId)
  const taskSessions = [...tree.values()].map(r => r.session_id).filter((s): s is string => !!s)
  const internal = [...NON_WORK_TOOL_NAMES]
  const tuPerSession = db.prepare(`SELECT count(*) FILTER (WHERE kind != 'background') n, coalesce(sum(prompt_tokens),0) p, coalesce(sum(completion_tokens),0) c,
      coalesce(sum(cache_read),0) cr, coalesce(sum(cache_write),0) cw, coalesce(sum(estimated_cost),0) cost, max(timestamp) last
      FROM token_usage WHERE session_id = ?`)
  const tcPerSession = db.prepare(`SELECT count(*) n, coalesce(sum(status = 'error'),0) e FROM tool_calls
      WHERE session_id = ? AND tool_name NOT IN (${placeholders(internal.length)})`)
  const tcErrMsgs = db.prepare(`SELECT count(*) n FROM chat_messages WHERE session_id = ? AND role = 'tool'
      AND json_valid(metadata) AND json_extract(metadata, '$.toolIsError') = 1`)
  const tasks: Array<StrandStatsTask & { start: number; end: number; running: boolean }> = []
  for (const r of [...tree.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const st = parseDbTime(r.started_at ?? r.created_at)!
    const running = r.status === 'running' || r.status === 'paused'
    const tu = r.session_id ? tuPerSession.get(r.session_id) as UsageAgg & { last: string | null } : { n: 0, p: 0, c: 0, cr: 0, cw: 0, cost: 0, last: null }
    let en = parseDbTime(r.completed_at)
    const endedAt = en
    if (en === null) en = running ? now : (parseDbTime(tu.last) ?? st)
    const tc = r.session_id ? tcPerSession.get(r.session_id, ...internal) as { n: number; e: number } : { n: 0, e: 0 }
    const tce = r.session_id ? (tcErrMsgs.get(r.session_id) as { n: number }).n : 0
    tasks.push({
      id: r.id, name: r.name, persona: r.agent_id || 'main', delegatedBy: r.delegated_by,
      provider: r.provider, model: r.model, status: r.status, resultStatus: r.result_status,
      depth: r.depth, parentId: r.parent,
      startedAt: iso(st), endedAt: endedAt === null ? null : iso(endedAt), durationSec: Math.round(en - st),
      costUsd: round4(tu.cost), tokensIn: tu.p + tu.cr + tu.cw, tokensOut: tu.c,
      toolCalls: tc.n, toolErrors: Math.max(tc.e, tce),
      start: st, end: en, running,
    })
  }

  // ---- tokens by scope / model
  // Chunked on wide trees; a group may then appear once per chunk, which is
  // fine: every consumer below sums the rows.
  const grouped = (sessions: string[]) => chunks(sessions).flatMap(part => db.prepare(`SELECT provider, model, kind,
      ${hasBillingCol ? 'billing' : 'NULL'} AS billing, count(*) n, sum(prompt_tokens) p, sum(completion_tokens) c, sum(cache_read) cr,
      sum(cache_write) cw, sum(estimated_cost) cost FROM token_usage WHERE session_id IN (${placeholders(part.length)})
      GROUP BY 1, 2, 3, 4`).all(...part) as Array<UsageAgg & { provider: string; model: string; kind: string; billing: string | null }>)
  const mainRows = grouped([strandId])
  const taskRows = grouped(taskSessions)
  const main = bucket(mainRows.filter(r => r.kind === 'request'))
  const voice = bucket(mainRows.filter(r => r.kind !== 'request' && r.kind !== 'background'))
  const background = bucket(mainRows.filter(r => r.kind === 'background'))
  const tasksBucket = { ...bucket(taskRows), requests: taskRows.filter(r => r.kind !== 'background').reduce((n, r) => n + r.n, 0) }
  const total = bucket([...mainRows, ...taskRows])

  const byModel = new Map<string, StrandStatsModel & { cr: number }>()
  for (const [scope, rows] of [['main', mainRows], ['tasks', taskRows]] as const) {
    for (const r of rows) {
      // Billing class is part of the key: folding a model's subscription and
      // metered/local rows into one entry would let the order of the SQL
      // groups decide the class of the whole model.
      const billing = billingOf(r.provider, r.billing)
      const key = `${r.provider}\u0000${r.model}\u0000${billing}`
      let e = byModel.get(key)
      if (!e) {
        e = { provider: r.provider, model: r.model, billing, requests: 0, tokensIn: 0, tokensOut: 0, cacheHitRatio: null, costUsd: 0, costMainUsd: 0, costTasksUsd: 0, cr: 0 }
        byModel.set(key, e)
      }
      e.requests += r.n; e.tokensIn += r.p + r.cr + r.cw; e.tokensOut += r.c; e.cr += r.cr; e.costUsd += r.cost
      if (scope === 'main') e.costMainUsd += r.cost
      else e.costTasksUsd += r.cost
    }
  }
  const models: StrandStatsModel[] = [...byModel.values()].map(({ cr, ...e }) => ({
    ...e,
    cacheHitRatio: e.tokensIn ? cr / e.tokensIn : null,
    costUsd: round4(e.costUsd), costMainUsd: round4(e.costMainUsd), costTasksUsd: round4(e.costTasksUsd),
  })).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests)

  const sumBy = (pred: (m: StrandStatsModel) => boolean, f: (m: StrandStatsModel) => number) => models.filter(pred).reduce((s, m) => s + f(m), 0)
  const all = () => true
  const isLocal = (m: StrandStatsModel) => m.billing === 'local'
  const totTok = sumBy(all, m => m.tokensIn + m.tokensOut)
  const totReq = sumBy(all, m => m.requests)
  const localReq = sumBy(isLocal, m => m.requests)
  const costTotal = sumBy(all, m => m.costUsd)
  const subscriptionUsd = sumBy(m => m.billing === 'subscription', m => m.costUsd)

  // ---- personas
  const mainSec = intervalSum(turns.map(t => [t.start, t.end]))
  const emptyPart = (): PersonaPart => ({ runs: 0, durationSec: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 })
  const personaMap = new Map<string, StrandStatsPersona & { modelSet: Set<string> }>()
  const persona = (id: string) => {
    let e = personaMap.get(id)
    if (!e) {
      e = { id, isStrandPersona: id === strandPersona, ...emptyPart(), ok: 0, failed: 0, running: 0, successRatio: null, models: [], split: null, modelSet: new Set() }
      personaMap.set(id, e)
    }
    return e
  }
  const sp = persona(strandPersona)
  const chatPart: PersonaPart = { runs: 0, durationSec: Math.round(mainSec), tokensIn: main.in, tokensOut: main.out, costUsd: main.costUsd }
  const ownTasksPart = emptyPart()
  for (const r of mainRows) sp.modelSet.add(r.model)
  for (const t of tasks) {
    const e = persona(t.persona)
    e.runs += 1; e.durationSec += t.durationSec; e.tokensIn += t.tokensIn; e.tokensOut += t.tokensOut; e.costUsd += t.costUsd
    if (t.status === 'completed') e.ok += 1
    if (t.status === 'failed') e.failed += 1
    if (t.running) e.running += 1
    if (t.model) e.modelSet.add(t.model)
    if (t.persona === strandPersona) {
      ownTasksPart.runs += 1; ownTasksPart.durationSec += t.durationSec; ownTasksPart.tokensIn += t.tokensIn
      ownTasksPart.tokensOut += t.tokensOut; ownTasksPart.costUsd += t.costUsd
    }
  }
  sp.durationSec += chatPart.durationSec; sp.tokensIn += chatPart.tokensIn; sp.tokensOut += chatPart.tokensOut; sp.costUsd += chatPart.costUsd
  sp.split = { chat: chatPart, tasks: { ...ownTasksPart, costUsd: round4(ownTasksPart.costUsd) } }
  const personas: StrandStatsPersona[] = [...personaMap.values()].map(({ modelSet, ...e }) => {
    const fin = e.ok + e.failed
    return { ...e, costUsd: round4(e.costUsd), durationSec: Math.round(e.durationSec), models: [...modelSet].sort(), successRatio: fin ? e.ok / fin : null }
  }).sort((a, b) => Number(b.isStrandPersona) - Number(a.isStrandPersona) || b.costUsd - a.costUsd)

  // ---- tools
  const scopeSessions = [strandId, ...taskSessions]
  const toolRows = db.prepare(`SELECT tool_name name, count(*) n, coalesce(sum(status = 'error'),0) e, avg(duration_ms) avg_ms,
      coalesce(sum(session_id = ?),0) n_main FROM tool_calls WHERE session_id IN (${placeholders(scopeSessions.length)})
      AND tool_name NOT IN (${placeholders(internal.length)}) GROUP BY 1 ORDER BY n DESC, name`).all(strandId, ...scopeSessions, ...internal) as
    Array<{ name: string; n: number; e: number; avg_ms: number | null; n_main: number }>
  const errRows = db.prepare(`SELECT json_extract(metadata, '$.toolName') name, count(*) c FROM chat_messages WHERE role = 'tool'
      AND session_id IN (${placeholders(scopeSessions.length)}) AND json_valid(metadata) AND json_extract(metadata, '$.toolIsError') = 1 GROUP BY 1`)
    .all(...scopeSessions) as Array<{ name: string | null; c: number }>
  const errMap = new Map(errRows.map(r => [r.name ?? '', r.c]))
  const toolList: StrandStatsTool[] = toolRows.map(t => ({
    name: t.name, calls: t.n, callsMain: t.n_main, errors: Math.max(t.e, errMap.get(t.name) ?? 0), avgMs: Math.round(t.avg_ms ?? 0),
  }))

  // ---- delegations
  const dele = hasColumn(db, 'persona_delegations', 'kind')
    ? db.prepare(`SELECT kind FROM persona_delegations WHERE session_id = ?${hasColumn(db, 'persona_delegations', 'origin_session_id') ? ' OR origin_session_id = ?' : ''}`)
      .all(...(hasColumn(db, 'persona_delegations', 'origin_session_id') ? [strandId, strandId] : [strandId])) as Array<{ kind: string }>
    : []
  const askToolCalls = (db.prepare(`SELECT count(*) n FROM tool_calls WHERE session_id = ? AND tool_name = 'ask_agent'`).get(strandId) as { n: number }).n

  // ---- compaction
  const sc = db.prepare(`SELECT json_extract(input, '$.keptTokens') kept, json_extract(input, '$.budgetTokens') budget,
      coalesce(json_extract(input, '$.trimmed'), 0) trimmed FROM tool_calls WHERE session_id = ? AND tool_name = 'strand_context'
      AND json_valid(input) ORDER BY id`).all(strandId) as Array<{ kept: number | null; budget: number | null; trimmed: number }>
  const summaries = (db.prepare('SELECT count(*) n FROM session_summaries WHERE session_id = ?').get(strandId) as { n: number }).n

  // ---- autarky
  const mainIv = turns.map(t => [t.start, t.end] as [number, number])
  const taskIv = tasks.map(t => [t.start, t.end] as [number, number])
  const union = unionIntervals([...mainIv, ...taskIv])
  const agentSec = intervalSum(union)
  const effortSec = intervalSum(mainIv) + intervalSum(taskIv)
  const ptimes = prompts.map(p => p.t)
  let longest = 0, longestAfter: number | null = null
  for (let i = 0; i < ptimes.length; i++) {
    const a = ptimes[i]!, b = i + 1 < ptimes.length ? ptimes[i + 1]! : Infinity
    const act = union.reduce((s, [x, y]) => s + Math.max(0, Math.min(y, b) - Math.max(x, a)), 0)
    if (act > longest) { longest = act; longestAfter = a }
  }
  // Latency: recorded turns measure prompt → first token; older prompts fall
  // back to prompt → first assistant row.
  const assistantTimes = msgs.filter(m => m.role === 'assistant').map(m => parseDbTime(m.timestamp)!).sort((a, b) => a - b)
  const latencies: number[] = []
  for (const p of prompts) {
    if (p.t >= recordedFrom) continue
    const nxt = assistantTimes.find(t => t >= p.t)
    if (nxt !== undefined) latencies.push(nxt - p.t)
  }
  for (const t of turns) if (t.recorded && t.kind === 'user' && t.firstToken !== null) latencies.push(t.firstToken - t.start)

  const first = Math.min(parseDbTime(session.started_at) ?? Infinity, ...ptimes)
  const last = Math.max(first, ...activity, ...tasks.map(t => t.end), ...turns.map(t => t.end))
  const recordedCount = turns.filter(t => t.recorded).length
  const interruptedTurns = turns.filter(t => t.interrupted).length

  const contextWindow = hasColumn(db, 'token_usage', 'context_window')
    ? (db.prepare('SELECT context_window cw FROM token_usage WHERE session_id = ? AND context_window IS NOT NULL ORDER BY id DESC LIMIT 1').get(strandId) as { cw: number } | undefined)?.cw ?? null
    : null

  const stats: StrandStats = {
    schema: STRAND_STATS_SCHEMA,
    strandId,
    asOf: iso(now),
    persona: strandPersona,
    contextWindow,
    span: { firstAt: iso(first), lastAt: iso(last), wallSec: Math.round(last - first) },
    prompts: {
      total: prompts.length,
      typed: prompts.filter(p => p.kind === 'typed').length,
      voice: prompts.filter(p => p.kind === 'voice').length,
      answers: prompts.filter(p => p.kind === 'answer').length,
    },
    turns: {
      user: turns.filter(t => t.kind === 'user').length,
      auto: turns.filter(t => t.kind !== 'user').length,
      source: recordedCount === 0 ? 'estimated' : estimatedTurns === 0 ? 'recorded' : 'mixed',
      recorded: recordedCount,
      estimated: estimatedTurns,
      interrupted: interruptedTurns,
    },
    tokens: { main, tasks: tasksBucket, voice, background, total },
    cost: {
      currency: 'USD', basis: 'api_equivalent',
      totalUsd: round4(costTotal),
      subscriptionUsd: round4(subscriptionUsd),
      meteredUsd: round4(sumBy(m => m.billing === 'metered', m => m.costUsd)),
      localUsd: 0,
      subscriptionShare: costTotal > 0 ? subscriptionUsd / costTotal : null,
    },
    models,
    local: {
      requests: localReq,
      requestShare: totReq ? localReq / totReq : 0,
      tokenShare: totTok ? sumBy(isLocal, m => m.tokensIn + m.tokensOut) / totTok : 0,
    },
    personas,
    tools: {
      main: toolRows.reduce((s, t) => s + t.n_main, 0),
      total: toolRows.reduce((s, t) => s + t.n, 0),
      errors: toolList.reduce((s, t) => s + t.errors, 0),
      distinct: toolList.length,
      top: toolList.slice(0, 10),
    },
    taskCount: tasks.length,
    taskStatus: {
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      running: tasks.filter(t => t.status === 'running').length,
      paused: tasks.filter(t => t.status === 'paused').length,
    },
    nestedTasks: tasks.filter(t => t.depth > 0).length,
    delegations: { task: dele.filter(d => d.kind === 'task').length, askAgent: Math.max(dele.filter(d => d.kind === 'ask_agent').length, askToolCalls) },
    autarky: {
      agentSec: Math.round(agentSec),
      effortSec: Math.round(effortSec),
      mainSec: Math.round(intervalSum(unionIntervals(mainIv))),
      tasksSec: Math.round(intervalSum(unionIntervals(taskIv))),
      longestSec: Math.round(longest),
      longestAfter: longestAfter === null ? null : iso(longestAfter),
      perPromptSec: prompts.length ? Math.round(agentSec / prompts.length) : null,
      latencyMedianSec: latencies.length ? Math.round(median(latencies)!) : null,
      parallelPeak: parallelPeak(taskIv),
      wallSec: Math.round(last - first),
      estimated: estimatedTurns > 0 || interruptedTurns > 0,
      definition: AUTARKY_DEFINITION,
    },
    compaction: {
      summaries,
      trimmedTurns: sc.filter(r => (r.trimmed ?? 0) > 0).length,
      trimmedMessages: sc.reduce((s, r) => s + (Number(r.trimmed) || 0), 0),
      lastKeptTokens: sc.length ? sc[sc.length - 1]!.kept : null,
      budgetTokens: sc.length ? sc[sc.length - 1]!.budget : null,
    },
    failedRequests,
  }

  if (options.includeTasks) {
    stats.tasks = tasks.map(({ start: _s, end: _e, running: _r, ...t }) => t)
  }
  if (options.includeSeries) {
    const reqSeries = reqs.filter(r => r.kind === 'request').map(r => ({ t: parseDbTime(r.timestamp)!, req: r.p + r.cr + r.cw, out: r.c }))
    const series: StrandStatsSeriesPoint[] = []
    for (const t of turns) {
      const rr = reqSeries.filter(x => x.t >= t.start && x.t <= t.end)
      if (rr.length === 0) continue
      series.push({
        at: iso(t.start), kind: t.kind,
        maxRequestTokens: Math.max(...rr.map(x => x.req)),
        out: rr.reduce((s, x) => s + x.out, 0),
        requests: rr.length,
        durationSec: Math.round(t.end - t.start),
      })
    }
    stats.series = series
  }
  return stats
}

// ---------------------------------------------------------------------------
// 60 s cache per strand + include combination. Statistics of a finished
// strand are practically static; a running one refreshes once a minute.

const CACHE_TTL_MS = 60_000
const CACHE_MAX = 64
const cache = new Map<string, { at: number; value: StrandStats }>()

export function cachedStrandStats(db: Database, strandId: string, options: StrandStatsOptions = {}, nowMs: number = Date.now()): StrandStats {
  const key = `${strandId}|${options.includeTasks ? 't' : ''}${options.includeSeries ? 's' : ''}`
  const hit = cache.get(key)
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit.value
  const value = computeStrandStats(db, strandId, options)
  cache.delete(key)
  cache.set(key, { at: nowMs, value })
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return value
}

export function clearStrandStatsCache(): void {
  cache.clear()
}
