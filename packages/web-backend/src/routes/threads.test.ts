/**
 * Offtangent Stufe 1: /api/threads — the Home inbox and the thread view are
 * built exclusively on this contract, so the shapes are pinned here.
 *
 * Backed by a REAL SessionManager on an in-memory DB: a stubbed manager would
 * not catch the thing that actually matters (ownership scoping and the
 * interactive-only filter).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database, Project, Thread } from '@axiom/core'
import { createApp } from '../app.js'
import { generateAccessToken } from '../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-threads-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = createApp({ db, getAgentCore: () => agentCore })
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'other', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM projects;')
})

async function api(
  method: string,
  url: string,
  body?: unknown,
  bearer = token,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  // 204 (DELETE) has no body at all.
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

describe('POST /api/threads', () => {
  it('creates a thread for a persona and does not make it active', async () => {
    const { status, body } = await api('POST', '/api/threads', { agentId: 'bob', title: 'Deploy plan' })
    expect(status).toBe(201)
    const thread = body.thread as Thread
    expect(thread).toMatchObject({
      agentId: 'bob',
      title: 'Deploy plan',
      pinned: false,
      archived: false,
      messageCount: 0,
      lastMessage: null,
      endedAt: null,
      active: false,
    })
    expect(thread.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(thread.startedAt).toString()).not.toBe('Invalid Date')

    const row = db.prepare('SELECT type, source, session_user, agent_id, title FROM sessions WHERE id = ?').get(thread.id)
    expect(row).toEqual({ type: 'interactive', source: 'web', session_user: '1', agent_id: 'bob', title: 'Deploy plan' })
  })

  it("defaults to 'main' without agentId and refuses unknown personas", async () => {
    const created = await api('POST', '/api/threads', { title: 'no persona' })
    expect(created.status).toBe(201)
    expect((created.body.thread as Thread).agentId).toBe('main')

    const refused = await api('POST', '/api/threads', { agentId: 'gekko' })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('Unknown agentId')
  })

  it('rejects a non-string title', async () => {
    const { status } = await api('POST', '/api/threads', { agentId: 'bob', title: 42 })
    expect(status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/threads`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/threads', () => {
  it('lists own threads by last activity, with last message preview', async () => {
    const a = (await api('POST', '/api/threads', { agentId: 'bob', title: 'A' })).body.thread as Thread
    const b = (await api('POST', '/api/threads', { agentId: 'bob', title: 'B' })).body.thread as Thread
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
      .run(a.id, 'assistant', 'y'.repeat(300), 'bob')
    db.prepare("UPDATE sessions SET last_activity = '2026-09-12 09:00:00' WHERE id = ?").run(b.id)
    db.prepare("UPDATE sessions SET last_activity = '2026-09-12 11:00:00' WHERE id = ?").run(a.id)

    const { status, body } = await api('GET', '/api/threads')
    expect(status).toBe(200)
    const threads = body.threads as Thread[]
    expect(threads.map(t => t.id)).toEqual([a.id, b.id])
    expect(threads[0].lastMessage?.content).toHaveLength(200)
    expect(threads[0].lastMessage?.role).toBe('assistant')
    expect(threads[0].lastActivity).toBe('2026-09-12T11:00:00.000Z')
  })

  it('never leaks another user threads', async () => {
    await api('POST', '/api/threads', { agentId: 'bob', title: 'mine' })
    const theirs = await api('POST', '/api/threads', { agentId: 'bob', title: 'theirs' }, otherToken)
    expect(theirs.status).toBe(201)

    const mine = await api('GET', '/api/threads')
    expect((mine.body.threads as Thread[]).map(t => t.title)).toEqual(['mine'])
    const other = await api('GET', '/api/threads', undefined, otherToken)
    expect((other.body.threads as Thread[]).map(t => t.title)).toEqual(['theirs'])
  })

  it('filters by agent_id, hides archived by default, and validates the persona', async () => {
    const bobThread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'bob' })).body.thread as Thread
    await api('POST', '/api/threads', { agentId: 'main', title: 'main' })
    const archived = (await api('POST', '/api/threads', { agentId: 'bob', title: 'archived' })).body.thread as Thread
    await api('PATCH', `/api/threads/${archived.id}`, { archived: true })

    const bobOnly = await api('GET', '/api/threads?agent_id=bob')
    expect((bobOnly.body.threads as Thread[]).map(t => t.id)).toEqual([bobThread.id])

    const withArchived = await api('GET', '/api/threads?agent_id=bob&include_archived=1')
    expect((withArchived.body.threads as Thread[]).map(t => t.id).sort()).toEqual([bobThread.id, archived.id].sort())

    const unknown = await api('GET', '/api/threads?agent_id=gekko')
    expect(unknown.status).toBe(400)
  })

  it('treats an empty agent_id as "no filter", not as main', async () => {
    // The Android client builds the query string from its filter state; an
    // empty persona filter must not silently degrade to main's threads.
    const bobThread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'bob' })).body.thread as Thread
    const mainThread = (await api('POST', '/api/threads', { agentId: 'main', title: 'main' })).body.thread as Thread

    const empty = await api('GET', '/api/threads?agent_id=')
    expect(empty.status).toBe(200)
    expect((empty.body.threads as Thread[]).map(t => t.id).sort()).toEqual([bobThread.id, mainThread.id].sort())

    const unset = await api('GET', '/api/threads')
    expect((unset.body.threads as Thread[]).map(t => t.id).sort()).toEqual([bobThread.id, mainThread.id].sort())

    const explicit = await api('GET', '/api/threads?agent_id=main')
    expect((explicit.body.threads as Thread[]).map(t => t.id)).toEqual([mainThread.id])
  })

  it('honours limit and offset', async () => {
    for (let i = 0; i < 3; i++) {
      const created = (await api('POST', '/api/threads', { agentId: 'bob', title: `T${i}` })).body.thread as Thread
      db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(`2026-09-12 1${i}:00:00`, created.id)
    }
    const page1 = await api('GET', '/api/threads?limit=2')
    expect((page1.body.threads as Thread[]).map(t => t.title)).toEqual(['T2', 'T1'])
    const page2 = await api('GET', '/api/threads?limit=2&offset=2')
    expect((page2.body.threads as Thread[]).map(t => t.title)).toEqual(['T0'])
  })

  it('sorts pinned threads first, then by last activity (server-side)', async () => {
    // The inbox also pins client-side, but only the server sees every page:
    // with limit/offset a pinned thread on page 2 could never move up.
    const old = (await api('POST', '/api/threads', { agentId: 'bob', title: 'old pinned' })).body.thread as Thread
    const fresh = (await api('POST', '/api/threads', { agentId: 'bob', title: 'fresh' })).body.thread as Thread
    const middle = (await api('POST', '/api/threads', { agentId: 'bob', title: 'middle pinned' })).body.thread as Thread
    db.prepare("UPDATE sessions SET last_activity = '2026-09-10 08:00:00' WHERE id = ?").run(old.id)
    db.prepare("UPDATE sessions SET last_activity = '2026-09-12 08:00:00' WHERE id = ?").run(middle.id)
    db.prepare("UPDATE sessions SET last_activity = '2026-09-12 20:00:00' WHERE id = ?").run(fresh.id)
    await api('PATCH', `/api/threads/${old.id}`, { pinned: true })
    await api('PATCH', `/api/threads/${middle.id}`, { pinned: true })

    const { body } = await api('GET', '/api/threads')
    expect((body.threads as Thread[]).map(t => t.title)).toEqual(['middle pinned', 'old pinned', 'fresh'])

    // ... and the order survives paging.
    const page1 = await api('GET', '/api/threads?limit=1')
    expect((page1.body.threads as Thread[]).map(t => t.title)).toEqual(['middle pinned'])
    const page2 = await api('GET', '/api/threads?limit=1&offset=1')
    expect((page2.body.threads as Thread[]).map(t => t.title)).toEqual(['old pinned'])
  })

  it('does not list background sessions as threads', async () => {
    sessionManager.createSession({ type: 'task', source: 'task', userId: '1', agentId: 'bob' })
    const { body } = await api('GET', '/api/threads')
    expect(body.threads).toEqual([])
  })
})

describe('threads × projects', () => {
  async function createProject(name: string, bearer = token): Promise<Project> {
    const created = await api('POST', '/api/projects', { name }, bearer)
    expect(created.status).toBe(201)
    return created.body.project as Project
  }

  it('creates a thread inside a project and reports projectId', async () => {
    const project = await createProject('Umzug')
    const { status, body } = await api('POST', '/api/threads', { agentId: 'bob', title: 'Kisten', projectId: project.id })
    expect(status).toBe(201)
    expect((body.thread as Thread).projectId).toBe(project.id)
  })

  it('defaults projectId to null', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob' })).body.thread as Thread
    expect(thread.projectId).toBeNull()
  })

  it('moves a thread into a project and back out via PATCH', async () => {
    const project = await createProject('Umzug')
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Kisten' })).body.thread as Thread

    const moved = await api('PATCH', `/api/threads/${thread.id}`, { projectId: project.id })
    expect(moved.status).toBe(200)
    expect((moved.body.thread as Thread).projectId).toBe(project.id)

    const detached = await api('PATCH', `/api/threads/${thread.id}`, { projectId: null })
    expect((detached.body.thread as Thread).projectId).toBeNull()
  })

  it('refuses unknown, foreign and archived projects with 400 project_not_found', async () => {
    const foreign = await createProject('theirs', otherToken)
    const archived = await createProject('archived')
    await api('PATCH', `/api/projects/${archived.id}`, { archived: true })
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Kisten' })).body.thread as Thread

    for (const projectId of ['does-not-exist', foreign.id, archived.id]) {
      const patched = await api('PATCH', `/api/threads/${thread.id}`, { projectId })
      expect(patched.status).toBe(400)
      expect(patched.body).toEqual({ error: 'Project not found', code: 'project_not_found' })

      const created = await api('POST', '/api/threads', { agentId: 'bob', projectId })
      expect(created.status).toBe(400)
      expect(created.body.code).toBe('project_not_found')
    }

    // Neither the thread nor the session table changed.
    expect(((await api('GET', `/api/threads`)).body.threads as Thread[]).map(t => t.id)).toEqual([thread.id])
    expect((await api('GET', '/api/threads')).body.threads).toHaveLength(1)
  })

  it('rejects a non-string projectId with 400', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob' })).body.thread as Thread
    expect((await api('PATCH', `/api/threads/${thread.id}`, { projectId: 42 })).status).toBe(400)
    expect((await api('POST', '/api/threads', { agentId: 'bob', projectId: 42 })).status).toBe(400)
  })

  it('filters by project_id=<id> and project_id=none, ignoring an empty value', async () => {
    const project = await createProject('Umzug')
    const other = await createProject('Steuer')
    const inProject = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Kisten', projectId: project.id })).body.thread as Thread
    const inOther = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Belege', projectId: other.id })).body.thread as Thread
    const loose = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Loose' })).body.thread as Thread

    const filtered = await api('GET', `/api/threads?project_id=${project.id}`)
    expect((filtered.body.threads as Thread[]).map(t => t.id)).toEqual([inProject.id])

    const none = await api('GET', '/api/threads?project_id=none')
    expect((none.body.threads as Thread[]).map(t => t.id)).toEqual([loose.id])

    const empty = await api('GET', '/api/threads?project_id=')
    expect((empty.body.threads as Thread[]).map(t => t.id).sort())
      .toEqual([inProject.id, inOther.id, loose.id].sort())

    const unknown = await api('GET', '/api/threads?project_id=does-not-exist')
    expect(unknown.status).toBe(200)
    expect(unknown.body.threads).toEqual([])
  })

  it('keeps the thread when its project is deleted', async () => {
    const project = await createProject('Doomed')
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'Kisten', projectId: project.id })).body.thread as Thread

    expect((await api('DELETE', `/api/projects/${project.id}`)).status).toBe(204)
    const threads = (await api('GET', '/api/threads')).body.threads as Thread[]
    expect(threads.map(t => t.id)).toEqual([thread.id])
    expect(threads[0].projectId).toBeNull()
  })
})

describe('PATCH /api/threads/:id', () => {
  it('renames, pins and archives', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'before' })).body.thread as Thread

    const renamed = await api('PATCH', `/api/threads/${thread.id}`, { title: 'after' })
    expect(renamed.status).toBe(200)
    expect((renamed.body.thread as Thread).title).toBe('after')

    const pinned = await api('PATCH', `/api/threads/${thread.id}`, { pinned: true })
    expect((pinned.body.thread as Thread)).toMatchObject({ pinned: true, title: 'after' })

    const archived = await api('PATCH', `/api/threads/${thread.id}`, { archived: true })
    expect((archived.body.thread as Thread)).toMatchObject({ archived: true, pinned: true })

    const cleared = await api('PATCH', `/api/threads/${thread.id}`, { title: null })
    expect((cleared.body.thread as Thread).title).toBeNull()
  })

  it('404s for unknown and foreign threads without touching them', async () => {
    const foreign = (await api('POST', '/api/threads', { agentId: 'bob', title: 'theirs' }, otherToken)).body.thread as Thread

    expect((await api('PATCH', '/api/threads/does-not-exist', { pinned: true })).status).toBe(404)
    const attempt = await api('PATCH', `/api/threads/${foreign.id}`, { title: 'hijacked' })
    expect(attempt.status).toBe(404)
    expect((db.prepare('SELECT title FROM sessions WHERE id = ?').get(foreign.id) as { title: string }).title).toBe('theirs')
  })

  it('rejects malformed field types', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob' })).body.thread as Thread
    expect((await api('PATCH', `/api/threads/${thread.id}`, { pinned: 'yes' })).status).toBe(400)
    expect((await api('PATCH', `/api/threads/${thread.id}`, { archived: 1 })).status).toBe(400)
    expect((await api('PATCH', `/api/threads/${thread.id}`, { title: {} })).status).toBe(400)
  })
})

describe('DELETE /api/threads/:id', () => {
  it('deletes an empty thread and removes the row', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'oops' })).body.thread as Thread

    const { status, body } = await api('DELETE', `/api/threads/${thread.id}`)
    expect(status).toBe(204)
    expect(body).toEqual({})
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(thread.id)).toBeUndefined()
    expect((await api('GET', '/api/threads')).body.threads).toEqual([])
  })

  it('refuses a thread that has messages with 409 thread_not_empty', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'real' })).body.thread as Thread
    db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, ?, ?, ?)')
      .run(thread.id, 'user', 'hello', 'bob')
    db.prepare('UPDATE sessions SET message_count = 1 WHERE id = ?').run(thread.id)

    const { status, body } = await api('DELETE', `/api/threads/${thread.id}`)
    expect(status).toBe(409)
    expect(body.code).toBe('thread_not_empty')
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(thread.id)).toBeDefined()
  })

  it('404s for unknown and foreign threads without deleting them', async () => {
    const foreign = (await api('POST', '/api/threads', { agentId: 'bob', title: 'theirs' }, otherToken)).body.thread as Thread

    expect((await api('DELETE', '/api/threads/does-not-exist')).status).toBe(404)
    expect((await api('DELETE', `/api/threads/${foreign.id}`)).status).toBe(404)
    expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(foreign.id)).toBeDefined()
  })

  it('releases the session slot when the deleted thread was active', async () => {
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'active' })).body.thread as Thread
    sessionManager.activateSession('1', thread.id, 'bob')
    expect(sessionManager.getSession('1', 'bob')?.id).toBe(thread.id)

    expect((await api('DELETE', `/api/threads/${thread.id}`)).status).toBe(204)
    expect(sessionManager.getSession('1', 'bob')).toBeUndefined()
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/threads/whatever`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/threads/:id/context-stats (SPEC 11.5)', () => {
  it('returns cache numbers and the summary version for an own thread, 404 for a foreign one', async () => {
    const created = await api('POST', '/api/threads', { agentId: 'main', title: 'Cache' })
    const thread = created.body.thread as Thread
    db.prepare('UPDATE sessions SET prompt_tokens = 1000, cache_read = 3000, cache_write = 500 WHERE id = ?').run(thread.id)

    const own = await api('GET', `/api/threads/${thread.id}/context-stats`)
    expect(own.status).toBe(200)
    const stats = own.body.stats as Record<string, unknown>
    expect(stats.promptTokens).toBe(1000)
    expect(stats.cacheRead).toBe(3000)
    expect(stats.cacheReadRatio).toBe(0.75)
    expect(stats.summaryVersion).toBe(0)

    const foreign = await api('GET', `/api/threads/${thread.id}/context-stats`, undefined, otherToken)
    expect(foreign.status).toBe(404)
  })
})
