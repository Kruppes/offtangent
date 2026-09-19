import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore, type Task, type TaskStatus, type TaskTriggerType } from './task-store.js'
import {
  MAX_TASK_TREE_DEPTH,
  buildStrandTaskTree,
  buildTaskActivityFrame,
  resolveTaskStrandId,
} from './task-tree.js'

let db: Database
let store: TaskStore

beforeEach(() => {
  db = initDatabase(':memory:')
  store = new TaskStore(db)
})

afterEach(() => {
  db.close()
})

function session(id: string, type: string, parent: string | null = null): string {
  db.prepare(
    `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', ?, ?, '1')`,
  ).run(id, type, parent)
  return id
}

function task(over: {
  name?: string
  triggerType?: TaskTriggerType
  triggerSourceId?: string
  sessionId?: string | null
  status?: TaskStatus
  resultStatus?: 'completed' | 'failed' | 'question' | 'silent'
  errorMessage?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    cacheRead?: number
    cacheWrite?: number
    estimatedCost?: number
    toolCallCount?: number
  }
} = {}): Task {
  const created = store.create({
    name: over.name ?? 'Task',
    prompt: 'do it',
    triggerType: over.triggerType ?? 'agent',
    triggerSourceId: over.triggerSourceId,
    sessionId: over.sessionId ?? undefined,
    agentId: 'main',
  })
  if (over.status || over.resultStatus || over.errorMessage || over.usage) {
    store.update(created.id, {
      ...(over.status ? { status: over.status } : {}),
      ...(over.resultStatus ? { resultStatus: over.resultStatus } : {}),
      ...(over.errorMessage ? { errorMessage: over.errorMessage } : {}),
      ...(over.usage ?? {}),
    })
  }
  return store.getById(created.id)!
}

