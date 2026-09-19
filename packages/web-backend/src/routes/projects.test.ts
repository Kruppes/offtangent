/**
 * Offtangent Stufe 2: /api/projects — the grouping layer the Android app and
 * the web inbox read, so the shapes are pinned here.
 *
 * Backed by a REAL ProjectManager/SessionManager on an in-memory DB: a stub
 * would not catch what actually matters (ownership scoping and the fact that
 * deleting a project detaches threads instead of deleting them).
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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-projects-routes-'))
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
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function createProject(name: string, color?: string, bearer = token): Promise<Project> {
  const created = await api('POST', '/api/projects', { name, ...(color !== undefined ? { color } : {}) }, bearer)
  expect(created.status).toBe(201)
  return created.body.project as Project
}

describe('POST /api/projects', () => {
  it('creates a project and returns the full wire shape', async () => {
    const { status, body } = await api('POST', '/api/projects', { name: '  Umzug  ', color: '#4F46E5' })
    expect(status).toBe(201)
    const project = body.project as Project
    expect(project).toMatchObject({
      name: 'Umzug',
      color: '#4f46e5',
      archived: false,
      threadCount: 0,
    })
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(project.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(Object.keys(project).sort()).toEqual(
      ['archived', 'color', 'createdAt', 'id', 'name', 'threadCount', 'updatedAt'],
    )
  })

  it('defaults color to null', async () => {
    expect((await createProject('No colour')).color).toBeNull()
  })

  it('rejects an empty, over-long or non-string name with 400', async () => {
    expect((await api('POST', '/api/projects', { name: '   ' })).status).toBe(400)
    const tooLong = await api('POST', '/api/projects', { name: 'x'.repeat(81) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.error).toMatch(/at most 80/)
    expect((await api('POST', '/api/projects', { name: 42 })).status).toBe(400)
    expect((await api('POST', '/api/projects', {})).status).toBe(400)
  })

  it('rejects a malformed color with 400', async () => {
    const bad = await api('POST', '/api/projects', { name: 'A', color: 'red' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/hex string/)
    expect((await api('POST', '/api/projects', { name: 'A', color: '#fff' })).status).toBe(400)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/projects`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

describe('GET /api/projects', () => {
  it('lists own projects, active first then alphabetically, archived only on demand', async () => {
    await createProject('beta')
    await createProject('Alpha')
    const archived = await createProject('aardvark')
    await api('PATCH', `/api/projects/${archived.id}`, { archived: true })

    const { status, body } = await api('GET', '/api/projects')
    expect(status).toBe(200)
    expect((body.projects as Project[]).map(p => p.name)).toEqual(['Alpha', 'beta'])

    const withArchived = await api('GET', '/api/projects?include_archived=1')
    expect((withArchived.body.projects as Project[]).map(p => p.name)).toEqual(['Alpha', 'beta', 'aardvark'])
  })

  it('never leaks another user projects', async () => {
    await createProject('mine')
    await createProject('theirs', undefined, otherToken)

    expect(((await api('GET', '/api/projects')).body.projects as Project[]).map(p => p.name)).toEqual(['mine'])
    expect(((await api('GET', '/api/projects', undefined, otherToken)).body.projects as Project[]).map(p => p.name))
      .toEqual(['theirs'])
  })

  it('reports threadCount over non-archived threads only', async () => {
    const project = await createProject('Counted')
    await api('POST', '/api/threads', { agentId: 'bob', title: 'one', projectId: project.id })
    const archivedThread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'two', projectId: project.id })).body.thread as Thread
    await api('POST', '/api/threads', { agentId: 'bob', title: 'loose' })

    expect(((await api('GET', '/api/projects')).body.projects as Project[])[0].threadCount).toBe(2)
    await api('PATCH', `/api/threads/${archivedThread.id}`, { archived: true })
    expect(((await api('GET', '/api/projects')).body.projects as Project[])[0].threadCount).toBe(1)
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/projects`)
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/projects/:id', () => {
  it('renames, recolours and archives', async () => {
    const project = await createProject('before', '#111111')

    const renamed = await api('PATCH', `/api/projects/${project.id}`, { name: 'after' })
    expect(renamed.status).toBe(200)
    expect(renamed.body.project).toMatchObject({ name: 'after', color: '#111111', archived: false })

    const cleared = await api('PATCH', `/api/projects/${project.id}`, { color: null })
    expect(cleared.body.project).toMatchObject({ name: 'after', color: null })

    const archived = await api('PATCH', `/api/projects/${project.id}`, { archived: true })
    expect(archived.body.project).toMatchObject({ archived: true })

    const unarchived = await api('PATCH', `/api/projects/${project.id}`, { archived: false })
    expect(unarchived.body.project).toMatchObject({ archived: false })
  })

  it('404s for unknown and foreign projects without touching them', async () => {
    const foreign = await createProject('theirs', undefined, otherToken)

    expect((await api('PATCH', '/api/projects/does-not-exist', { name: 'x' })).status).toBe(404)
    const attempt = await api('PATCH', `/api/projects/${foreign.id}`, { name: 'hijacked' })
    expect(attempt.status).toBe(404)
    expect((db.prepare('SELECT name FROM projects WHERE id = ?').get(foreign.id) as { name: string }).name).toBe('theirs')
  })

  it('rejects malformed fields with 400', async () => {
    const project = await createProject('valid')
    expect((await api('PATCH', `/api/projects/${project.id}`, { name: '' })).status).toBe(400)
    expect((await api('PATCH', `/api/projects/${project.id}`, { name: 'x'.repeat(81) })).status).toBe(400)
    expect((await api('PATCH', `/api/projects/${project.id}`, { color: 'blue' })).status).toBe(400)
    expect((await api('PATCH', `/api/projects/${project.id}`, { archived: 1 })).status).toBe(400)
  })
})

describe('DELETE /api/projects/:id', () => {
  it('deletes the project and detaches its threads', async () => {
    const project = await createProject('Doomed')
    const thread = (await api('POST', '/api/threads', { agentId: 'bob', title: 'keep me', projectId: project.id })).body.thread as Thread

    const { status, body } = await api('DELETE', `/api/projects/${project.id}`)
    expect(status).toBe(204)
    expect(body).toEqual({})
    expect((await api('GET', '/api/projects')).body.projects).toEqual([])

    const threads = (await api('GET', '/api/threads')).body.threads as Thread[]
    expect(threads.map(t => t.id)).toEqual([thread.id])
    expect(threads[0].projectId).toBeNull()
  })

  it('404s for unknown and foreign projects', async () => {
    const foreign = await createProject('theirs', undefined, otherToken)

    expect((await api('DELETE', '/api/projects/does-not-exist')).status).toBe(404)
    expect((await api('DELETE', `/api/projects/${foreign.id}`)).status).toBe(404)
    expect(db.prepare('SELECT id FROM projects WHERE id = ?').get(foreign.id)).toBeDefined()
  })

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/projects/whatever`, { method: 'DELETE' })
    expect(res.status).toBe(401)
  })
})
