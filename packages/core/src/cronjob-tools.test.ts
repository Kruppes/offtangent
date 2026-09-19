import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initDatabase } from './database.js'
import { ScheduledTaskStore } from './scheduled-task-store.js'
import type { ScheduledTask } from './scheduled-task-store.js'
import { createCronjobTool, editCronjobTool } from './cronjob-tools.js'
import type { TaskRuntimeScheduleBoundary } from './task-runtime.js'
import type { Database } from './database.js'

/**
 * Build a thin in-memory TaskRuntimeScheduleBoundary backed by the real
 * ScheduledTaskStore. register/unregister/triggerNow/getActiveSchedules are
 * stubs — the cronjob tools don't exercise the scheduler, only the store.
 */
function buildScheduleBoundary(db: Database): TaskRuntimeScheduleBoundary {
  const store = new ScheduledTaskStore(db)
  return {
    create: (input) => store.create(input),
    getById: (id) => store.getById(id),
    list: () => store.list(),
    listEnabled: () => store.listEnabled(),
    update: (id, updates) => store.update(id, updates),
    delete: (id) => store.delete(id),
    register: () => {},
    unregister: () => {},
    triggerNow: async () => null,
    getActiveSchedules: () => [],
    start: () => {},
    stop: () => {},
    restart: () => {},
  }
}

describe('cronjob-tools: attachedSkills', () => {
  let db: Database
  let dbPath: string
  let boundary: TaskRuntimeScheduleBoundary

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `axiom-cronjob-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    db = initDatabase(dbPath)
    boundary = buildScheduleBoundary(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
  })

  it('create_cronjob persists attached_skills when provided', async () => {
    const tool = createCronjobTool({ taskRuntime: boundary })
    const result = await tool.execute('call-1', {
      name: 'Daily Nitter Scan',
      prompt: 'Scan Nitter for mentions.',
      schedule: '0 9 * * *',
      attached_skills: ['nitter', 'reddit'],
    })
    expect(result.details?.error).not.toBe(true)
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['nitter', 'reddit'])

    const stored = boundary.getById(details.cronjobId)!
    expect(stored.attachedSkills).toEqual(['nitter', 'reddit'])
  })

  it('create_cronjob normalizes attached_skills (dedupe + trim + drop empty)', async () => {
    const tool = createCronjobTool({ taskRuntime: boundary })
    const result = await tool.execute('call-2', {
      name: 'N',
      prompt: 'P',
      schedule: '0 9 * * *',
      attached_skills: ['nitter', '  nitter  ', '', 'reddit'],
    })
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['nitter', 'reddit'])
  })

  it('create_cronjob without attached_skills stores null (backward-compatible)', async () => {
    const tool = createCronjobTool({ taskRuntime: boundary })
    const result = await tool.execute('call-3', {
      name: 'Legacy',
      prompt: 'P',
      schedule: '0 9 * * *',
    })
    const details = result.details as { cronjobId: string; attachedSkills: string[] | null }
    expect(details.attachedSkills).toBeNull()

    const stored = boundary.getById(details.cronjobId)!
    expect(stored.attachedSkills).toBeNull()
  })

  it('edit_cronjob replaces the attached_skills list', async () => {
    // Seed a cronjob
    const seed: ScheduledTask = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter'],
    })

    const edit = editCronjobTool({ taskRuntime: boundary })
    const result = await edit.execute('call-4', {
      id: seed.id,
      attached_skills: ['reddit', 'wiki'],
    })
    const details = result.details as { attachedSkills: string[] | null }
    expect(details.attachedSkills).toEqual(['reddit', 'wiki'])

    const stored = boundary.getById(seed.id)!
    expect(stored.attachedSkills).toEqual(['reddit', 'wiki'])
  })

  it('edit_cronjob with attached_skills: [] clears the list', async () => {
    const seed = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter', 'reddit'],
    })

    const edit = editCronjobTool({ taskRuntime: boundary })
    const result = await edit.execute('call-5', {
      id: seed.id,
      attached_skills: [],
    })
    const details = result.details as { attachedSkills: string[] | null }
    expect(details.attachedSkills).toBeNull()

    const stored = boundary.getById(seed.id)!
    expect(stored.attachedSkills).toBeNull()
  })

  it('edit_cronjob without attached_skills leaves the list unchanged', async () => {
    const seed = boundary.create({
      name: 'Seed',
      prompt: 'P',
      schedule: '0 9 * * *',
      attachedSkills: ['nitter'],
    })

    const edit = editCronjobTool({ taskRuntime: boundary })
    await edit.execute('call-6', {
      id: seed.id,
      name: 'Seed renamed',
    })

    const stored = boundary.getById(seed.id)!
    expect(stored.name).toBe('Seed renamed')
    expect(stored.attachedSkills).toEqual(['nitter'])
  })
})
