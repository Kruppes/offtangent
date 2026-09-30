/**
 * What is working for a strand right now (task tree, SPEC 10.x).
 *
 * A strand used to look dead while a whole wave of background work ran under
 * it: the UI could only see the running turn and, at best, the task the user
 * started directly. Sub-tasks were invisible — they were never announced
 * (`create_task` produced a `tool_call_start`/`tool_call_end` pair in the same
 * frame batch) and no read path could find them afterwards.
 *
 * Two edges connect a task to the strand it works for, and this module reads
 * BOTH because each one alone has a hole:
 *
 *  * **Session lineage** — `sessions.parent_session_id`. The interactive
 *    strand is the parent of the task session (written by the task tools via
 *    `getParentSessionId`). This is the edge that already existed and the one
 *    `task-feed.ts` / `task-notification.ts` walk. Its hole: background task
 *    tools pass `null` as parent session, so a sub-task's session has no
 *    parent and the chain breaks after the first generation.
 *  * **Task parentage** — `tasks.trigger_source_id` for `trigger_type='agent'`
 *    carries the id of the task whose agent called `create_task` (written in
 *    `task-tools.ts` from the task execution context). This edge exists from
 *    the moment the row is inserted, i.e. before the task even has a session,
 *    and it survives the broken session lineage.
 *
 * Nothing here guesses. A task that cannot be attached to an interactive
 * session through one of those two edges is simply not part of the tree —
 * the "only running strand" fallback is forbidden (it has ended foreign
 * turns before).
 */
import type { Database } from './database.js'
import { resolveTaskStrandOrigin } from './task-feed.js'
import type { Task, TaskResultStatus, TaskStatus, TaskTriggerType } from './task-store.js'

/** Hard limit on task generations below the strand (strand → a → b → c …). */
export const MAX_TASK_TREE_DEPTH = 6

/** Hard limit on nodes returned for one strand. */
export const MAX_TASK_TREE_NODES = 200

/**
 * Guard against a cyclic `parent_session_id` chain — same value and same
 * reasoning as `task-feed.ts` (which this module deliberately reuses instead
 * of re-implementing lineage walking).
 */
const MAX_SESSION_LINEAGE_DEPTH = 10

/** Statuses that make a task "live" for `include=active`. */
const LIVE_STATUSES = new Set<TaskStatus>(['running', 'paused'])

export type StrandTaskInclude = 'active' | 'all'

/** One node of a strand's task tree. Flat: the shape the API returns. */
export interface StrandTaskNode {
  id: string
  name: string
  status: TaskStatus
  resultStatus: TaskResultStatus | null
  triggerType: TaskTriggerType
  agentId: string | null
  /** The task that delegated this one, or null for a task the strand started. */
  parentTaskId: string | null
  /** 0 for a task the strand started directly, +1 per delegation level. */
  depth: number
  hasChildren: boolean
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  toolCallCount: number
  /**
   * Live usage of the task, mirrored 1:1 from the `tasks` row. The runner
   * persists these on every `message_end` (`persistLiveMetrics`), so a node
   * read while the task runs carries the current stand, not the final one.
   * Always numbers — a NULL column reads as 0, never as null, so a client
   * can sum them without null checks.
   */
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  /** Accumulated cost in USD (provider-reported, else estimated). */
  estimatedCost: number
  /** The task's own session (NOT the strand) — null before it started. */
  sessionId: string | null
}

export interface StrandTaskTree {
  strandId: string
  include: StrandTaskInclude
  tasks: StrandTaskNode[]
  /** Number of nodes with status running or paused. */
  activeCount: number
  /** True when the node cap or the depth limit dropped something. */
  truncated: boolean
  maxDepth: number
}

export interface StrandTaskTreeOptions {
  include?: StrandTaskInclude
  maxDepth?: number
  maxNodes?: number
}

interface TaskTreeRow {
  id: string
  name: string
  status: string
  result_status: string | null
  trigger_type: string
  trigger_source_id: string | null
  agent_id: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  tool_call_count: number
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  estimated_cost: number | null
  session_id: string | null
}

/**
 * Every column a node needs. Used by BOTH lineage queries and by
 * `loadTask` — adding a field here is enough, there is no second list.
 */
const TASK_TREE_COLUMNS =
  'id, name, status, result_status, trigger_type, trigger_source_id, agent_id, created_at, started_at, completed_at, error_message, tool_call_count, prompt_tokens, completion_tokens, cache_read, cache_write, estimated_cost, session_id'

