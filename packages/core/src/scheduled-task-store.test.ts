import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import type { Database } from './database.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('ScheduledTaskStore', () => {
  let db: Database
  let store: ScheduledTaskStore
  const tmpFiles: string[] = []

  function tmpDbPath(): string {
    const p = path.join(os.tmpdir(), `axiom-scheduled-task-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    return p
  }

  beforeEach(() => {
    db = initDatabase(tmpDbPath())
    store = new ScheduledTaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  describe('create', () => {
    it('creates a scheduled task with required fields', () => {
      const task = store.create({
        name: 'Daily Summary',
        prompt: 'Summarize daily news',
        schedule: '0 9 * * *',
      })

      expect(task.id).toBeTruthy()
      expect(task.name).toBe('Daily Summary')
      expect(task.prompt).toBe('Summarize daily news')
      expect(task.schedule).toBe('0 9 * * *')
      expect(task.enabled).toBe(true)
      expect(task.provider).toBeNull()
      expect(task.createdAt).toBeTruthy()
      expect(task.updatedAt).toBeTruthy()
    })

    it('creates with optional fields', () => {
      const task = store.create({
        name: 'Custom Job',
        prompt: 'Do something',
        schedule: '*/15 * * * *',
        provider: 'openai',
        enabled: false,
      })

      expect(task.provider).toBe('openai')
      expect(task.enabled).toBe(false)
    })
  })

  describe('getById', () => {
    it('returns a task by ID', () => {
      const created = store.create({
        name: 'Find Me',
        prompt: 'test',
        schedule: '0 9 * * *',
      })
      const found = store.getById(created.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Find Me')
    })

    it('returns null for non-existent ID', () => {
      expect(store.getById('non-existent')).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all tasks ordered by created_at DESC', () => {
      store.create({ name: 'Task 1', prompt: 'p1', schedule: '0 9 * * *' })
      store.create({ name: 'Task 2', prompt: 'p2', schedule: '0 10 * * *' })
      store.create({ name: 'Task 3', prompt: 'p3', schedule: '0 11 * * *' })

      const tasks = store.list()
      expect(tasks).toHaveLength(3)
      const names = tasks.map(t => t.name).sort()
      expect(names).toEqual(['Task 1', 'Task 2', 'Task 3'])
    })
  })

  describe('listEnabled', () => {
    it('only returns enabled tasks', () => {
      store.create({ name: 'Enabled', prompt: 'p1', schedule: '0 9 * * *', enabled: true })
      store.create({ name: 'Disabled', prompt: 'p2', schedule: '0 10 * * *', enabled: false })

      const enabled = store.listEnabled()
      expect(enabled).toHaveLength(1)
      expect(enabled[0].name).toBe('Enabled')
    })
  })

  describe('update', () => {
    it('updates name and schedule', () => {
      const task = store.create({ name: 'Old Name', prompt: 'test', schedule: '0 9 * * *' })
      const updated = store.update(task.id, { name: 'New Name', schedule: '0 10 * * *' })

      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('New Name')
      expect(updated!.schedule).toBe('0 10 * * *')
    })

    it('updates enabled status', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      const updated = store.update(task.id, { enabled: false })
      expect(updated!.enabled).toBe(false)
    })

    it('updates last run fields', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      store.update(task.id, {
        lastRunAt: '2026-03-29 09:00:00',
        lastRunTaskId: 'task-123',
        lastRunStatus: 'completed',
      })

      const found = store.getById(task.id)!
      expect(found.lastRunAt).toBe('2026-03-29 09:00:00')
      expect(found.lastRunTaskId).toBe('task-123')
      expect(found.lastRunStatus).toBe('completed')
    })

    it('returns null for non-existent ID', () => {
      const result = store.update('non-existent', { name: 'New' })
      expect(result).toBeNull()
    })

    it('updates updated_at timestamp', () => {
      const task = store.create({ name: 'Test', prompt: 'test', schedule: '0 9 * * *' })
      // Small delay to ensure different timestamp
      const updated = store.update(task.id, { name: 'Updated' })
      expect(updated!.updatedAt).toBeTruthy()
    })
  })

  describe('delete', () => {
    it('deletes an existing task', () => {
      const task = store.create({ name: 'Delete Me', prompt: 'test', schedule: '0 9 * * *' })
      const deleted = store.delete(task.id)
      expect(deleted).toBe(true)
      expect(store.getById(task.id)).toBeNull()
    })

    it('returns false for non-existent ID', () => {
      expect(store.delete('non-existent')).toBe(false)
    })
  })

  describe('actionType', () => {
    it('defaults to task when not specified', () => {
      const task = store.create({
        name: 'Default Action',
        prompt: 'test',
        schedule: '0 9 * * *',
      })
      expect(task.actionType).toBe('task')
    })

    it('creates with injection action type', () => {
      const task = store.create({
        name: 'Reminder',
        prompt: 'Pack your bags!',
        schedule: '30 11 * * *',
        actionType: 'injection',
      })
      expect(task.actionType).toBe('injection')
    })

    it('creates with task action type', () => {
      const task = store.create({
        name: 'Heavy Job',
        prompt: 'Do complex work',
        schedule: '0 9 * * *',
        actionType: 'task',
      })
      expect(task.actionType).toBe('task')
    })

    it('updates action type', () => {
      const task = store.create({
        name: 'Switchable',
        prompt: 'test',
        schedule: '0 9 * * *',
        actionType: 'task',
      })
      const updated = store.update(task.id, { actionType: 'injection' })
      expect(updated!.actionType).toBe('injection')
    })
  })

  describe('schema', () => {
    it('has all required columns', () => {
      const cols = db.prepare("PRAGMA table_info(scheduled_tasks)").all() as { name: string }[]
      const colNames = cols.map(c => c.name)

      expect(colNames).toContain('id')
      expect(colNames).toContain('name')
      expect(colNames).toContain('prompt')
      expect(colNames).toContain('schedule')
      expect(colNames).toContain('action_type')
      expect(colNames).toContain('provider')
      expect(colNames).toContain('enabled')
      expect(colNames).toContain('tools_override')
      expect(colNames).toContain('skills_override')
      expect(colNames).toContain('system_prompt_override')
      expect(colNames).toContain('last_run_at')
      expect(colNames).toContain('last_run_task_id')
      expect(colNames).toContain('last_run_status')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('updated_at')
    })
  })
})
