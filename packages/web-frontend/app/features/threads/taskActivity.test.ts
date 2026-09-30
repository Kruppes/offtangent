import { describe, expect, it } from 'vitest'
import {
  applyTaskActivityFrame,
  applyTaskTreeSnapshot,
  buildTaskRows,
  countLive,
  elapsedSeconds,
  flattenTaskRows,
  formatElapsed,
  isTaskActivityFrame,
  parseTaskTimestamp,
  type StrandTaskNode,
  type StrandTaskStore,
} from './taskActivity'

function node(over: Partial<StrandTaskNode> & Pick<StrandTaskNode, 'id'>): StrandTaskNode {
  return {
    name: over.id,
    status: 'running',
    resultStatus: null,
    triggerType: 'agent',
    agentId: 'main',
    parentTaskId: null,
    depth: 0,
    hasChildren: false,
    createdAt: '2025-09-15 10:00:00',
    startedAt: '2025-09-15 10:00:00',
    completedAt: null,
    errorMessage: null,
    toolCallCount: 0,
    sessionId: null,
    ...over,
  }
}

describe('applyTaskActivityFrame', () => {
  it('inserts a node from a task_started frame', () => {
    const store = applyTaskActivityFrame({}, {
      type: 'task_started',
      sessionId: 'strand-1',
      taskId: 't1',
      taskParentId: null,
      taskName: 'Wave',
      taskStatus: 'running',
      taskCreatedAt: '2025-09-15 10:00:00',
      taskStartedAt: '2025-09-15 10:00:01',
    })
    expect(Object.keys(store['strand-1']!.nodes)).toEqual(['t1'])
    expect(store['strand-1']!.nodes.t1!.name).toBe('Wave')
    expect(store['strand-1']!.nodes.t1!.status).toBe('running')
  })

  it('places a sub-task under its parent', () => {
    let store: StrandTaskStore = {}
    store = applyTaskActivityFrame(store, { type: 'task_started', sessionId: 's', taskId: 'parent', taskName: 'P' })
    store = applyTaskActivityFrame(store, { type: 'task_started', sessionId: 's', taskId: 'child', taskName: 'C', taskParentId: 'parent' })
    const rows = buildTaskRows(store.s)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.children.map(c => c.id)).toEqual(['child'])
    expect(rows[0]!.children[0]!.level).toBe(1)
  })

  it('drops a frame without sessionId instead of guessing the open strand', () => {
    const store = applyTaskActivityFrame({}, { type: 'task_started', taskId: 't1', taskName: 'Nowhere' })
    expect(store).toEqual({})
  })

  it('drops a frame without taskId', () => {
    const store = applyTaskActivityFrame({}, { type: 'task_started', sessionId: 's', taskName: 'Nameless' })
    expect(store).toEqual({})
  })

  it('ignores unrelated frame types', () => {
    const store = applyTaskActivityFrame({}, { type: 'text', sessionId: 's', taskId: 't' })
    expect(store).toEqual({})
    expect(isTaskActivityFrame({ type: 'task_finished' })).toBe(true)
    expect(isTaskActivityFrame({ type: 'done' })).toBe(false)
  })

  it('keeps a failed task visible with its reason', () => {
    let store = applyTaskActivityFrame({}, { type: 'task_started', sessionId: 's', taskId: 't', taskName: 'Boom' })
    store = applyTaskActivityFrame(store, {
      type: 'task_finished',
      sessionId: 's',
      taskId: 't',
      taskStatus: 'failed',
      taskResultStatus: 'failed',
      taskError: 'exit 1',
      taskCompletedAt: '2025-09-15 10:05:00',
    })
    const n = store.s!.nodes.t!
    expect(n.status).toBe('failed')
    expect(n.errorMessage).toBe('exit 1')
    expect(countLive(store.s)).toBe(0)
  })

  it('flips a paused task back to running on the next started frame (resume)', () => {
    let store = applyTaskActivityFrame({}, { type: 'task_finished', sessionId: 's', taskId: 't', taskName: 'Ask', taskStatus: 'paused' })
    expect(store.s!.nodes.t!.status).toBe('paused')
    store = applyTaskActivityFrame(store, { type: 'task_started', sessionId: 's', taskId: 't', taskStatus: 'running' })
    expect(store.s!.nodes.t!.status).toBe('running')
  })

  it('keeps strands apart', () => {
    let store = applyTaskActivityFrame({}, { type: 'task_started', sessionId: 'a', taskId: 't1' })
    store = applyTaskActivityFrame(store, { type: 'task_started', sessionId: 'b', taskId: 't2' })
    expect(Object.keys(store.a!.nodes)).toEqual(['t1'])
    expect(Object.keys(store.b!.nodes)).toEqual(['t2'])
  })
})

