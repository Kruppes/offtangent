import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_OLDER_AFTER_MS,
  applyTaskActivityFrame,
  applyTaskTreeSnapshot,
  buildTaskRows,
  isDismissable,
  partitionActivity,
  setDismissed,
  type StrandTaskNode,
} from './taskActivity'

// W6c: which roots the activity panel shows, folds or hides. Synthetic data.
const NOW = Date.parse('2026-10-02T21:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString()

function node(over: Partial<StrandTaskNode> & Pick<StrandTaskNode, 'id'>): StrandTaskNode {
  return {
    name: over.id, status: 'completed', resultStatus: 'completed', triggerType: 'agent', agentId: 'main',
    parentTaskId: null, depth: 0, hasChildren: false, createdAt: hoursAgo(1), startedAt: hoursAgo(1),
    completedAt: hoursAgo(1), errorMessage: null, toolCallCount: 0, sessionId: null, ...over,
  }
}
const rows = (nodes: StrandTaskNode[]) => buildTaskRows(applyTaskTreeSnapshot({}, 's', nodes).s)
const ids = (list: { id: string }[]) => list.map(r => r.id)

describe('activity partition (W6c)', () => {
  it('keeps live, failed and recent finished roots open; folds finished roots older than 24 h', () => {
    const p = partitionActivity(rows([
      node({ id: 'a-live', status: 'running', completedAt: null, createdAt: hoursAgo(50) }),
      node({ id: 'b-paused', status: 'paused', completedAt: null, createdAt: hoursAgo(50) }),
      node({ id: 'c-recent', completedAt: hoursAgo(2), createdAt: hoursAgo(3) }),
      node({ id: 'd-old', completedAt: hoursAgo(30), createdAt: hoursAgo(31) }),
      node({ id: 'e-old-failed', status: 'failed', completedAt: hoursAgo(72), createdAt: hoursAgo(73) }),
    ]), NOW)
    expect(ids(p.open).sort()).toEqual(['a-live', 'b-paused', 'c-recent', 'e-old-failed'])
    expect(ids(p.older)).toEqual(['d-old'])
    expect(p.hidden).toEqual([])
    expect(ACTIVITY_OLDER_AFTER_MS).toBe(24 * 3600_000)
  })

  it('a root stands for its subtree: a live child keeps it open and not dismissable, a failed child keeps it from folding', () => {
    const tree = rows([
      node({ id: 'root', completedAt: hoursAgo(40), createdAt: hoursAgo(41) }),
      node({ id: 'child', parentTaskId: 'root', status: 'running', completedAt: null }),
      node({ id: 'root2', completedAt: hoursAgo(40), createdAt: hoursAgo(41) }),
      node({ id: 'child2', parentTaskId: 'root2', status: 'failed', completedAt: hoursAgo(40) }),
    ])
    const p = partitionActivity(tree, NOW)
    expect(ids(p.open).sort()).toEqual(['root', 'root2'])
    expect(isDismissable(tree.find(r => r.id === 'root')!)).toBe(false)
    expect(isDismissable(tree.find(r => r.id === 'root2')!)).toBe(true)
  })

  it('hides a root only when its whole subtree is dismissed, failed ones included; live ones never', () => {
    const p = partitionActivity(rows([
      node({ id: 'f', status: 'failed', dismissedAt: hoursAgo(1) }),
      node({ id: 'g', dismissedAt: hoursAgo(1) }),
      node({ id: 'g1', parentTaskId: 'g' }),
      node({ id: 'live', status: 'running', completedAt: null, dismissedAt: hoursAgo(1) }),
    ]), NOW)
    expect(ids(p.hidden)).toEqual(['f'])
    expect(ids(p.open).sort()).toEqual(['g', 'live'])
  })

  it('setDismissed marks and clears; a later live frame keeps the mark', () => {
    let store = applyTaskTreeSnapshot({}, 's', [node({ id: 'x' }), node({ id: 'y' })])
    store = setDismissed(store, 's', ['x', 'missing'], '2026-10-02T20:00:00.000Z')
    expect(store.s!.nodes.x!.dismissedAt).toBe('2026-10-02T20:00:00.000Z')
    expect(store.s!.nodes.y!.dismissedAt).toBeUndefined()
    store = applyTaskActivityFrame(store, { type: 'task_progress', sessionId: 's', taskId: 'x' })
    expect(store.s!.nodes.x!.dismissedAt).toBe('2026-10-02T20:00:00.000Z')
    store = setDismissed(store, 's', ['x'], null)
    expect(store.s!.nodes.x!.dismissedAt).toBeNull()
    expect(setDismissed(store, 'unknown', ['x'], null)).toBe(store)
  })
})
