import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { buildTaskFilterClause, TaskStore } from './task-store.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('TaskStore', () => {
  let db: Database
  let store: TaskStore
  const tmpFiles: string[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-task-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('create', () => {
    it('creates a task with all required fields', () => {
      const task = store.create({
        name: 'Test Task',
        prompt: 'Build a React app',
        triggerType: 'agent',
      })

      expect(task.id).toBeTruthy()
      expect(task.name).toBe('Test Task')
      expect(task.prompt).toBe('Build a React app')
      expect(task.status).toBe('running')
      expect(task.triggerType).toBe('agent')
      expect(task.promptTokens).toBe(0)
      expect(task.completionTokens).toBe(0)
      expect(task.cacheRead).toBe(0)
      expect(task.cacheWrite).toBe(0)
      expect(task.estimatedCost).toBe(0)
      expect(task.toolCallCount).toBe(0)
      expect(task.createdAt).toBeTruthy()
    })

    it('creates a task with optional fields', () => {
      const task = store.create({
        name: 'Full Task',
        prompt: 'Do something',
        triggerType: 'user',
        triggerSourceId: 'source-1',
        provider: 'openai',
        model: 'gpt-4o',
        maxDurationMinutes: 30,
        sessionId: 'session-123',
      })

      expect(task.triggerType).toBe('user')
      expect(task.triggerSourceId).toBe('source-1')
      expect(task.provider).toBe('openai')
      expect(task.model).toBe('gpt-4o')
      expect(task.maxDurationMinutes).toBe(30)
      expect(task.sessionId).toBe('session-123')
    })

    it('defaults isDefaultModel to null when not provided', () => {
      const task = store.create({
        name: 'Legacy Task',
        prompt: 'test',
        triggerType: 'agent',
      })

      expect(task.isDefaultModel).toBeNull()
    })

    it('persists isDefaultModel=true for tasks using the default provider', () => {
      const task = store.create({
        name: 'Default Task',
        prompt: 'test',
        triggerType: 'agent',
        provider: 'openai',
        model: 'gpt-4o',
        isDefaultModel: true,
      })

      expect(task.isDefaultModel).toBe(true)
    })

    it('persists isDefaultModel=false for tasks with an explicit provider override', () => {
      const task = store.create({
        name: 'Pinned Task',
        prompt: 'test',
        triggerType: 'agent',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        isDefaultModel: false,
      })

      expect(task.isDefaultModel).toBe(false)
    })
  })

  describe('getById', () => {
    it('returns a task by ID', () => {
      const created = store.create({
        name: 'Find Me',
        prompt: 'test',
        triggerType: 'agent',
      })

      const found = store.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Find Me')
    })

    it('returns null for non-existent ID', () => {
      const found = store.getById('non-existent')
      expect(found).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all tasks ordered by created_at DESC', () => {
      store.create({ name: 'Task 1', prompt: 'p1', triggerType: 'agent' })
      store.create({ name: 'Task 2', prompt: 'p2', triggerType: 'user' })
      store.create({ name: 'Task 3', prompt: 'p3', triggerType: 'agent' })

      const tasks = store.list()
      expect(tasks).toHaveLength(3)
      // Most recent first
      expect(tasks[0].name).toBe('Task 3')
    })

    it('filters by status', () => {
      store.create({ name: 'Running', prompt: 'p1', triggerType: 'agent' })
      const t2 = store.create({ name: 'Completed', prompt: 'p2', triggerType: 'agent' })
      store.update(t2.id, { status: 'completed' })

      const running = store.list({ status: 'running' })
      expect(running).toHaveLength(1)
      expect(running[0].name).toBe('Running')

      const completed = store.list({ status: 'completed' })
      expect(completed).toHaveLength(1)
      expect(completed[0].name).toBe('Completed')
    })

    it('filters by triggerType', () => {
      store.create({ name: 'Agent Task', prompt: 'p1', triggerType: 'agent' })
      store.create({ name: 'User Task', prompt: 'p2', triggerType: 'user' })

      const agentTasks = store.list({ triggerType: 'agent' })
      expect(agentTasks).toHaveLength(1)
      expect(agentTasks[0].name).toBe('Agent Task')
    })

    it('filters by default-provider flag and provider/model', () => {
      store.create({
        name: 'Default Task',
        prompt: 'p1',
        triggerType: 'agent',
        provider: 'OpenAI',
        model: 'gpt-4o',
        isDefaultModel: true,
      })
      store.create({
        name: 'Pinned Task',
        prompt: 'p2',
        triggerType: 'agent',
        provider: 'Anthropic',
        model: 'claude-sonnet-4-5',
        isDefaultModel: false,
      })

      const defaultTasks = store.list({ isDefaultModel: true })
      expect(defaultTasks).toHaveLength(1)
      expect(defaultTasks[0].name).toBe('Default Task')

      const providerModelTasks = store.list({ provider: 'Anthropic', model: 'claude-sonnet-4-5' })
      expect(providerModelTasks).toHaveLength(1)
      expect(providerModelTasks[0].name).toBe('Pinned Task')
    })

    it('filters by created date range', () => {
      const oldTask = store.create({ name: 'Old Task', prompt: 'p1', triggerType: 'agent' })
      const recentTask = store.create({ name: 'Recent Task', prompt: 'p2', triggerType: 'agent' })
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2024-01-01 10:00:00', oldTask.id)
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run('2024-01-03 10:00:00', recentTask.id)

      const tasks = store.list({ createdFrom: '2024-01-02 00:00:00', createdTo: '2024-01-03 23:59:59' })
      expect(tasks).toHaveLength(1)
      expect(tasks[0].name).toBe('Recent Task')
    })

    it('keeps created date filters sargable for indexes', () => {
      const clause = buildTaskFilterClause({
        createdFrom: '2024-01-02 00:00:00',
        createdTo: '2024-01-03 23:59:59',
      })

      expect(clause.sql).toContain('created_at >= ?')
      expect(clause.sql).toContain('created_at <= ?')
      expect(clause.sql).not.toContain('datetime(created_at)')
    })

    it('supports limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        store.create({ name: `Task ${i}`, prompt: `p${i}`, triggerType: 'agent' })
      }

      const page1 = store.list({ limit: 2 })
      expect(page1).toHaveLength(2)

      const page2 = store.list({ limit: 2, offset: 2 })
      expect(page2).toHaveLength(2)
    })
  })

  describe('update', () => {
    it('updates task status', () => {
      const task = store.create({ name: 'Test', prompt: 'p', triggerType: 'agent' })
      const updated = store.update(task.id, { status: 'completed' })

      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('completed')
    })

    it('updates token usage and tool call count', () => {
      const task = store.create({ name: 'Test', prompt: 'p', triggerType: 'agent' })
      store.update(task.id, {
        promptTokens: 1000,
        completionTokens: 500,
        cacheRead: 4000,
        cacheWrite: 250,
        estimatedCost: 0.05,
        toolCallCount: 10,
      })

      const found = store.getById(task.id)!
      expect(found.promptTokens).toBe(1000)
      expect(found.completionTokens).toBe(500)
      expect(found.cacheRead).toBe(4000)
      expect(found.cacheWrite).toBe(250)
      expect(found.estimatedCost).toBeCloseTo(0.05)
      expect(found.toolCallCount).toBe(10)
    })

    it('updates result fields', () => {
      const task = store.create({ name: 'Test', prompt: 'p', triggerType: 'agent' })
      store.update(task.id, {
        resultSummary: 'All done!',
        resultStatus: 'completed',
        completedAt: '2026-01-01 12:00:00',
      })

      const found = store.getById(task.id)!
      expect(found.resultSummary).toBe('All done!')
      expect(found.resultStatus).toBe('completed')
      expect(found.completedAt).toBe('2026-01-01 12:00:00')
    })

    it('updates error fields for failed tasks', () => {
      const task = store.create({ name: 'Test', prompt: 'p', triggerType: 'agent' })
      store.update(task.id, {
        status: 'failed',
        resultStatus: 'failed',
        errorMessage: 'Something went wrong',
      })

      const found = store.getById(task.id)!
      expect(found.status).toBe('failed')
      expect(found.resultStatus).toBe('failed')
      expect(found.errorMessage).toBe('Something went wrong')
    })

    it('returns null for non-existent ID', () => {
      const result = store.update('non-existent', { status: 'completed' })
      expect(result).toBeNull()
    })

    it('returns unchanged task when no fields provided', () => {
      const task = store.create({ name: 'Test', prompt: 'p', triggerType: 'agent' })
      const result = store.update(task.id, {})
      expect(result).not.toBeNull()
      expect(result!.name).toBe('Test')
    })
  })

  describe('delete', () => {
    it('deletes an existing task', () => {
      const task = store.create({ name: 'Delete Me', prompt: 'p', triggerType: 'agent' })
      const deleted = store.delete(task.id)

      expect(deleted).toBe(true)
      expect(store.getById(task.id)).toBeNull()
    })

    it('returns false for non-existent ID', () => {
      const deleted = store.delete('non-existent')
      expect(deleted).toBe(false)
    })
  })

  describe('consolidation trigger type', () => {
    it('creates a task with consolidation trigger type', () => {
      const task = store.create({
        name: 'Nightly Consolidation',
        prompt: 'Consolidate memory',
        triggerType: 'consolidation',
        triggerSourceId: 'memory-consolidation',
      })

      expect(task.id).toBeTruthy()
      expect(task.triggerType).toBe('consolidation')
      expect(task.triggerSourceId).toBe('memory-consolidation')
      expect(task.status).toBe('running')
    })

    it('filters by consolidation trigger type', () => {
      store.create({ name: 'Agent Task', prompt: 'p1', triggerType: 'agent' })
      store.create({ name: 'Consolidation Task', prompt: 'p2', triggerType: 'consolidation' })
      store.create({ name: 'User Task', prompt: 'p3', triggerType: 'user' })

      const consolidationTasks = store.list({ triggerType: 'consolidation' })
      expect(consolidationTasks).toHaveLength(1)
      expect(consolidationTasks[0].name).toBe('Consolidation Task')
    })

    it('does not affect other trigger types', () => {
      store.create({ name: 'Agent', prompt: 'p1', triggerType: 'agent' })
      store.create({ name: 'User', prompt: 'p2', triggerType: 'user' })
      store.create({ name: 'Cronjob', prompt: 'p3', triggerType: 'cronjob' })
      store.create({ name: 'Heartbeat', prompt: 'p4', triggerType: 'heartbeat' })
      store.create({ name: 'Consolidation', prompt: 'p5', triggerType: 'consolidation' })

      const all = store.list()
      expect(all).toHaveLength(5)

      const agentTasks = store.list({ triggerType: 'agent' })
      expect(agentTasks).toHaveLength(1)
      expect(agentTasks[0].name).toBe('Agent')

      const heartbeatTasks = store.list({ triggerType: 'heartbeat' })
      expect(heartbeatTasks).toHaveLength(1)
      expect(heartbeatTasks[0].name).toBe('Heartbeat')
    })
  })

  describe('tasks table schema', () => {
    it('has all required columns', () => {
      const cols = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
      const colNames = cols.map(c => c.name)

      expect(colNames).toContain('id')
      expect(colNames).toContain('name')
      expect(colNames).toContain('prompt')
      expect(colNames).toContain('status')
      expect(colNames).toContain('trigger_type')
      expect(colNames).toContain('trigger_source_id')
      expect(colNames).toContain('provider')
      expect(colNames).toContain('model')
      expect(colNames).toContain('max_duration_minutes')
      expect(colNames).toContain('prompt_tokens')
      expect(colNames).toContain('completion_tokens')
      expect(colNames).toContain('estimated_cost')
      expect(colNames).toContain('tool_call_count')
      expect(colNames).toContain('result_summary')
      expect(colNames).toContain('result_status')
      expect(colNames).toContain('error_message')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('started_at')
      expect(colNames).toContain('completed_at')
      expect(colNames).toContain('session_id')
    })

    it('indexes task provider filters', () => {
      const indexes = db.prepare('PRAGMA index_list(tasks)').all() as { name: string }[]
      const indexNames = indexes.map(index => index.name)

      expect(indexNames).toContain('idx_tasks_provider_model_created_at')
      expect(indexNames).toContain('idx_tasks_model_created_at')
      expect(indexNames).toContain('idx_tasks_is_default_model_created_at')
    })
  })
})
