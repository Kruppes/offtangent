import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import {
  getTaskCostSummary,
  getSubtreeCostForTasks,
  findTasksWithSubTasks,
  totalTokens,
} from './task-cost.js'

describe('task cost aggregation', () => {
  let db: Database
  let store: TaskStore
  let dbPath: string

  function makeTask(name: string, parentId: string | null, usage: {
    promptTokens?: number
    completionTokens?: number
    cacheRead?: number
    cacheWrite?: number
    estimatedCost?: number
    toolCallCount?: number
  }): string {
    const task = store.create({
      name,
      prompt: 'x',
      triggerType: parentId ? 'agent' : 'user',
      ...(parentId ? { triggerSourceId: parentId } : {}),
    })
    store.update(task.id, {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      estimatedCost: usage.estimatedCost ?? 0,
      toolCallCount: usage.toolCallCount ?? 0,
    })
    return task.id
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ot-task-cost-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('returns null for an unknown task', () => {
    expect(getTaskCostSummary(db, 'nope')).toBeNull()
  })

  it('reports own == subtree for a childless task', () => {
    const id = makeTask('solo', null, { promptTokens: 100, completionTokens: 20, cacheRead: 900, estimatedCost: 0.5, toolCallCount: 3 })
    const summary = getTaskCostSummary(db, id)!
    expect(summary.descendants).toBe(0)
    expect(summary.own).toEqual(summary.subtree)
    expect(summary.own.estimatedCost).toBe(0.5)
    expect(totalTokens(summary.own)).toBe(1020)
    // 900 / (100 + 900)
    expect(summary.own.cacheReadRatio).toBeCloseTo(0.9, 6)
  })

  it('aggregates children and grandchildren into the parent', () => {
    const root = makeTask('root', null, { promptTokens: 10, completionTokens: 1, estimatedCost: 0.1, toolCallCount: 1 })
    const child = makeTask('child', root, { promptTokens: 20, completionTokens: 2, estimatedCost: 0.2, toolCallCount: 2 })
    makeTask('grandchild', child, { promptTokens: 40, completionTokens: 4, estimatedCost: 0.4, toolCallCount: 4 })

    const summary = getTaskCostSummary(db, root)!
    expect(summary.own.promptTokens).toBe(10)
    expect(summary.own.estimatedCost).toBeCloseTo(0.1, 6)
    expect(summary.subtree.tasks).toBe(3)
    expect(summary.descendants).toBe(2)
    expect(summary.subtree.promptTokens).toBe(70)
    expect(summary.subtree.completionTokens).toBe(7)
    expect(summary.subtree.toolCalls).toBe(7)
    expect(summary.subtree.estimatedCost).toBeCloseTo(0.7, 6)
    expect(summary.maxDepth).toBe(2)
    expect(summary.truncated).toBe(false)

    // The child keeps its own smaller subtree.
    const childSummary = getTaskCostSummary(db, child)!
    expect(childSummary.subtree.promptTokens).toBe(60)
    expect(childSummary.descendants).toBe(1)
  })

  it('ignores non-delegation trigger types on the edge', () => {
    const root = makeTask('root', null, { promptTokens: 10 })
    // A cronjob row whose trigger_source_id points at a cronjob id that
    // happens to equal a task id must not be billed to that task.
    const cron = store.create({ name: 'cron', prompt: 'x', triggerType: 'cronjob', triggerSourceId: root })
    store.update(cron.id, { promptTokens: 999 })

    const summary = getTaskCostSummary(db, root)!
    expect(summary.descendants).toBe(0)
    expect(summary.subtree.promptTokens).toBe(10)
  })

  it('stops at the depth limit and reports truncation', () => {
    const root = makeTask('root', null, { promptTokens: 1 })
    let parent = root
    for (let i = 0; i < 5; i++) {
      parent = makeTask(`gen-${i}`, parent, { promptTokens: 1 })
    }

    const deep = getTaskCostSummary(db, root, { maxDepth: 2 })!
    expect(deep.subtree.tasks).toBe(3)
    expect(deep.maxDepth).toBe(2)
    expect(deep.truncated).toBe(true)

    const full = getTaskCostSummary(db, root, { maxDepth: 10 })!
    expect(full.subtree.tasks).toBe(6)
    expect(full.truncated).toBe(false)
  })

  it('survives a cyclic trigger_source_id chain', () => {
    const a = makeTask('a', null, { promptTokens: 1 })
    const b = makeTask('b', a, { promptTokens: 2 })
    // Force the cycle b -> a (only reachable through a corrupted row).
    db.prepare('UPDATE tasks SET trigger_source_id = ?, trigger_type = ? WHERE id = ?').run(b, 'agent', a)

    const summary = getTaskCostSummary(db, a)!
    expect(summary.subtree.tasks).toBeLessThanOrEqual(2)
    expect(summary.subtree.promptTokens).toBeLessThanOrEqual(3)
  })

  it('batches subtree costs and skips childless tasks', () => {
    const parent = makeTask('parent', null, { promptTokens: 5 })
    makeTask('child', parent, { promptTokens: 7 })
    const solo = makeTask('solo', null, { promptTokens: 3 })

    expect(findTasksWithSubTasks(db, [parent, solo])).toEqual(new Set([parent]))

    const map = getSubtreeCostForTasks(db, [parent, solo])
    expect(map.has(solo)).toBe(false)
    expect(map.get(parent)!.subtree.promptTokens).toBe(12)
    expect(map.get(parent)!.descendants).toBe(1)
  })
})