describe('buildStrandTaskTree', () => {
  it('shows a task the strand delegated (session lineage)', () => {
    const strand = session('strand-1', 'interactive')
    session('task-session-1', 'task', strand)
    const direct = task({ name: 'Direct', sessionId: 'task-session-1' })

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.map(t => t.id)).toEqual([direct.id])
    expect(tree.tasks[0]!.depth).toBe(0)
    expect(tree.tasks[0]!.parentTaskId).toBeNull()
    expect(tree.activeCount).toBe(1)
  })

  /**
   * The repro for the reported bug: a task that starts a sub-task. Before the
   * `trigger_source_id` edge existed, the sub-task was reachable from nothing
   * (background task tools pass `null` as parent session) and the strand
   * looked dead while the wave ran.
   */
  it('shows a sub-task started by a task, even with a broken session lineage', () => {
    const strand = session('strand-2', 'interactive')
    session('task-session-2', 'task', strand)
    const parent = task({ name: 'Wave', sessionId: 'task-session-2' })
    // Sub-task session has NO parent — exactly what the background task tools
    // produce today.
    session('sub-session-2', 'task', null)
    const sub = task({ name: 'Sub', sessionId: 'sub-session-2', triggerSourceId: parent.id })

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.map(t => t.id)).toEqual([parent.id, sub.id])
    const subNode = tree.tasks.find(t => t.id === sub.id)!
    expect(subNode.parentTaskId).toBe(parent.id)
    expect(subNode.depth).toBe(1)
    expect(tree.tasks.find(t => t.id === parent.id)!.hasChildren).toBe(true)
  })

  it('resolves three generations: strand -> task -> sub -> sub-sub', () => {
    const strand = session('strand-3', 'interactive')
    session('s-a', 'task', strand)
    const a = task({ name: 'A', sessionId: 's-a' })
    const b = task({ name: 'B', triggerSourceId: a.id })
    task({ name: 'C', triggerSourceId: b.id })

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.map(t => [t.name, t.depth])).toEqual([['A', 0], ['B', 1], ['C', 2]])
  })

  it('finds a sub-task that has no session yet (row just inserted)', () => {
    const strand = session('strand-4', 'interactive')
    session('s-root', 'task', strand)
    const root = task({ name: 'Root', sessionId: 's-root' })
    const fresh = task({ name: 'Fresh', triggerSourceId: root.id, sessionId: null })

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.map(t => t.id)).toContain(fresh.id)
    expect(tree.tasks.find(t => t.id === fresh.id)!.sessionId).toBeNull()
  })

  it('survives a cyclic task parentage instead of hanging', () => {
    const strand = session('strand-5', 'interactive')
    session('s-x', 'task', strand)
    const x = task({ name: 'X', sessionId: 's-x' })
    const y = task({ name: 'Y', triggerSourceId: x.id })
    // Bad data: x points back at y.
    db.prepare('UPDATE tasks SET trigger_source_id = ? WHERE id = ?').run(y.id, x.id)

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.length).toBe(2)
    for (const node of tree.tasks) expect(node.depth).toBeLessThanOrEqual(MAX_TASK_TREE_DEPTH)
  })

  it('survives a cyclic session lineage instead of hanging', () => {
    const strand = session('strand-6', 'interactive')
    session('loop-a', 'task', strand)
    session('loop-b', 'task', 'loop-a')
    db.prepare('UPDATE sessions SET parent_session_id = ? WHERE id = ?').run('loop-b', 'loop-a')
    task({ name: 'Looped', sessionId: 'loop-b' })

    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks.length).toBeLessThanOrEqual(2)
  })

  it('cuts the tree at the depth limit and flags it as truncated', () => {
    const strand = session('strand-7', 'interactive')
    session('s-d0', 'task', strand)
    let parent = task({ name: 'gen0', sessionId: 's-d0' })
    for (let i = 1; i <= MAX_TASK_TREE_DEPTH + 2; i++) {
      parent = task({ name: `gen${i}`, triggerSourceId: parent.id })
    }

    const tree = buildStrandTaskTree(db, strand, { include: 'all' })
    expect(tree.truncated).toBe(true)
    expect(Math.max(...tree.tasks.map(t => t.depth))).toBeLessThanOrEqual(MAX_TASK_TREE_DEPTH)
  })

  it('honours a caller depth limit below the hard limit', () => {
    const strand = session('strand-8', 'interactive')
    session('s-e0', 'task', strand)
    const a = task({ name: 'a', sessionId: 's-e0' })
    const b = task({ name: 'b', triggerSourceId: a.id })
    task({ name: 'c', triggerSourceId: b.id })

    const tree = buildStrandTaskTree(db, strand, { include: 'all', maxDepth: 1 })
    expect(tree.tasks.map(t => t.name)).toEqual(['a', 'b'])
    expect(tree.truncated).toBe(true)
  })

  it('include=active drops finished branches but keeps failures and ancestors', () => {
    const strand = session('strand-9', 'interactive')
    session('s-done', 'task', strand)
    session('s-live', 'task', strand)
    const done = task({ name: 'Done', sessionId: 's-done', status: 'completed', resultStatus: 'completed' })
    const live = task({ name: 'Live', sessionId: 's-live', status: 'running' })
    const failed = task({ name: 'Failed', triggerSourceId: live.id, status: 'failed', resultStatus: 'failed', errorMessage: 'boom' })

    const active = buildStrandTaskTree(db, strand, { include: 'active' })
    expect(active.tasks.map(t => t.name).sort()).toEqual(['Failed', 'Live'])
    expect(active.tasks.find(t => t.id === failed.id)!.errorMessage).toBe('boom')

    const all = buildStrandTaskTree(db, strand, { include: 'all' })
    expect(all.tasks.map(t => t.id)).toContain(done.id)
  })

  it('keeps a completed parent of a still running sub-task', () => {
    const strand = session('strand-10', 'interactive')
    session('s-p', 'task', strand)
    const parent = task({ name: 'Parent', sessionId: 's-p', status: 'completed', resultStatus: 'completed' })
    task({ name: 'Child', triggerSourceId: parent.id, status: 'running' })

    const tree = buildStrandTaskTree(db, strand, { include: 'active' })
    expect(tree.tasks.map(t => t.name)).toEqual(['Parent', 'Child'])
    expect(tree.activeCount).toBe(1)
  })

  it('returns an empty tree for a strand without tasks', () => {
    const strand = session('strand-11', 'interactive')
    const tree = buildStrandTaskTree(db, strand)
    expect(tree.tasks).toEqual([])
    expect(tree.activeCount).toBe(0)
    expect(tree.truncated).toBe(false)
  })

  it('never returns a foreign strand\'s tasks', () => {
    const mine = session('strand-12', 'interactive')
    const other = session('strand-13', 'interactive')
    session('s-other', 'task', other)
    task({ name: 'Foreign', sessionId: 's-other' })

    expect(buildStrandTaskTree(db, mine).tasks).toEqual([])
    expect(buildStrandTaskTree(db, other).tasks.map(t => t.name)).toEqual(['Foreign'])
  })

  it('caps the number of nodes', () => {
    const strand = session('strand-14', 'interactive')
    session('s-root2', 'task', strand)
    const root = task({ name: 'root', sessionId: 's-root2', status: 'running' })
    for (let i = 0; i < 12; i++) task({ name: `w${i}`, triggerSourceId: root.id, status: 'running' })

    const tree = buildStrandTaskTree(db, strand, { include: 'all', maxNodes: 5 })
    expect(tree.tasks.length).toBe(5)
    expect(tree.truncated).toBe(true)
  })
})

