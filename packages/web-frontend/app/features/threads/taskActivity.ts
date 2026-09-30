/**
 * The strand activity model: what is working for this strand right now.
 *
 * A strand used to look dead while a whole wave of background work ran under
 * it — the running turn was visible, the delegated task barely, its sub-tasks
 * not at all. The state here is fed from two sources that must agree:
 *
 *  * the REST catch-up `GET /api/strands/:id/tasks` (opening the page mid-wave,
 *    reconnecting after a dropped socket, a missed `task_started` frame), and
 *  * the live frames `task_started` / `task_progress` / `task_finished`.
 *
 * Both carry the same node shape, so merging is a straight upsert keyed by
 * task id. A frame for another strand is ignored here (not dropped globally):
 * the store is keyed by strand so switching strands shows the right tree
 * without a refetch.
 */

import type { StrandTaskNode, StrandTaskStatus } from '../../api/strandTasks'

export type { StrandTaskNode, StrandTaskStatus }

/** One strand's slice of the store. */
export interface StrandTaskState {
  /** Nodes by task id — order is derived, never stored. */
  nodes: Record<string, StrandTaskNode>
  /** Wall-clock of the last successful catch-up, for debugging/fallbacks. */
  loadedAt: string | null
}

export type StrandTaskStore = Record<string, StrandTaskState>

/** A `task_started` / `task_progress` / `task_finished` WebSocket frame. */
export interface TaskActivityFrame {
  type?: string
  sessionId?: string
  taskId?: string
  taskParentId?: string | null
  taskName?: string
  taskStatus?: string
  taskResultStatus?: string | null
  taskTriggerType?: string
  taskError?: string | null
  taskCreatedAt?: string
  taskStartedAt?: string | null
  taskCompletedAt?: string | null
  taskPromptTokens?: number
  taskCompletionTokens?: number
  taskCacheRead?: number
  taskCacheWrite?: number
  taskEstimatedCost?: number
  taskToolCallCount?: number
  agentId?: string
}

export const TASK_ACTIVITY_FRAME_TYPES = ['task_started', 'task_progress', 'task_finished'] as const

export function isTaskActivityFrame(frame: { type?: string }): boolean {
  return (TASK_ACTIVITY_FRAME_TYPES as readonly string[]).includes(frame.type ?? '')
}

function emptyState(): StrandTaskState {
  return { nodes: {}, loadedAt: null }
}

function normalizeStatus(raw: string | undefined): StrandTaskStatus {
  return raw === 'paused' || raw === 'completed' || raw === 'failed' ? raw : 'running'
}

/**
 * Fold one live frame into the store.
 *
 * Hard rule, mirrored from the backend: a frame without `sessionId` or
 * without `taskId` is DROPPED. It is never attributed to the strand that
 * happens to be open — a wrong attribution is worse than a missing row, and
 * the REST catch-up repairs a missing row on the next load.
 */
export function applyTaskActivityFrame(store: StrandTaskStore, frame: TaskActivityFrame): StrandTaskStore {
  if (!isTaskActivityFrame(frame)) return store
  const strandId = frame.sessionId
  const taskId = frame.taskId
  if (!strandId || !taskId) return store

  const previous = store[strandId] ?? emptyState()
  const existing = previous.nodes[taskId]
  const node: StrandTaskNode = {
    id: taskId,
    name: frame.taskName ?? existing?.name ?? taskId,
    status: normalizeStatus(frame.taskStatus ?? existing?.status),
    resultStatus: frame.taskResultStatus ?? existing?.resultStatus ?? null,
    triggerType: frame.taskTriggerType ?? existing?.triggerType ?? 'agent',
    agentId: frame.agentId ?? existing?.agentId ?? null,
    parentTaskId: frame.taskParentId ?? existing?.parentTaskId ?? null,
    depth: existing?.depth ?? 0,
    hasChildren: existing?.hasChildren ?? false,
    createdAt: frame.taskCreatedAt ?? existing?.createdAt ?? new Date().toISOString(),
    startedAt: frame.taskStartedAt ?? existing?.startedAt ?? null,
    completedAt: frame.taskCompletedAt ?? existing?.completedAt ?? null,
    errorMessage: frame.taskError ?? existing?.errorMessage ?? null,
    promptTokens: frame.taskPromptTokens ?? existing?.promptTokens ?? 0,
    completionTokens: frame.taskCompletionTokens ?? existing?.completionTokens ?? 0,
    cacheRead: frame.taskCacheRead ?? existing?.cacheRead ?? 0,
    cacheWrite: frame.taskCacheWrite ?? existing?.cacheWrite ?? 0,
    estimatedCost: frame.taskEstimatedCost ?? existing?.estimatedCost ?? 0,
    toolCallCount: frame.taskToolCallCount ?? existing?.toolCallCount ?? 0,
    sessionId: existing?.sessionId ?? null,
  }

  return {
    ...store,
    [strandId]: { ...previous, nodes: { ...previous.nodes, [taskId]: node } },
  }
}

