/**
 * Orchestrator control over background tasks: who may inspect, steer or
 * cancel which task, and the cascade that takes a task's sub-tasks down with
 * it. The agent tools in `task-control-tools.ts` are thin wrappers over this.
 *
 * Scoping mirrors the REST requester check (`TasksService.canAccess`) with
 * the identity of the calling agent instead of a JWT:
 *
 *   - a background task (ALS task context) manages only its own descendants
 *     (sub-tasks it delegated, at any depth) — never itself, its parent,
 *     siblings or other tasks of the same user;
 *   - an interactive strand turn manages tasks owned by its user
 *     (`resolveTaskOwnerUserIdForTask`, the same walk the API uses). A non-
 *     main persona is additionally limited to tasks attributed to it, like
 *     the persona scoping of read_chat_history. Ownerless system work
 *     (cronjob/heartbeat/consolidation runs) is reachable for admins only,
 *     as in the Tasks console. Another user's task is never reachable.
 *
 * Denials and unknown ids produce the same answer, so a caller cannot probe
 * for the existence of foreign task ids.
 */
import type { Database } from './database.js'
import type { Task } from './task-store.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'
import { resolveTaskOwnerUserId, resolveTaskOwnerUserIdForTask } from './task-ownership.js'

const MAX_LINEAGE_HOPS = 8

export type TaskControlCaller =
  | { kind: 'task'; taskId: string; userId: number | null; agentId: string | null }
  | { kind: 'strand'; userId: number | null; agentId: string | null }

/** Statuses in which a task still holds (or waits for) an agent. */
export function isActiveTaskStatus(status: string): boolean {
  return status === 'running' || status === 'paused'
}

function isAdminUser(db: Database, userId: number): boolean {
  try {
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined
    return row?.role === 'admin'
  } catch {
    return false
  }
}

/** Is `task` a (transitive) sub-task of `ancestorId` via the delegation edge? */
export function isTaskDescendantOf(db: Database, task: Pick<Task, 'id' | 'triggerType' | 'triggerSourceId'>, ancestorId: string): boolean {
  let parentId = task.triggerType === 'agent' ? task.triggerSourceId : null
  const seen = new Set<string>([task.id])
  for (let hop = 0; parentId && hop < MAX_LINEAGE_HOPS; hop++) {
    if (parentId === ancestorId) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    const row = db.prepare('SELECT trigger_type, trigger_source_id FROM tasks WHERE id = ?')
      .get(parentId) as { trigger_type: string; trigger_source_id: string | null } | undefined
    if (!row) return false
    parentId = row.trigger_type === 'agent' ? row.trigger_source_id : null
  }
  return false
}

function resolveOwner(db: Database, runtime: TaskRuntimeTaskBoundary, task: Task): number | null {
  const owner = resolveTaskOwnerUserIdForTask(db, task)
  if (owner !== null) return owner
  if (task.sessionId) return null
  const pendingParent = runtime.queuedParentSessionId?.(task.id) ?? null
  return pendingParent ? resolveTaskOwnerUserId(db, pendingParent) : null
}

/**
 * May `caller` inspect / steer / cancel `task`? Pure read, never throws for
 * a malformed lineage (answers false instead).
 */
export function canCallerManageTask(
  db: Database,
  runtime: TaskRuntimeTaskBoundary,
  caller: TaskControlCaller,
  task: Task,
): boolean {
  try {
    if (caller.kind === 'task') {
      if (task.id === caller.taskId) return false
      return isTaskDescendantOf(db, task, caller.taskId)
    }

    if (caller.userId === null) return false
    const callerPersona = caller.agentId ?? 'main'
    if (callerPersona !== 'main' && (task.agentId ?? 'main') !== callerPersona) return false

    const owner = resolveOwner(db, runtime, task)
    if (owner === null) return isAdminUser(db, caller.userId)
    return owner === caller.userId
  } catch {
    return false
  }
}

/** The task when it exists AND the caller may manage it, otherwise null. */
export function getManageableTask(
  db: Database,
  runtime: TaskRuntimeTaskBoundary,
  caller: TaskControlCaller,
  taskId: string,
): Task | null {
  const task = runtime.getById(taskId)
  if (!task) return null
  return canCallerManageTask(db, runtime, caller, task) ? task : null
}

export interface ActiveDescendant {
  id: string
  name: string
  status: string
  depth: number
}

/** Sub-tasks of `rootId` (any depth) that are still running, queued or paused. */
export function listActiveDescendants(db: Database, rootId: string): ActiveDescendant[] {
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
    SELECT t.id, t.name, t.status, MIN(tree.depth) AS depth
      FROM tasks t
      JOIN tree ON t.id = tree.id
     WHERE tree.depth > 0
       AND t.status IN ('running', 'paused')
     GROUP BY t.id
     ORDER BY depth ASC, t.created_at ASC, t.rowid ASC
  `).all(rootId, MAX_LINEAGE_HOPS) as ActiveDescendant[]
  return rows.filter((row) => row.id !== rootId)
}

export interface CancelTaskTreeResult {
  /** True when the root task itself was active and has been cancelled. */
  rootCancelled: boolean
  rootStatusBefore: string
  cancelledDescendants: ActiveDescendant[]
}

/**
 * Cancel a task and every active sub-task below it. The descendants are
 * collected BEFORE the root is aborted, then aborted top-down; all aborts are
 * synchronous, so no agent can delegate a new sub-task in between.
 */
export function cancelTaskTree(
  db: Database,
  runtime: TaskRuntimeTaskBoundary,
  task: Task,
  reason: string,
): CancelTaskTreeResult {
  const descendants = listActiveDescendants(db, task.id)
  const rootActive = isActiveTaskStatus(task.status)
  if (rootActive) runtime.abort(task.id, reason)

  const childReason = `Cancelled together with parent task ${task.id.slice(0, 8)}: ${reason}`
  const cancelled: ActiveDescendant[] = []
  for (const child of descendants) {
    const fresh = runtime.getById(child.id)
    if (!fresh || !isActiveTaskStatus(fresh.status)) continue
    runtime.abort(child.id, childReason)
    cancelled.push(child)
  }

  return { rootCancelled: rootActive, rootStatusBefore: task.status, cancelledDescendants: cancelled }
}