describe('resolveTaskStrandId', () => {
  it('resolves the strand through the task-parent chain', () => {
    const strand = session('strand-20', 'interactive')
    session('s-top', 'task', strand)
    const top = task({ name: 'top', sessionId: 's-top' })
    const mid = task({ name: 'mid', triggerSourceId: top.id, sessionId: session('s-mid', 'task', null) })
    const leaf = task({ name: 'leaf', triggerSourceId: mid.id, sessionId: session('s-leaf', 'task', null) })

    expect(resolveTaskStrandId(db, leaf)).toBe(strand)
  })

  it('returns null for a cronjob wave (no interactive ancestor)', () => {
    session('cron-session', 'task', null)
    const cron = task({ name: 'cron', triggerType: 'cronjob', sessionId: 'cron-session' })
    const sub = task({ name: 'cron-sub', triggerSourceId: cron.id })
    expect(resolveTaskStrandId(db, cron)).toBeNull()
    expect(resolveTaskStrandId(db, sub)).toBeNull()
  })

  it('returns null instead of guessing when nothing links the task to a strand', () => {
    session('strand-21', 'interactive')
    const orphan = task({ name: 'orphan', sessionId: null })
    expect(resolveTaskStrandId(db, orphan)).toBeNull()
  })
})

/**
 * The App shows a wave of sub-tasks but could not show what they cost: the
 * numbers were in the `tasks` row and fell out of the DTO. These pin that
 * they survive BOTH ways a task reaches the tree — the session lineage and
 * the `trigger_source_id` edge use two different SELECTs.
 */