/**
 * Replace a strand's slice with a server snapshot (catch-up). The snapshot
 * wins over anything the live stream produced: it is the authoritative read,
 * and it is what makes a missed `task_started` frame self-healing.
 */
export function applyTaskTreeSnapshot(
  store: StrandTaskStore,
  strandId: string,
  tasks: StrandTaskNode[],
  loadedAt = new Date().toISOString(),
): StrandTaskStore {
  const nodes: Record<string, StrandTaskNode> = {}
  for (const task of tasks) nodes[task.id] = task
  return { ...store, [strandId]: { nodes, loadedAt } }
}

export interface StrandTaskRow extends StrandTaskNode {
  /** Indentation level derived from the parent chain (not from the server). */
  level: number
  children: StrandTaskRow[]
}

const MAX_RENDER_DEPTH = 8

/**
 * Turn the flat node map into a render tree.
 *
 * `depth` from the server is a hint only — the level is recomputed from the
 * parent chain so a live frame (which has no depth) still indents correctly.
 * A node whose parent is unknown (frame arrived before its parent's frame, or
 * the parent fell out of the depth limit) is rendered as a root instead of
 * being hidden: an orphan row is still a row the user can see.
 */
export function buildTaskRows(state: StrandTaskState | undefined): StrandTaskRow[] {
  if (!state) return []
  const nodes = Object.values(state.nodes)
  if (nodes.length === 0) return []

  const byId = new Map(nodes.map(n => [n.id, n]))
  const rows = new Map<string, StrandTaskRow>()
  for (const node of nodes) rows.set(node.id, { ...node, level: 0, children: [] })

  const roots: StrandTaskRow[] = []
  for (const row of rows.values()) {
    const parent = row.parentTaskId && byId.has(row.parentTaskId) && row.parentTaskId !== row.id
      ? rows.get(row.parentTaskId)
      : undefined
    if (parent) parent.children.push(row)
    else roots.push(row)
  }

  const byCreated = (a: StrandTaskRow, b: StrandTaskRow): number =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt)

  const assignLevels = (row: StrandTaskRow, level: number, seen: Set<string>): void => {
    row.level = level
    row.children.sort(byCreated)
    if (level >= MAX_RENDER_DEPTH) {
      row.children = []
      return
    }
    for (const child of [...row.children]) {
      if (seen.has(child.id)) {
        // Cycle in the data — cut it instead of recursing forever.
        row.children = row.children.filter(c => c.id !== child.id)
        continue
      }
      seen.add(child.id)
      assignLevels(child, level + 1, seen)
    }
  }
  roots.sort(byCreated)
  for (const root of roots) assignLevels(root, 0, new Set([root.id]))

  return roots
}

/** Flatten the render tree, honouring which nodes the user expanded. */
export function flattenTaskRows(roots: StrandTaskRow[], expanded: Set<string>): StrandTaskRow[] {
  const out: StrandTaskRow[] = []
  const walk = (rows: StrandTaskRow[]): void => {
    for (const row of rows) {
      out.push(row)
      if (row.children.length > 0 && expanded.has(row.id)) walk(row.children)
    }
  }
  walk(roots)
  return out
}

export function isLive(node: { status: StrandTaskStatus }): boolean {
  return node.status === 'running' || node.status === 'paused'
}

export function countLive(state: StrandTaskState | undefined): number {
  if (!state) return 0
  return Object.values(state.nodes).filter(isLive).length
}

/**
 * Timestamps arrive in two shapes: SQLite's `"YYYY-MM-DD HH:MM:SS"` (UTC,
 * no zone marker) and ISO 8601. Both are parsed as UTC — reading the SQLite
 * form as local time is what makes a counter jump by hours.
 */
export function parseTaskTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const ms = new Date(normalized).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * Seconds a node has been working: started → now while it runs, started →
 * completed once it is done. Returns null when there is no usable start.
 */
export function elapsedSeconds(node: StrandTaskNode, nowMs: number): number | null {
  const start = parseTaskTimestamp(node.startedAt) ?? parseTaskTimestamp(node.createdAt)
  if (start === null) return null
  const end = isLive(node) ? nowMs : (parseTaskTimestamp(node.completedAt) ?? nowMs)
  return Math.max(0, Math.round((end - start) / 1000))
}

/** `0:07`, `1:23`, `12:05`, `2:03:11` — a counter that proves something lives. */
export function formatElapsed(totalSeconds: number | null): string {
  if (totalSeconds === null) return '—'
  const s = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(s / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes)
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`
}
