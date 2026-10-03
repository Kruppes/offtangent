import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Database } from '@axiom/core'
import { dismissStrandTasks, initDatabase, initTasksTable, TaskStore } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

/**
 * W7: the global task list says which strand a task belongs to and whether
 * it is dismissed there, so the list can acknowledge entries through the
 * strand contract. Synthetic sessions and tasks only.
 */
let db: Database
let server: http.Server
let baseUrl: string
let tempDataDir: string
let previousDataDir: string | undefined

const owner = generateAccessToken({ userId: 1, username: 'owner', role: 'admin' })
const other = generateAccessToken({ userId: 2, username: 'other', role: 'admin' })

function session(id: string, userId: number, type: string, parent: string | null) {
  db.prepare('INSERT INTO sessions (id, user_id, type, parent_session_id) VALUES (?, ?, ?, ?)').run(id, userId, type, parent)
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-tasks-strand-activity-'))
  process.env.DATA_DIR = tempDataDir
  db = initDatabase(':memory:')
  initTasksTable(db)
  server = http.createServer(createApp({ db }))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('GET /api/tasks strand activity fields (W7)', () => {
  it('names the owning strand, reports dismissedAt and hides foreign or strandless tasks', async () => {
    session('strand-w7', 1, 'interactive', null)
    session('task-w7-a', 1, 'task', 'strand-w7')
    session('task-w7-sub', 1, 'task', 'task-w7-a')
    session('task-w7-cron', 1, 'task', null)
    const store = new TaskStore(db)
    const direct = store.create({ name: 'Direct', prompt: 'p', triggerType: 'user', sessionId: 'task-w7-a' })
    const sub = store.create({ name: 'Sub', prompt: 'p', triggerType: 'agent', triggerSourceId: direct.id, sessionId: 'task-w7-sub' })
    const cron = store.create({ name: 'Cron', prompt: 'p', triggerType: 'cronjob', sessionId: 'task-w7-cron' })
    store.update(direct.id, { status: 'completed', resultStatus: 'completed', completedAt: '2026-10-03 10:00:00' })
    store.update(sub.id, { status: 'completed', resultStatus: 'completed', completedAt: '2026-10-03 10:00:00' })

    // The dismissal itself goes through the strand contract (tested in the
    // strands module); here only its reflection in the global list matters.
    dismissStrandTasks(db, 'strand-w7', [direct.id], '2026-10-03T10:05:00.000Z')

    const res = await fetch(`${baseUrl}/api/tasks?limit=50`, { headers: { Authorization: `Bearer ${owner}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as { tasks: Array<{ id: string; strandId: string | null; dismissedAt: string | null }> }
    const byId = new Map(body.tasks.map(t => [t.id, t]))
    expect(byId.get(direct.id)).toMatchObject({ strandId: 'strand-w7' })
    expect(byId.get(direct.id)?.dismissedAt).toBe('2026-10-03T10:05:00.000Z')
    expect(byId.get(sub.id)).toMatchObject({ strandId: 'strand-w7', dismissedAt: null })
    expect(byId.get(cron.id)).toMatchObject({ strandId: null, dismissedAt: null })

    // Another user sees the rows (admin list) but never the strand id of a
    // strand that is not theirs: no dismiss offer, no existence oracle.
    const foreign = await fetch(`${baseUrl}/api/tasks?limit=50`, { headers: { Authorization: `Bearer ${other}` } })
    const foreignBody = await foreign.json() as { tasks: Array<{ id: string; strandId: string | null; dismissedAt: string | null }> }
    expect(foreignBody.tasks.find(t => t.id === direct.id)).toMatchObject({ strandId: null, dismissedAt: null })
  })
})
