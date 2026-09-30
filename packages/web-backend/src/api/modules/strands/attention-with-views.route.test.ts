/**
 * Release integration check for the two 2026-09-26 plans in one strand:
 * the attention field of `feat/strand-attention` and the living views of
 * `feat/global-canvas`. One strand carries BOTH an open question card and a
 * view with two revisions, so a regression in either merge shows up here.
 *
 * `GET /api/strands` must report `attention` for that strand, and
 * `GET /api/artifacts/views?strandId=` must report the view with its
 * revisions — the same strand, the same request cycle, one real app.
 *
 * Fixtures are synthetic (alice/bob placeholder users, an invented wheel
 * report); nothing here comes from a capture or a dictation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, recordMessageArtifacts, saveUpload, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createApp } from '../../../app.js'
import { generateAccessToken } from '../../../auth.js'

interface Attention {
  kind: 'interaction' | 'task_question'
  since: string
  prompt: string
  messageId: number | null
  taskId: string | null
}
interface StrandView { id: string; unread: boolean; attention: Attention | null }
interface ViewEntry {
  viewKey: string
  title: string
  latestRevision: number
  revisions: Array<{ revision: number; artifactId: string; messageId: number; title: string }>
}

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
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-attention-views-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'bob', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  server = http.createServer(createApp({
    db,
    getAgentCore: () => agentCore,
    getTurnRunner: () => ({ startTurn: () => ({}) }),
  } as Parameters<typeof createApp>[0]))
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
  otherToken = generateAccessToken({ userId: 2, username: 'bob', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM artifacts; DELETE FROM chat_messages; DELETE FROM tasks; DELETE FROM sessions;')
})

async function get(url: string, authToken = token) {
  const res = await fetch(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${authToken}` } })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

/** An assistant message with an unanswered choice card, as the runtime writes it. */
function insertOpenQuestion(sessionId: string, blockId: string, question: string): number {
  const payload = { block: 'choice', id: blockId, question, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] }
  const content = `That is your call.\n\n\`\`\`offtangent\n${JSON.stringify(payload)}\n\`\`\``
  return Number(db.prepare(
    `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
     VALUES (?, 1, 'assistant', ?, 'main', ?)`,
    // Relative, not a calendar date: attention drops a card older than
    // `ATTENTION_MAX_AGE_MS` (48 h), so a fixed date would go stale.
  ).run(sessionId, content, new Date(Date.now() - 45 * 60_000).toISOString().replace('T', ' ').slice(0, 19)).lastInsertRowid)
}

/** One revision of a living view, delivered the way a task delivery does it. */
function insertViewRevision(sessionId: string, viewKey: string, label: string) {
  const messageId = Number(db.prepare(
    "INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', ?, 'main')",
  ).run(sessionId, `Delivered ${label}`).lastInsertRowid)
  const upload = saveUpload({
    buffer: Buffer.from(`<!doctype html><title>${label}</title>`, 'utf8'),
    originalName: `${label.replace(/\s+/g, '-')}.html`,
    mimeType: 'text/html; charset=utf-8',
    source: 'web',
    userId: 1,
    sessionId,
  })
  upload.viewKey = viewKey
  const result = recordMessageArtifacts(db, {
    messageId,
    strandId: sessionId,
    userId: 1,
    agentId: 'main',
    content: '',
    uploads: [upload],
  })
  return { messageId, artifact: result.artifacts[0]! }
}

describe('a strand with an open question card and a living view', () => {
  it('reports attention on GET /api/strands and the view on GET /api/artifacts/views', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Wheel build')
    const quiet = sessionManager.createThread('1', 'main', 'Nothing open here')
    const messageId = insertOpenQuestion(strand.id, 'wheel-1', 'Should the rim be drilled?')
    const first = insertViewRevision(strand.id, 'wheel-report', 'Wheel report round 1')
    const second = insertViewRevision(strand.id, 'wheel-report', 'Wheel report round 2')

    // 1. attention (feat/strand-attention) is set on the list read.
    const list = await get('/api/strands')
    expect(list.status).toBe(200)
    const strands = list.body.strands as StrandView[]
    const view = strands.find(s => s.id === strand.id)!
    expect(view.attention).toMatchObject({
      kind: 'interaction',
      prompt: 'Should the rim be drilled?',
      messageId,
      taskId: null,
    })
    expect(strands.find(s => s.id === quiet.id)!.attention).toBeNull()

    // ... and the same strand survives the attention filter and the summary.
    const filtered = await get('/api/strands?attention=1')
    expect(filtered.status).toBe(200)
    expect((filtered.body.strands as StrandView[]).map(s => s.id)).toEqual([strand.id])
    const summary = await get('/api/strands/attention-summary')
    expect(summary.status).toBe(200)
    expect(summary.body).toMatchObject({ awaiting: 1, firstAwaitingStrandId: strand.id })

    // 2. the living view (feat/global-canvas) is there for that same strand.
    const views = await get(`/api/artifacts/views?strandId=${strand.id}`)
    expect(views.status).toBe(200)
    const entries = views.body.views as ViewEntry[]
    const entry = entries.find(v => v.viewKey === 'wheel-report')!
    expect(entry.latestRevision).toBe(2)
    expect(entry.revisions.map(r => r.revision)).toEqual([1, 2])
    expect(entry.revisions[0]!.artifactId).toBe(first.artifact.id)
    expect(entry.revisions[1]!.artifactId).toBe(second.artifact.id)
    expect(entry.revisions[1]!.messageId).toBe(second.messageId)

    // 3. neither read leaks into the other user.
    expect((await get('/api/strands', otherToken)).body.strands).toEqual([])
    const foreignViews = await get(`/api/artifacts/views?strandId=${strand.id}`, otherToken)
    expect(foreignViews.status).toBe(200)
    expect(foreignViews.body.views).toEqual([])
  })

  it('keeps the view after the question is answered, and drops only the attention', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Wheel build')
    const messageId = insertOpenQuestion(strand.id, 'wheel-2', 'Should the rim be drilled?')
    insertViewRevision(strand.id, 'wheel-report', 'Wheel report round 1')

    const answer = await fetch(`${baseUrl}/api/interactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, blockId: 'wheel-2', value: 'yes', clientMessageId: 'cmid-attn-views-1' }),
    })
    expect(answer.status).toBe(200)

    const strands = (await get('/api/strands')).body.strands as StrandView[]
    expect(strands.find(s => s.id === strand.id)!.attention).toBeNull()

    const entries = (await get(`/api/artifacts/views?strandId=${strand.id}`)).body.views as ViewEntry[]
    expect(entries.map(v => v.viewKey)).toEqual(['wheel-report'])
    expect(entries[0]!.latestRevision).toBe(1)
  })
})