describe('task tree usage counters', () => {
  it('carries tokens and cost for a task found through the session lineage', () => {
    const strand = session('strand-40', 'interactive')
    session('s-40', 'task', strand)
    task({
      name: 'Direct',
      sessionId: 's-40',
      status: 'running',
      usage: {
        promptTokens: 78,
        completionTokens: 8221,
        cacheRead: 1308532,
        cacheWrite: 55092,
        estimatedCost: 1.204506,
        toolCallCount: 38,
      },
    })

    const node = buildStrandTaskTree(db, strand).tasks[0]!
    expect(node.promptTokens).toBe(78)
    expect(node.completionTokens).toBe(8221)
    expect(node.cacheRead).toBe(1308532)
    expect(node.cacheWrite).toBe(55092)
    expect(node.estimatedCost).toBeCloseTo(1.204506, 6)
    expect(node.toolCallCount).toBe(38)
  })

  it('carries tokens for a sub-task found through the task-parent edge', () => {
    const strand = session('strand-41', 'interactive')
    session('s-41', 'task', strand)
    const parent = task({ name: 'Wave', sessionId: 's-41', status: 'running' })
    const child = task({
      name: 'Sub',
      triggerSourceId: parent.id,
      status: 'running',
      usage: { promptTokens: 11, completionTokens: 22, cacheRead: 33, cacheWrite: 44, estimatedCost: 0.5 },
    })

    const node = buildStrandTaskTree(db, strand).tasks.find(t => t.id === child.id)!
    expect(node.promptTokens).toBe(11)
    expect(node.completionTokens).toBe(22)
    expect(node.cacheRead).toBe(33)
    expect(node.cacheWrite).toBe(44)
    expect(node.estimatedCost).toBeCloseTo(0.5, 6)
  })

  it('reports 0, never null, for a task that has not billed anything yet', () => {
    const strand = session('strand-42', 'interactive')
    session('s-42', 'task', strand)
    task({ name: 'Fresh', sessionId: 's-42', status: 'running' })

    const node = buildStrandTaskTree(db, strand).tasks[0]!
    for (const value of [node.promptTokens, node.completionTokens, node.cacheRead, node.cacheWrite, node.estimatedCost]) {
      expect(value).toBe(0)
    }
  })
})

describe('buildTaskActivityFrame', () => {
  it('carries strand, task and parent task ids', () => {
    const strand = session('strand-30', 'interactive')
    session('s-a30', 'task', strand)
    const parent = task({ name: 'Parent', sessionId: 's-a30', status: 'running' })
    const child = task({ name: 'Child', triggerSourceId: parent.id, status: 'running' })

    const frame = buildTaskActivityFrame(db, child, 'started')
    expect(frame).not.toBeNull()
    expect(frame!.strandId).toBe(strand)
    expect(frame!.taskId).toBe(child.id)
    expect(frame!.parentTaskId).toBe(parent.id)
    expect(frame!.phase).toBe('started')
    expect(frame!.status).toBe('running')
  })

  it('is dropped (null) when the task has no resolvable strand', () => {
    const orphan = task({ name: 'orphan', sessionId: null })
    expect(buildTaskActivityFrame(db, orphan, 'started')).toBeNull()
  })

  it('carries the live token and cost stand on a progress frame', () => {
    const strand = session('strand-32', 'interactive')
    session('s-p', 'task', strand)
    const running = task({
      name: 'Working',
      sessionId: 's-p',
      status: 'running',
      usage: { promptTokens: 5, completionTokens: 900, cacheRead: 70000, cacheWrite: 1200, estimatedCost: 0.25, toolCallCount: 7 },
    })

    const frame = buildTaskActivityFrame(db, running, 'progress')!
    expect(frame.phase).toBe('progress')
    expect(frame.promptTokens).toBe(5)
    expect(frame.completionTokens).toBe(900)
    expect(frame.cacheRead).toBe(70000)
    expect(frame.cacheWrite).toBe(1200)
    expect(frame.estimatedCost).toBeCloseTo(0.25, 6)
    expect(frame.toolCallCount).toBe(7)
  })

  it('carries the failure reason on a finished frame', () => {
    const strand = session('strand-31', 'interactive')
    session('s-f', 'task', strand)
    const failed = task({ name: 'Boom', sessionId: 's-f', status: 'failed', resultStatus: 'failed', errorMessage: 'exit 1' })
    const frame = buildTaskActivityFrame(db, failed, 'finished')
    expect(frame!.status).toBe('failed')
    expect(frame!.errorMessage).toBe('exit 1')
    expect(frame!.strandId).toBe(strand)
  })
})
