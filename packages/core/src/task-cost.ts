/**
 * task-cost.ts: what a background task really cost, including the sub-tasks
 * it spawned (token audit 2026-09-17, P7).
 *
 * The `tasks` row carries the usage of ONE agent run. A task that delegates
 * via `create_task` therefore looks cheap while its children carry the bill —
 * exactly the blind spot the Anthropic Agent SDK documents ("top-level usage
 * undercounts sub-agents"). The edge that connects them already exists and is
 * written at insert time: a sub-task has `trigger_type='agent'` and
 * `trigger_source_id = <parent task id>` (see `task-tools.ts`), the same edge
 * `task-tree.ts` walks for the strand view.
 *
 * This module adds no table and no second accounting path: it aggregates the
 * columns `persistLiveMetrics` already writes, so the numbers match the task
 * list, the task detail view and `token_usage` by construction.
 *
 * The cache read ratio uses `cacheReadRatio()` from `cache-stats.ts` — the
 * same definition SPEC 11.5 uses for strands (`cache_read / (prompt_tokens +
 * cache_read)`), so task and strand numbers are comparable.
 */
import type { Database } from './database.js'
import { cacheReadRatio } from './cache-stats.js'

/** Hard limit on delegation generations walked below a task. */
export const MAX_TASK_COST_DEPTH = 6

/** Summed usage of one or more task rows. */
export interface TaskUsageTotals {
  /** Number of task rows behind these numbers. */
  tasks: number
  promptTokens: number
  completionTokens: number
  cacheRead: number
  cacheWrite: number
  estimatedCost: number
  toolCalls: number
  /**
   * `cache_read / (prompt_tokens + cache_read)`, 0..1, null when nothing was
   * prompted yet. Same definition as `cache-stats.ts` (SPEC 11.5).
   */
  cacheReadRatio: number | null
}

export interface TaskCostSummary {
  taskId: string
  /** The task's own run. */
  own: TaskUsageTotals
  /** The task plus every sub-task below it (`own` included). */
  subtree: TaskUsageTotals
  /** Sub-tasks found below this task (`subtree.tasks - 1`). */
  descendants: number
  /** Deepest delegation generation reached (0 = no sub-tasks). */
  maxDepth: number
  /** True when the depth limit cut the walk short. */
  truncated: boolean
}

interface UsageRow {
  id: string
  depth: number
  prompt_tokens: number | null
  completion_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  estimated_cost: number | null
  tool_call_count: number | null
}

function num(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function emptyTotals(): TaskUsageTotals {
  return {
    tasks: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    estimatedCost: 0,
    toolCalls: 0,
    cacheReadRatio: null,
  }
}

function addRow(totals: TaskUsageTotals, row: UsageRow): void {
  totals.tasks += 1
  totals.promptTokens += num(row.prompt_tokens)
  totals.completionTokens += num(row.completion_tokens)
  totals.cacheRead += num(row.cache_read)
  totals.cacheWrite += num(row.cache_write)
  totals.estimatedCost += num(row.estimated_cost)
  totals.toolCalls += num(row.tool_call_count)
}

function seal(totals: TaskUsageTotals): TaskUsageTotals {
  totals.cacheReadRatio = cacheReadRatio(totals.promptTokens, totals.cacheRead)
  return totals
}

/** Total tokens (input side + output) of a usage record — the number a human reads first. */
export function totalTokens(totals: TaskUsageTotals): number {
  return totals.promptTokens + totals.completionTokens + totals.cacheRead + totals.cacheWrite
}

/**
 * Cost of one task including its whole delegation subtree.
 * Returns null when the task id does not exist.
 */
export function getTaskCostSummary(
  db: Database,
  taskId: string,
  options?: { maxDepth?: number },
): TaskCostSummary | null {
  const maxDepth = Math.max(0, Math.floor(options?.maxDepth ?? MAX_TASK_COST_DEPTH))

  // One recursive CTE, one round trip. The depth column terminates a cyclic
  // trigger_source_id chain (UNION alone would not, the depth keeps changing).
  const rows = db.prepare(`
    WITH RECURSIVE tree(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT t.id, tree.depth + 1
        FROM tasks t
        JOIN tree ON t.trigger_source_id = tree.id
       WHERE t.trigger_type = 'agent'
         AND tree.depth < ?
    )
    SELECT t.id, tree.depth,
           t.prompt_tokens, t.completion_tokens, t.cache_read, t.cache_write,
           t.estimated_cost, t.tool_call_count
      FROM tasks t
      JOIN tree ON t.id = tree.id
  `).all(taskId, maxDepth) as UsageRow[]

  const root = rows.find((row) => row.depth === 0)
  if (!root) return null

  const own = emptyTotals()
  addRow(own, root)

  const subtree = emptyTotals()
  const seen = new Set<string>()
  let deepest = 0
  for (const row of rows) {
    // A diamond (two parents claiming the same child) must not be billed twice.
    if (seen.has(row.id)) continue
    seen.add(row.id)
    addRow(subtree, row)
    if (row.depth > deepest) deepest = row.depth
  }

  // Cheap probe for "the walk stopped at the limit": does any node at the
  // deepest reached generation have children of its own?
  let truncated = false
  if (deepest >= maxDepth) {
    const frontier = rows.filter((row) => row.depth === maxDepth).map((row) => row.id)
    truncated = hasAnyChild(db, frontier)
  }

  return {
    taskId,
    own: seal(own),
    subtree: seal(subtree),
    descendants: subtree.tasks - 1,
    maxDepth: deepest,
    truncated,
  }
}

function hasAnyChild(db: Database, parentIds: string[]): boolean {
  for (let i = 0; i < parentIds.length; i += 400) {
    const chunk = parentIds.slice(i, i + 400)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const row = db.prepare(
      `SELECT 1 AS hit FROM tasks WHERE trigger_type = 'agent' AND trigger_source_id IN (${placeholders}) LIMIT 1`,
    ).get(...chunk) as { hit: number } | undefined
    if (row) return true
  }
  return false
}

/**
 * Which of the given task ids have at least one sub-task. One query per 400
 * ids — used to decide whether a subtree aggregate is worth computing at all
 * (the common case is "no children", and then own == subtree).
 */
export function findTasksWithSubTasks(db: Database, taskIds: string[]): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < taskIds.length; i += 400) {
    const chunk = taskIds.slice(i, i + 400)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT DISTINCT trigger_source_id AS parent
         FROM tasks
        WHERE trigger_type = 'agent'
          AND trigger_source_id IN (${placeholders})`,
    ).all(...chunk) as { parent: string | null }[]
    for (const row of rows) if (row.parent) out.add(row.parent)
  }
  return out
}

/**
 * Subtree cost for a batch of tasks, computed only for those that actually
 * have sub-tasks. Tasks without children are absent from the map — the caller
 * already has their own numbers on the task row.
 */
export function getSubtreeCostForTasks(
  db: Database,
  taskIds: string[],
  options?: { maxDepth?: number },
): Map<string, TaskCostSummary> {
  const result = new Map<string, TaskCostSummary>()
  const parents = findTasksWithSubTasks(db, taskIds)
  for (const id of taskIds) {
    if (!parents.has(id)) continue
    const summary = getTaskCostSummary(db, id, options)
    if (summary) result.set(id, summary)
  }
  return result
}
