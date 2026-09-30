import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { listTasksTool } from './task-tools.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

/**
 * `list_tasks` must show what a delegating task really cost (P7a): its own
 * row plus every sub-task below it.
 */
describe('list_tasks chain cost', () => {
  let db: Database
  let store: TaskStore
  let dbPath: string

  function runtimeFor(ids: string[]): TaskRuntimeTaskBoundary {
    return {
      list: () => ids.map(id => store.getById(id)!),
    } as unknown as TaskRuntimeTaskBoundary
  }

  function make(name: string, parentId: string | null, promptTokens: number, cost: number): string {
    const task = store.create({
      name,
      prompt: 'x',
      triggerType: parentId ? 'agent' : 'user',
      ...(parentId ? { triggerSourceId: parentId } : {}),
    })
    store.update(task.id, { promptTokens, completionTokens: 0, estimatedCost: cost })
    return task.id
  }

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `ot-list-tasks-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('adds a sub-task cost line for delegating tasks only', async () => {
    const parent = make('Orchestrator', null, 100, 0.25)
    make('Worker A', parent, 1000, 1.5)
    make('Worker B', parent, 2000, 2.25)
    const solo = make('Solo', null, 50, 0.1)

    const tool = listTasksTool({ taskRuntime: runtimeFor([parent, solo]), db })
    const result = await tool.execute('c1', {}, undefined as never) as {
      content: Array<{ text?: string }>
      details: { count: number; subtreeCosts: Array<Record<string, unknown>> }
    }
    const text = result.content.map(c => c.text ?? '').join('')

    expect(text).toContain('Incl. 2 sub-task(s): Tokens: 3100 | Cost: $4.0000')
    // The parent's own line keeps its own numbers.
    expect(text).toContain('Tokens: 100 | Cost: $0.2500')
    // A childless task gets no extra line.
    expect(text.match(/Incl\./g)).toHaveLength(1)

    expect(result.details.count).toBe(2)
    expect(result.details.subtreeCosts).toHaveLength(1)
    expect(result.details.subtreeCosts[0]).toMatchObject({
      taskId: parent,
      descendants: 2,
      promptTokens: 3100,
      estimatedCost: 4,
    })
  })

  it('works without a db handle (no chain costs, no crash)', async () => {
    const parent = make('Orchestrator', null, 100, 0.25)
    make('Worker', parent, 1000, 1.5)

    const tool = listTasksTool({ taskRuntime: runtimeFor([parent]) })
    const result = await tool.execute('c1', {}, undefined as never) as {
      content: Array<{ text?: string }>
      details: { count: number; subtreeCosts?: unknown[] }
    }
    const text = result.content.map(c => c.text ?? '').join('')
    expect(text).toContain('Orchestrator')
    expect(text).not.toContain('Incl.')
    expect(result.details.subtreeCosts).toEqual([])
  })
})