/** A usage column that is NULL (legacy rows) counts as 0, never as null. */
function usage(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Tasks whose own session descends from the strand session.
 *
 * One recursive CTE, one round trip — no per-session query. The depth guard
 * inside the CTE is what terminates a cyclic `parent_session_id` chain (the
 * `UNION` alone would not, because the depth column keeps changing).
 */
function tasksBySessionLineage(db: Database, strandId: string): TaskTreeRow[] {
  return db.prepare(`
    WITH RECURSIVE lineage(session_id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT s.id, l.depth + 1
        FROM sessions s
        JOIN lineage l ON s.parent_session_id = l.session_id
       WHERE l.depth < ?
    )
    SELECT ${TASK_TREE_COLUMNS.split(', ').map(c => `t.${c}`).join(', ')}
      FROM tasks t
      JOIN lineage l ON t.session_id = l.session_id
     WHERE l.depth > 0
  `).all(strandId, MAX_SESSION_LINEAGE_DEPTH) as TaskTreeRow[]
}

/** Children of the given task ids via `tasks.trigger_source_id`. */
function tasksByParentIds(db: Database, parentIds: string[]): TaskTreeRow[] {
  if (parentIds.length === 0) return []
  const out: TaskTreeRow[] = []
  // SQLite caps bound parameters (999 by default) — chunk instead of risking
  // a hard error on a very wide wave.
  for (let i = 0; i < parentIds.length; i += 400) {
    const chunk = parentIds.slice(i, i + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    out.push(...db.prepare(`
      SELECT ${TASK_TREE_COLUMNS}
        FROM tasks
       WHERE trigger_type = 'agent'
         AND trigger_source_id IN (${placeholders})
    `).all(...chunk) as TaskTreeRow[])
  }
  return out
}

/** `parent_session_id` for a batch of session ids, in one query per chunk. */
function parentSessionIds(db: Database, sessionIds: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>()
  for (let i = 0; i < sessionIds.length; i += 400) {
    const chunk = sessionIds.slice(i, i + 400)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT id, parent_session_id FROM sessions WHERE id IN (${placeholders})`,
    ).all(...chunk) as { id: string; parent_session_id: string | null }[]
    for (const row of rows) map.set(row.id, row.parent_session_id)
  }
  return map
}

function rowToNode(row: TaskTreeRow): StrandTaskNode {
  return {
    id: row.id,
    name: row.name,
    status: row.status as TaskStatus,
    resultStatus: (row.result_status as TaskResultStatus | null) ?? null,
    triggerType: row.trigger_type as TaskTriggerType,
    agentId: row.agent_id,
    parentTaskId: null,
    depth: 0,
    hasChildren: false,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    toolCallCount: row.tool_call_count,
    promptTokens: usage(row.prompt_tokens),
    completionTokens: usage(row.completion_tokens),
    cacheRead: usage(row.cache_read),
    cacheWrite: usage(row.cache_write),
    estimatedCost: usage(row.estimated_cost),
    sessionId: row.session_id,
  }
}

/**
 * The full task tree of a strand: the tasks it delegated and, recursively,
 * the tasks those delegated.
 *
 * Cost: one recursive CTE over `sessions` (indexed by `idx_sessions_parent`),
 * then at most `maxDepth` batched `IN (…)` queries over
 * `tasks.trigger_source_id` (indexed by `idx_tasks_trigger_source_id`) plus
 * one batched session lookup. No query per task, no query per session.
 *
 * `include=active` keeps live (running / paused) and failed tasks plus the
 * ancestors needed to connect them — a failure never disappears silently.
 * `include=all` keeps everything, capped at `maxNodes`.
 */
export function buildStrandTaskTree(
  db: Database,
  strandId: string,
  options: StrandTaskTreeOptions = {},
): StrandTaskTree {
  const include: StrandTaskInclude = options.include ?? 'active'
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? MAX_TASK_TREE_DEPTH, MAX_TASK_TREE_DEPTH))
  const maxNodes = Math.max(1, Math.min(options.maxNodes ?? MAX_TASK_TREE_NODES, MAX_TASK_TREE_NODES))

  const byId = new Map<string, TaskTreeRow>()
  for (const row of tasksBySessionLineage(db, strandId)) byId.set(row.id, row)

  // Expand along the task-parent edge, generation by generation. The loop is
  // bounded by maxDepth + 1 and by the visited set, so neither a cycle
  // (a -> b -> a) nor a very deep chain can spin here.
  let frontier = [...byId.keys()]
  for (let level = 0; level <= maxDepth && frontier.length > 0; level++) {
    const children = tasksByParentIds(db, frontier)
    const next: string[] = []
    for (const child of children) {
      if (byId.has(child.id)) continue
      byId.set(child.id, child)
      next.push(child.id)
    }
    frontier = next
  }

  if (byId.size === 0) {
    return { strandId, include, tasks: [], activeCount: 0, truncated: false, maxDepth }
  }

  // Resolve the parent of every collected task. The task edge wins (it is
  // explicit); the session edge is the fallback for rows written before the
  // edge existed.
  const sessionToTask = new Map<string, string>()
  for (const row of byId.values()) {
    if (row.session_id) sessionToTask.set(row.session_id, row.id)
  }
  const sessionIds = [...byId.values()].map(r => r.session_id).filter((s): s is string => !!s)
  const sessionParents = parentSessionIds(db, sessionIds)

  const nodes = new Map<string, StrandTaskNode>()
  for (const row of byId.values()) nodes.set(row.id, rowToNode(row))

  for (const row of byId.values()) {
    const node = nodes.get(row.id)!
    let parentId: string | null = null
    if (row.trigger_source_id && byId.has(row.trigger_source_id) && row.trigger_source_id !== row.id) {
      parentId = row.trigger_source_id
    } else if (row.session_id) {
      const parentSession = sessionParents.get(row.session_id) ?? null
      const viaSession = parentSession ? sessionToTask.get(parentSession) ?? null : null
      if (viaSession && viaSession !== row.id) parentId = viaSession
    }
    node.parentTaskId = parentId
  }

  // Depth by walking up with a visited set: a cycle introduced by bad data
  // degrades the node to a root instead of hanging the request.
  let truncated = false
  const rootless: StrandTaskNode[] = []
  for (const node of nodes.values()) {
    const seen = new Set<string>([node.id])
    let depth = 0
    let cursor = node.parentTaskId
    while (cursor && depth <= maxDepth + 1) {
      if (seen.has(cursor)) {
        // Cycle — cut the edge here and treat this node as a root.
        node.parentTaskId = null
        depth = 0
        break
      }
      seen.add(cursor)
      depth++
      cursor = nodes.get(cursor)?.parentTaskId ?? null
    }
    node.depth = depth
    if (depth > maxDepth) {
      truncated = true
      rootless.push(node)
    }
  }
  for (const node of rootless) nodes.delete(node.id)

  // Drop nodes whose parent fell out with the depth limit.
  for (const node of nodes.values()) {
    if (node.parentTaskId && !nodes.has(node.parentTaskId)) node.parentTaskId = null
  }

  const childrenOf = new Map<string | null, StrandTaskNode[]>()
  for (const node of nodes.values()) {
    const list = childrenOf.get(node.parentTaskId) ?? []
    list.push(node)
    childrenOf.set(node.parentTaskId, list)
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)))
  }
  for (const node of nodes.values()) node.hasChildren = (childrenOf.get(node.id)?.length ?? 0) > 0

  // Pre-order DFS so a client can render the flat list top to bottom with
  // `depth` as indentation, without building a tree first.
  const ordered: StrandTaskNode[] = []
  const walk = (parentId: string | null): void => {
    for (const node of childrenOf.get(parentId) ?? []) {
      ordered.push(node)
      walk(node.id)
    }
  }
  walk(null)

  let visible = ordered
  if (include === 'active') {
    const keep = new Set<string>()
    for (const node of ordered) {
      if (LIVE_STATUSES.has(node.status) || node.status === 'failed' || node.resultStatus === 'failed') {
        // Keep the node and every ancestor so the branch stays connected.
        let cursor: StrandTaskNode | undefined = node
        const guard = new Set<string>()
        while (cursor && !guard.has(cursor.id)) {
          guard.add(cursor.id)
          keep.add(cursor.id)
          cursor = cursor.parentTaskId ? nodes.get(cursor.parentTaskId) : undefined
        }
      }
    }
    visible = ordered.filter(n => keep.has(n.id))
  }

  if (visible.length > maxNodes) {
    truncated = true
    visible = visible.slice(0, maxNodes)
  }

  const activeCount = visible.filter(n => LIVE_STATUSES.has(n.status)).length
  return { strandId, include, tasks: visible, activeCount, truncated, maxDepth }
}

/**
 * The strand a task works for, or null.
 *
 * Tries the session lineage first (`resolveTaskStrandOrigin`, unchanged
 * semantics: cronjob / heartbeat / consolidation never reach a strand), then
 * climbs the task-parent edge and tries again for the parent. Returns null
 * rather than guessing — a frame without a strand is dropped, never
 * broadcast to "the strand that happens to be running".
 */
export function resolveTaskStrandId(db: Database, task: Task): string | null {
  let current: Task | null = task
  const seen = new Set<string>()
  for (let hop = 0; current && hop <= MAX_TASK_TREE_DEPTH + 1; hop++) {
    if (seen.has(current.id)) return null
    seen.add(current.id)

    const direct = resolveTaskStrandOrigin(db, current)
    if (direct) return direct

    const parentId: string | null =
      current.triggerType === 'agent' ? current.triggerSourceId : null
    if (!parentId) return null
    current = loadTask(db, parentId)
  }
  return null
}

function loadTask(db: Database, id: string): Task | null {
  const row = db.prepare(
    `SELECT ${TASK_TREE_COLUMNS} FROM tasks WHERE id = ?`,
  ).get(id) as TaskTreeRow | undefined
  if (!row) return null
  // Only the fields the lineage walk needs; enough for
  // `resolveTaskStrandOrigin` (trigger type + session id).
  return {
    id: row.id,
    name: row.name,
    prompt: '',
    status: row.status as TaskStatus,
    triggerType: row.trigger_type as TaskTriggerType,
    triggerSourceId: row.trigger_source_id,
    provider: null,
    model: null,
    isDefaultModel: null,
    maxDurationMinutes: null,
    promptTokens: usage(row.prompt_tokens),
    completionTokens: usage(row.completion_tokens),
    cacheRead: usage(row.cache_read),
    cacheWrite: usage(row.cache_write),
    estimatedCost: usage(row.estimated_cost),
    toolCallCount: row.tool_call_count,
    resultSummary: null,
    resultStatus: row.result_status as TaskResultStatus | null,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sessionId: row.session_id,
    agentId: row.agent_id,
    outputSchema: null,
    contextMode: null,
    handoff: null,
    agentNotifiedAt: null,
  }
}

export type TaskActivityPhase = 'started' | 'progress' | 'finished'

/**
 * The payload of a `task_started` / `task_progress` / `task_finished` frame.
 *
 * Every field the client needs to place the node in a tree is in here:
 * the resolved strand (never guessed), the task's own id and the id of the
 * task that delegated it.
 */
export interface TaskActivityFrame {
  phase: TaskActivityPhase
  /** The interactive session the task works for. Never null in a frame. */
  strandId: string
  taskId: string
  parentTaskId: string | null
  name: string
  status: TaskStatus
  resultStatus: TaskResultStatus | null
  triggerType: TaskTriggerType
  agentId: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  toolCallCount: number
  /**
   * Live usage at the moment the frame was built. Same source and same
   * semantics as `StrandTaskNode` (see there) — a `task_progress` frame is
   * the live channel for these numbers, the tree read is the catch-up.
   */
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
}

/**
 * Build the activity frame for a task, or null when it cannot be attached to
 * a strand. Null means: do not broadcast. There is deliberately no fallback.
 */
export function buildTaskActivityFrame(
  db: Database,
  task: Task,
  phase: TaskActivityPhase,
): TaskActivityFrame | null {
  const strandId = resolveTaskStrandId(db, task)
  if (!strandId) return null

  const parentTaskId = task.triggerType === 'agent' && task.triggerSourceId
    ? task.triggerSourceId
    : parentTaskIdViaSession(db, task)

  return {
    phase,
    strandId,
    taskId: task.id,
    parentTaskId,
    name: task.name,
    status: task.status,
    resultStatus: task.resultStatus ?? null,
    triggerType: task.triggerType,
    agentId: task.agentId ?? null,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    errorMessage: task.errorMessage,
    toolCallCount: task.toolCallCount,
    promptTokens: usage(task.promptTokens),
    completionTokens: usage(task.completionTokens),
    cacheRead: usage(task.cacheRead),
    cacheWrite: usage(task.cacheWrite),
    estimatedCost: usage(task.estimatedCost),
  }
}

/** The task owning the parent session of this task's session, if any. */
function parentTaskIdViaSession(db: Database, task: Task): string | null {
  if (!task.sessionId) return null
  const session = db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?')
    .get(task.sessionId) as { parent_session_id: string | null } | undefined
  if (!session?.parent_session_id) return null
  const row = db.prepare('SELECT id FROM tasks WHERE session_id = ? LIMIT 1')
    .get(session.parent_session_id) as { id: string } | undefined
  return row?.id ?? null
}