describe('applyTaskTreeSnapshot (catch-up after reconnect)', () => {
  it('shows a sub-task the client never received a frame for', () => {
    // Live stream saw only the parent (the sub-task frame was missed while
    // the socket was down).
    let store = applyTaskActivityFrame({}, { type: 'task_started', sessionId: 's', taskId: 'parent', taskName: 'P' })
    expect(Object.keys(store.s!.nodes)).toEqual(['parent'])

    store = applyTaskTreeSnapshot(store, 's', [
      node({ id: 'parent', name: 'P', hasChildren: true }),
      node({ id: 'child', name: 'C', parentTaskId: 'parent', depth: 1 }),
    ])

    const rows = flattenTaskRows(buildTaskRows(store.s), new Set(['parent']))
    expect(rows.map(r => r.id)).toEqual(['parent', 'child'])
    expect(store.s!.loadedAt).toBeTruthy()
  })

  it('replaces stale nodes (a task finished while the client was away)', () => {
    let store = applyTaskActivityFrame({}, { type: 'task_started', sessionId: 's', taskId: 'gone', taskName: 'Gone' })
    store = applyTaskTreeSnapshot(store, 's', [])
    expect(buildTaskRows(store.s)).toEqual([])
  })
})

describe('buildTaskRows', () => {
  it('renders an orphan (parent unknown) as a root instead of hiding it', () => {
    const store = applyTaskTreeSnapshot({}, 's', [node({ id: 'lonely', parentTaskId: 'missing-parent' })])
    const rows = buildTaskRows(store.s)
    expect(rows.map(r => r.id)).toEqual(['lonely'])
    expect(rows[0]!.level).toBe(0)
  })

  it('survives a cycle in the data', () => {
    const store = applyTaskTreeSnapshot({}, 's', [
      node({ id: 'a', parentTaskId: 'b' }),
      node({ id: 'b', parentTaskId: 'a' }),
    ])
    const rows = buildTaskRows(store.s)
    expect(flattenTaskRows(rows, new Set(['a', 'b'])).length).toBeLessThanOrEqual(2)
  })

  it('sorts siblings by creation time', () => {
    const store = applyTaskTreeSnapshot({}, 's', [
      node({ id: 'second', createdAt: '2025-09-15 10:00:05' }),
      node({ id: 'first', createdAt: '2025-09-15 10:00:01' }),
    ])
    expect(buildTaskRows(store.s).map(r => r.id)).toEqual(['first', 'second'])
  })

  it('collapsed shows only the direct tasks', () => {
    const store = applyTaskTreeSnapshot({}, 's', [
      node({ id: 'top', hasChildren: true }),
      node({ id: 'sub', parentTaskId: 'top' }),
    ])
    expect(flattenTaskRows(buildTaskRows(store.s), new Set()).map(r => r.id)).toEqual(['top'])
    expect(flattenTaskRows(buildTaskRows(store.s), new Set(['top'])).map(r => r.id)).toEqual(['top', 'sub'])
  })
})

describe('elapsed counter', () => {
  it('reads a SQLite timestamp as UTC', () => {
    expect(parseTaskTimestamp('2025-09-15 10:00:00')).toBe(Date.UTC(2025, 8, 15, 10, 0, 0))
    expect(parseTaskTimestamp('2025-09-15T10:00:00.000Z')).toBe(Date.UTC(2025, 8, 15, 10, 0, 0))
    expect(parseTaskTimestamp(null)).toBeNull()
  })

  it('counts up while the task runs and freezes when it is done', () => {
    const now = Date.UTC(2025, 8, 15, 10, 1, 30)
    const running = node({ id: 'r', startedAt: '2025-09-15 10:00:00' })
    expect(elapsedSeconds(running, now)).toBe(90)

    const done = node({ id: 'd', status: 'completed', startedAt: '2025-09-15 10:00:00', completedAt: '2025-09-15 10:00:20' })
    expect(elapsedSeconds(done, now)).toBe(20)
  })

  it('falls back to createdAt for a task that has not started yet', () => {
    const queued = node({ id: 'q', startedAt: null, createdAt: '2025-09-15 10:00:00' })
    expect(elapsedSeconds(queued, Date.UTC(2025, 8, 15, 10, 0, 5))).toBe(5)
  })

  it('formats as m:ss and h:mm:ss', () => {
    expect(formatElapsed(7)).toBe('0:07')
    expect(formatElapsed(83)).toBe('1:23')
    expect(formatElapsed(725)).toBe('12:05')
    expect(formatElapsed(7391)).toBe('2:03:11')
    expect(formatElapsed(null)).toBe('—')
  })
})

describe('live task usage counters', () => {
  it('updates usage and cost, preserves them on sparse frames, and accepts zero', () => {
    let store = applyTaskActivityFrame({}, {
      type: 'task_started', sessionId: 'strand', taskId: 'task',
      taskPromptTokens: 78, taskCompletionTokens: 8221,
      taskCacheRead: 1308532, taskCacheWrite: 55092, taskEstimatedCost: 1.204506,
    })
    expect(store.strand!.nodes.task).toMatchObject({ promptTokens: 78, completionTokens: 8221, cacheRead: 1308532, cacheWrite: 55092, estimatedCost: 1.204506 })
    store = applyTaskActivityFrame(store, { type: 'task_progress', sessionId: 'strand', taskId: 'task', taskCompletionTokens: 9000 })
    expect(store.strand!.nodes.task).toMatchObject({ promptTokens: 78, completionTokens: 9000, estimatedCost: 1.204506 })
    store = applyTaskActivityFrame(store, { type: 'task_finished', sessionId: 'strand', taskId: 'task', taskPromptTokens: 0, taskEstimatedCost: 0 })
    expect(store.strand!.nodes.task).toMatchObject({ promptTokens: 0, completionTokens: 9000, estimatedCost: 0 })
  })
})
