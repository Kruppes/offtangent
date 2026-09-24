/**
 * /api/strands, /api/tags, /api/now, /api/resurface (SPEC 6.2, 6.3) against
 * a real SessionManager and in-memory database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, saveProviders, SessionManager, insertSessionSummary, putStrandProjectSuggestion } from '@axiom/core'
import type { AgentCore, Database, Tag, Thread } from '@axiom/core'
import { createStrandsRouters } from './route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import type { ChatEvent } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let otherToken: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let events: ChatEvent[] = []
let evicted: Array<{ userId: string; agentId: string; sessionId: string }> = []
let busySessions: string[] = []
/** Stands in for the `offtangent.nowSetMax` setting. */
let nowSetMax = 4

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-strands-routes-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'bob'), { recursive: true })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = {
    getSessionManager: () => sessionManager,
    evictSessionTranscript: (userId: string, agentId: string, sessionId: string) => {
      evicted.push({ userId, agentId, sessionId })
    },
  } as unknown as AgentCore
  const bus = new ChatEventBus()
  bus.subscribe(e => events.push(e))

  const app = express()
  app.use(express.json())
  const routers = createStrandsRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: bus,
    getTurnRunner: () => ({
      hasActiveTurnInSession: (_user: number | string, sessionId: string) => busySessions.includes(sessionId),
    }),
    getNowSetMax: () => nowSetMax,
    // This suite is about the curated set; the auto ranking has its own tests.
    getNowSetMode: () => 'manual',
  })
  app.use('/api/strands', routers.strands)
  app.use('/api/tags', routers.tags)
  app.use('/api/now', routers.now)
  app.use('/api/resurface', routers.resurface)

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
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set; DELETE FROM resurface_snoozes; DELETE FROM session_summaries; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM memories; DELETE FROM tasks; DELETE FROM tool_calls; DELETE FROM projects; DELETE FROM strand_project_suggestions; DELETE FROM strand_project_dismissals; DELETE FROM strand_project_runs;')
  events = []
  evicted = []
  busySessions = []
  nowSetMax = 4
  saveProviders({
    providers: [
      { id: 'anthropic', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['default-model'] },
      { id: 'openai', name: 'OpenAI', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: '', enabledModels: ['pinned-model'], modelStatuses: { 'pinned-model': 'connected' } },
    ],
    activeProvider: 'anthropic',
    activeModel: 'default-model',
    fallbackProvider: 'openai',
    fallbackModel: 'pinned-model',
  })
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

describe('strand model selection', () => {
  it('pins a valid model, exposes its effective source, audits the change, and unpins it', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Model test')
    const pinned = await api('PATCH', `/api/strands/${strand.id}/model`, {
      providerId: 'openai', modelId: 'pinned-model',
    })
    expect(pinned.status).toBe(200)
    expect(pinned.body).toMatchObject({
      pinnedModel: { providerId: 'openai', modelId: 'pinned-model' },
      effectiveModel: { providerId: 'openai', modelId: 'pinned-model', source: 'strand' },
    })
    const detail = await api('GET', `/api/strands/${strand.id}`)
    expect(detail.body.strand).toMatchObject({
      pinnedModel: { providerId: 'openai', modelId: 'pinned-model' },
      effectiveModel: { source: 'strand' },
    })
    const audit = db.prepare("SELECT content FROM chat_messages WHERE session_id = ? AND role = 'system'").get(strand.id) as { content: string }
    expect(audit.content).toContain('default-model → pinned-model')

    const unpinned = await api('PATCH', `/api/strands/${strand.id}/model`, { providerId: null, modelId: null })
    expect(unpinned.body).toMatchObject({ pinnedModel: null, effectiveModel: { modelId: 'default-model', source: 'global' } })
  })

  it('rejects disabled/error models and foreign strands', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Protected')
    expect((await api('PATCH', `/api/strands/${strand.id}/model`, { providerId: 'openai', modelId: 'disabled' })).status).toBe(400)
    expect((await api('PATCH', `/api/strands/${strand.id}/model`, { providerId: 'openai', modelId: 'pinned-model' }, otherToken)).status).toBe(404)
  })
})

describe('tags', () => {
  it('creates, lists, renames and archives tags per user', async () => {
    const created = await api('POST', '/api/tags', { name: 'Haus Dach', color: '#112233' })
    expect(created.status).toBe(201)
    const tag = created.body.tag as Tag
    expect(tag.name).toBe('haus-dach')
    expect((await api('POST', '/api/tags', { name: 'haus-dach' })).status).toBe(200)
    expect((await api('POST', '/api/tags', { name: '' })).status).toBe(400)
    expect((await api('POST', '/api/tags', { name: 'x', color: 'blue' })).body.code).toBe('invalid_tag')

    const renamed = await api('PATCH', `/api/tags/${tag.id}`, { name: 'dach', archived: true })
    expect((renamed.body.tag as Tag).name).toBe('dach')
    expect((renamed.body.tag as Tag).archived).toBe(true)
    expect(((await api('GET', '/api/tags')).body.tags as Tag[]).length).toBe(0)
    expect(((await api('GET', '/api/tags?include_archived=1')).body.tags as Tag[]).length).toBe(1)
    expect((await api('PATCH', `/api/tags/${tag.id}`, { name: 'z' }, otherToken)).status).toBe(404)
    expect(((await api('GET', '/api/tags', undefined, otherToken)).body.tags as Tag[]).length).toBe(0)
  })
})

describe('strands', () => {
  it('sets strand tags, lists by tag and exposes tags, nowRank and links on threads', async () => {
    const a = sessionManager.createThread('1', 'main', 'A')
    const b = sessionManager.createThread('1', 'bob', 'B')
    const put = await api('PUT', `/api/strands/${a.id}/tags`, { tags: ['Haus', 'geld'] })
    expect(put.status).toBe(200)
    expect((put.body.strand as Thread).tags).toEqual(['geld', 'haus'])
    expect((await api('PUT', `/api/strands/${a.id}/tags`, { tags: 'nope' })).status).toBe(400)
    expect((await api('PUT', `/api/strands/${a.id}/tags`, { tags: [] }, otherToken)).status).toBe(404)

    const all = (await api('GET', '/api/strands')).body.strands as Thread[]
    expect(all.length).toBe(2)
    const byTag = (await api('GET', '/api/strands?tag=haus')).body.strands as Thread[]
    expect(byTag.map(s => s.id)).toEqual([a.id])
    expect(((await api('GET', '/api/strands?tag=unknown')).body.strands as Thread[]).length).toBe(0)
    expect(((await api('GET', '/api/strands?agent_id=bob')).body.strands as Thread[]).map(s => s.id)).toEqual([b.id])
    expect((await api('GET', '/api/strands?agent_id=ghost')).status).toBe(400)
    expect(all.every(s => s.nowRank === null && s.links === 0)).toBe(true)
  })
})

describe('now set', () => {
  it('holds at most four strands, validates ids, orders by rank and emits now_set_changed', async () => {
    const ids = [1, 2, 3, 4, 5].map(i => sessionManager.createThread('1', 'main', `S${i}`).id)
    const tooMany = await api('PUT', '/api/now', { strandIds: ids })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.code).toBe('now_set_too_large')

    const foreign = sessionManager.createThread('2', 'main', 'Not mine')
    expect((await api('PUT', '/api/now', { strandIds: [foreign.id] })).status).toBe(400)
    expect((await api('PUT', '/api/now', { strandIds: 'x' })).status).toBe(400)

    const set = await api('PUT', '/api/now', { strandIds: [ids[2], ids[0]] })
    expect(set.status).toBe(200)
    const strands = set.body.strands as Thread[]
    expect(strands.map(s => [s.id, s.nowRank])).toEqual([[ids[2], 1], [ids[0], 2]])
    expect(events.map(e => e.type)).toEqual(['now_set_changed'])
    expect(events[0].strandIds).toEqual([ids[2], ids[0]])

    const get = (await api('GET', '/api/now')).body.strands as Thread[]
    expect(get.map(s => s.id)).toEqual([ids[2], ids[0]])
    expect(((await api('GET', '/api/strands?now=1')).body.strands as Thread[]).map(s => s.id)).toEqual([ids[2], ids[0]])
    expect(((await api('GET', '/api/now', undefined, otherToken)).body.strands as Thread[]).length).toBe(0)

    expect(((await api('PUT', '/api/now', { strandIds: [] })).body.strands as Thread[]).length).toBe(0)
  })

  it('follows the configured size, reports it and names it in the error', async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7].map(i => sessionManager.createThread('1', 'main', `S${i}`).id)

    expect((await api('GET', '/api/now')).body.max).toBe(4)
    const tooManyAtFour = await api('PUT', '/api/now', { strandIds: ids.slice(0, 5) })
    expect(tooManyAtFour.status).toBe(400)
    expect(tooManyAtFour.body.error).toBe('The now set holds at most 4 strands')

    nowSetMax = 6
    const six = await api('PUT', '/api/now', { strandIds: ids.slice(0, 6) })
    expect(six.status).toBe(200)
    expect((six.body.strands as Thread[]).map(s => s.nowRank)).toEqual([1, 2, 3, 4, 5, 6])
    expect(six.body.max).toBe(6)

    const tooManyAtSix = await api('PUT', '/api/now', { strandIds: ids })
    expect(tooManyAtSix.status).toBe(400)
    expect(tooManyAtSix.body.code).toBe('now_set_too_large')
    expect(tooManyAtSix.body.error).toBe('The now set holds at most 6 strands')
  })

  it('keeps a set that is larger than a lowered size, and lists all of it', async () => {
    const ids = [1, 2, 3, 4, 5, 6].map(i => sessionManager.createThread('1', 'main', `S${i}`).id)
    nowSetMax = 6
    expect((await api('PUT', '/api/now', { strandIds: ids })).status).toBe(200)

    nowSetMax = 2
    const after = await api('GET', '/api/now')
    expect((after.body.strands as Thread[]).map(s => s.id)).toEqual(ids)
    expect(after.body.max).toBe(2)

    // Adding more is refused while the set is over the limit — nothing is dropped.
    expect((await api('PUT', '/api/now', { strandIds: [...ids, ids[0]] })).status).toBe(400)
    expect(((await api('GET', '/api/now')).body.strands as Thread[]).length).toBe(6)

    // Shrinking the set by hand stays possible and keeps the rest.
    expect((await api('PUT', '/api/now', { strandIds: ids.slice(0, 2) })).status).toBe(200)
    expect(((await api('GET', '/api/now')).body.strands as Thread[]).map(s => s.id)).toEqual(ids.slice(0, 2))
  })
})

describe('resurface', () => {
  it('offers dormant strands outside the now set, with the strongest reason, and honours snooze', async () => {
    const dormant = sessionManager.createThread('1', 'main', 'Dormant')
    const asked = sessionManager.createThread('1', 'main', 'Open question')
    const tagged = sessionManager.createThread('1', 'main', 'Tagged')
    const fresh = sessionManager.createThread('1', 'main', 'Fresh')
    const inNow = sessionManager.createThread('1', 'main', 'In now')
    const ancient = sessionManager.createThread('1', 'main', 'Ancient')
    for (const [t, days] of [[dormant, 5], [asked, 7], [tagged, 10], [fresh, 1], [inNow, 6], [ancient, 60]] as Array<[Thread, number]>) {
      db.prepare("UPDATE sessions SET message_count = 2, last_activity = datetime('now', ?) WHERE id = ?").run(`-${days} days`, t.id)
      db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'hello', 'main')").run(t.id)
    }
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'and what about the roof?', 'main')").run(asked.id)
    insertSessionSummary(db, tagged.id, { goal: 'Roof', decisions: [], open: [], artifacts: [], next: [] }, null, 'test')
    await api('PUT', `/api/strands/${tagged.id}/tags`, { tags: ['roof'] })
    await api('PUT', `/api/strands/${inNow.id}/tags`, { tags: ['roof'] })
    await api('PUT', '/api/now', { strandIds: [inNow.id] })

    const res = await api('GET', '/api/resurface?limit=5')
    expect(res.status).toBe(200)
    const items = res.body.items as Array<{ strandId: string; reason: string; summary: string; tags: string[] }>
    expect(items.map(i => [i.strandId, i.reason])).toEqual([
      [asked.id, 'unanswered'],
      [tagged.id, 'tag_match'],
      [dormant.id, 'dormant'],
    ])
    expect(items[1].summary).toBe('Roof')
    expect(items[1].tags).toEqual(['roof'])

    expect((await api('POST', `/api/resurface/${tagged.id}/snooze`, { days: 7 })).status).toBe(204)
    expect((await api('POST', `/api/resurface/${tagged.id}/snooze`, { days: 0 })).status).toBe(400)
    expect((await api('POST', `/api/resurface/${tagged.id}/snooze`, { days: 7 }, otherToken)).status).toBe(404)
    const after = (await api('GET', '/api/resurface')).body.items as Array<{ strandId: string }>
    expect(after.map(i => i.strandId)).toEqual([asked.id, dormant.id])
  })
})

describe('archive and un-archive (SPEC 7.5b)', () => {
  it('hides the strand, clears pin and now slot, keeps every row, and undo puts it back', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Smoke test 3')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'hello', 'main')").run(strand.id)
    db.prepare('UPDATE sessions SET message_count = 1 WHERE id = ?').run(strand.id)
    await api('PUT', '/api/now', { strandIds: [strand.id] })
    sessionManager.updateThread('1', strand.id, { pinned: true })
    events = []

    const archived = await api('PATCH', `/api/strands/${strand.id}`, { archived: true })
    expect(archived.status).toBe(200)
    expect((archived.body.strand as Thread).archived).toBe(true)
    expect((archived.body.strand as Thread).pinned).toBe(false)
    expect((archived.body.strand as Thread).nowRank).toBe(null)
    expect(events.map(e => e.type)).toEqual(['now_set_changed'])

    // Archive hides, it never destroys: session row and messages stay.
    const row = db.prepare('SELECT archived, message_count FROM sessions WHERE id = ?').get(strand.id) as { archived: number; message_count: number }
    expect(row.archived).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(strand.id) as { c: number }).c).toBe(1)

    expect(((await api('GET', '/api/strands')).body.strands as Thread[]).length).toBe(0)
    expect(((await api('GET', '/api/strands?include_archived=1')).body.strands as Thread[]).map(s => s.id)).toEqual([strand.id])

    const undone = await api('PATCH', `/api/strands/${strand.id}`, { archived: false })
    expect((undone.body.strand as Thread).archived).toBe(false)
    expect(((await api('GET', '/api/strands')).body.strands as Thread[]).map(s => s.id)).toEqual([strand.id])
  })

  it('renames, pins and refuses an empty or malformed patch', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Old title')
    const renamed = await api('PATCH', `/api/strands/${strand.id}`, { title: 'New title', pinned: true })
    expect((renamed.body.strand as Thread).title).toBe('New title')
    expect((renamed.body.strand as Thread).pinned).toBe(true)

    expect((await api('PATCH', `/api/strands/${strand.id}`, {})).body.code).toBe('empty_patch')
    expect((await api('PATCH', `/api/strands/${strand.id}`, { archived: 'yes' })).body.code).toBe('invalid_archived')
    expect((await api('PATCH', `/api/strands/${strand.id}`, { pinned: 1 })).body.code).toBe('invalid_pinned')
    expect((await api('PATCH', `/api/strands/${strand.id}`, { title: 5 })).body.code).toBe('invalid_title')
    expect((await api('PATCH', `/api/strands/${strand.id}`, { archived: true }, otherToken)).status).toBe(404)
    expect((await api('PATCH', '/api/strands/does-not-exist', { archived: true })).status).toBe(404)
  })
})

describe('delete preview and hard delete (SPEC 7.5b)', () => {
  function seedStrand(title = 'Smoke test 3'): Thread {
    const strand = sessionManager.createThread('1', 'main', title)
    const other = sessionManager.createThread('1', 'main', 'Neighbour')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'user', 'hello', 'main')").run(strand.id)
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, 1, 'assistant', 'hi', 'main')").run(strand.id)
    db.prepare("INSERT INTO captures (id, user_id, text, strand_id, status) VALUES ('cap-1', '1', 'note', ?, 'filed')").run(strand.id)
    db.prepare("INSERT INTO router_decisions (id, capture_id, action, confidence, state) VALUES ('dec-1', 'cap-1', 'append', 0.9, 'applied')").run()
    db.prepare("INSERT INTO strand_links (id, from_strand, to_strand) VALUES ('link-1', ?, ?)").run(strand.id, other.id)
    db.prepare("INSERT INTO resurface_snoozes (user_id, strand_id, snoozed_until) VALUES ('1', ?, '2099-01-01')").run(strand.id)
    db.prepare("INSERT INTO tool_calls (session_id, tool_name, input) VALUES (?, 'shell', 'ls')").run(strand.id)
    db.prepare("INSERT INTO memories (user_id, session_id, content, source) VALUES (1, ?, 'the roof costs 25k', 'fact')").run(strand.id)
    insertSessionSummary(db, strand.id, { goal: 'Roof', decisions: [], open: [], artifacts: [], next: [] }, null, 'test')
    return strand
  }

  it('previews what would disappear, including the facts', async () => {
    const strand = seedStrand()
    await api('PUT', `/api/strands/${strand.id}/tags`, { tags: ['roof'] })
    await api('PUT', '/api/now', { strandIds: [strand.id] })

    const preview = await api('GET', `/api/strands/${strand.id}/delete-preview`)
    expect(preview.status).toBe(200)
    expect(preview.body.title).toBe('Smoke test 3')
    expect(preview.body.messages).toBe(2)
    expect(preview.body.captures).toBe(1)
    expect(preview.body.decisions).toBe(1)
    expect(preview.body.attachments).toBe(0)
    expect(preview.body.tags).toBe(1)
    expect(preview.body.links).toBe(1)
    expect(preview.body.nowSlot).toBe(true)
    expect(preview.body.snoozes).toBe(1)
    expect(preview.body.summaries).toBe(1)
    expect(preview.body.toolCalls).toBe(1)
    expect(preview.body.facts).toEqual([{ id: expect.any(Number), text: 'the roof costs 25k' }])

    expect((await api('GET', `/api/strands/${strand.id}/delete-preview`, undefined, otherToken)).status).toBe(404)
    expect((await api('GET', '/api/strands/nope/delete-preview')).status).toBe(404)
  })

  it('requires confirm=1, answers 403 for a foreign strand and 404 for an unknown one', async () => {
    const strand = seedStrand()
    const missing = await api('DELETE', `/api/strands/${strand.id}`)
    expect(missing.status).toBe(400)
    expect(missing.body.code).toBe('confirm_required')
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(strand.id) as { c: number }).c).toBe(1)

    const foreign = sessionManager.createThread('2', 'main', 'Not mine')
    const refused = await api('DELETE', `/api/strands/${foreign.id}?confirm=1`)
    expect(refused.status).toBe(403)
    expect(refused.body.code).toBe('forbidden')
    expect((await api('DELETE', '/api/strands/unknown-id?confirm=1')).status).toBe(404)
  })

  it('cascades over every table, evicts the transcript and keeps facts by default', async () => {
    const strand = seedStrand()
    await api('PUT', `/api/strands/${strand.id}/tags`, { tags: ['roof'] })
    await api('PUT', '/api/now', { strandIds: [strand.id] })
    events = []

    const res = await api('DELETE', `/api/strands/${strand.id}?confirm=1`)
    expect(res.status).toBe(200)
    expect(res.body.deleted).toMatchObject({
      messages: 2, captures: 1, decisions: 1, attachments: 0,
      tags: 1, links: 1, nowSlot: true, snoozes: 1, summaries: 1, toolCalls: 1, facts: 0,
    })

    const count = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { c: number }).c
    expect(count('SELECT COUNT(*) AS c FROM sessions WHERE id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM captures WHERE strand_id = ?', strand.id)).toBe(0)
    expect(count("SELECT COUNT(*) AS c FROM router_decisions WHERE capture_id = 'cap-1'")).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM strand_tags WHERE strand_id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM strand_links WHERE from_strand = ? OR to_strand = ?', strand.id, strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM now_set WHERE strand_id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM resurface_snoozes WHERE strand_id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM session_summaries WHERE session_id = ?', strand.id)).toBe(0)
    expect(count('SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ?', strand.id)).toBe(0)
    // Knowledge is not deleted silently (SPEC 2.2 / 7.5b).
    expect(count('SELECT COUNT(*) AS c FROM memories WHERE session_id = ?', strand.id)).toBe(1)
    // The tag row and the neighbour strand survive.
    expect(count("SELECT COUNT(*) AS c FROM tags WHERE name = 'roof'")).toBe(1)
    expect(count('SELECT COUNT(*) AS c FROM sessions')).toBe(1)

    expect(evicted).toEqual([{ userId: '1', agentId: 'main', sessionId: strand.id }])
    expect(events.map(e => e.type)).toEqual(['now_set_changed'])
    expect(events[0].strandIds).toEqual([])
    expect(((await api('GET', '/api/strands?include_archived=1')).body.strands as Thread[]).map(s => s.id)).not.toContain(strand.id)
  })

  it('deletes the facts only when the client asks for it', async () => {
    const strand = seedStrand()
    const res = await api('DELETE', `/api/strands/${strand.id}?confirm=1&delete_facts=1`)
    expect(res.status).toBe(200)
    expect((res.body.deleted as { facts: number }).facts).toBe(1)
    expect((db.prepare('SELECT COUNT(*) AS c FROM memories WHERE session_id = ?').get(strand.id) as { c: number }).c).toBe(0)
  })

  it('removes attachment files of this strand but keeps files referenced elsewhere', async () => {
    const strand = sessionManager.createThread('1', 'main', 'With files')
    const keeper = sessionManager.createThread('1', 'main', 'Keeps the shared file')
    const uploadsDir = path.join(tempDataDir, 'uploads', '2026', '09', '14')
    fs.mkdirSync(uploadsDir, { recursive: true })
    fs.writeFileSync(path.join(uploadsDir, 'only.txt'), 'x')
    fs.writeFileSync(path.join(uploadsDir, 'shared.txt'), 'y')
    const file = (name: string) => ({
      kind: 'file', originalName: name, storedName: name,
      relativePath: `2026/09/14/${name}`, urlPath: `/api/uploads/2026/09/14/${name}`,
      mimeType: 'text/plain', size: 1,
    })
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'user', 'a', ?, 'main')")
      .run(strand.id, JSON.stringify({ files: [file('only.txt'), file('shared.txt')] }))
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, 1, 'user', 'b', ?, 'main')")
      .run(keeper.id, JSON.stringify({ files: [file('shared.txt')] }))

    expect((await api('GET', `/api/strands/${strand.id}/delete-preview`)).body.attachments).toBe(1)
    const res = await api('DELETE', `/api/strands/${strand.id}?confirm=1`)
    expect((res.body.deleted as { attachments: number }).attachments).toBe(1)
    expect(fs.existsSync(path.join(uploadsDir, 'only.txt'))).toBe(false)
    expect(fs.existsSync(path.join(uploadsDir, 'shared.txt'))).toBe(true)
  })

  it('refuses delete and archive with 409 strand_busy while a turn or a delegated task runs', async () => {
    const strand = seedStrand()
    busySessions = [strand.id]

    const busyDelete = await api('DELETE', `/api/strands/${strand.id}?confirm=1`)
    expect(busyDelete.status).toBe(409)
    expect(busyDelete.body.code).toBe('strand_busy')
    const busyArchive = await api('PATCH', `/api/strands/${strand.id}`, { archived: true })
    expect(busyArchive.status).toBe(409)
    expect(busyArchive.body.code).toBe('strand_busy')
    // Un-archiving (the undo of the swipe) is never blocked.
    expect((await api('PATCH', `/api/strands/${strand.id}`, { archived: false })).status).toBe(200)
    expect((db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(strand.id) as { c: number }).c).toBe(1)
    expect(evicted).toEqual([])

    busySessions = []
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id) VALUES ('task-1', 'n', 'p', 'running', 'agent', ?)").run(strand.id)
    const taskBusy = await api('DELETE', `/api/strands/${strand.id}?confirm=1`)
    expect(taskBusy.status).toBe(409)
    expect(taskBusy.body.code).toBe('strand_busy')

    db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'task-1'").run()
    expect((await api('DELETE', `/api/strands/${strand.id}?confirm=1`)).status).toBe(200)
  })
})

/**
 * GET /api/strands/:id/tasks — the catch-up read for the strand activity
 * view. A client that opens the page mid-wave (or reconnects after a missed
 * `task_started` frame) must see the whole tree, sub-tasks included.
 */
describe('strand task tree', () => {
  function insertTask(over: {
    id: string
    name: string
    status?: string
    sessionId?: string | null
    parentTaskId?: string | null
    triggerType?: string
    resultStatus?: string | null
    errorMessage?: string | null
  }): void {
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, result_status, error_message, agent_id, created_at)
       VALUES (?, ?, 'p', ?, ?, ?, ?, ?, ?, 'main', ?)`,
    ).run(
      over.id,
      over.name,
      over.status ?? 'running',
      over.triggerType ?? 'agent',
      over.parentTaskId ?? null,
      over.sessionId ?? null,
      over.resultStatus ?? null,
      over.errorMessage ?? null,
      `2025-09-15 10:00:${String(over.id.length).padStart(2, '0')}`,
    )
  }

  function taskSession(id: string, parent: string): void {
    db.prepare(
      `INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'task', ?, '1')`,
    ).run(id, parent)
  }

  it('returns an empty tree for a strand without tasks', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Quiet')
    const res = await api('GET', `/api/strands/${strand.id}/tasks`)
    expect(res.status).toBe(200)
    expect(res.body.tasks).toEqual([])
    expect(res.body.activeCount).toBe(0)
    expect(res.body.include).toBe('active')
    expect(typeof res.body.generatedAt).toBe('string')
  })

  it('returns the delegated task and its sub-tasks, recursively', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Wave')
    taskSession('sess-wave', strand.id)
    insertTask({ id: 'wave', name: 'Wave', sessionId: 'sess-wave' })
    // Sub-task: session without a parent (background task tools pass null),
    // linked only via trigger_source_id.
    insertTask({ id: 'sub', name: 'Sub', parentTaskId: 'wave' })
    insertTask({ id: 'subsub', name: 'SubSub', parentTaskId: 'sub' })

    const res = await api('GET', `/api/strands/${strand.id}/tasks`)
    expect(res.status).toBe(200)
    const tasks = res.body.tasks as Array<Record<string, unknown>>
    expect(tasks.map(t => t.id)).toEqual(['wave', 'sub', 'subsub'])
    expect(tasks.map(t => t.depth)).toEqual([0, 1, 2])
    expect(tasks.map(t => t.parentTaskId)).toEqual([null, 'wave', 'sub'])
    expect(tasks[0]!.hasChildren).toBe(true)
    expect(tasks[2]!.hasChildren).toBe(false)
    expect(res.body.activeCount).toBe(3)
  })

  it('keeps failed tasks visible with their reason and hides finished ones unless include=all', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Mixed')
    taskSession('sess-done', strand.id)
    taskSession('sess-fail', strand.id)
    insertTask({ id: 'done', name: 'Done', status: 'completed', resultStatus: 'completed', sessionId: 'sess-done' })
    insertTask({ id: 'fail', name: 'Fail', status: 'failed', resultStatus: 'failed', errorMessage: 'exit 1', sessionId: 'sess-fail' })

    const active = await api('GET', `/api/strands/${strand.id}/tasks?include=active`)
    const activeTasks = active.body.tasks as Array<Record<string, unknown>>
    expect(activeTasks.map(t => t.id)).toEqual(['fail'])
    expect(activeTasks[0]!.errorMessage).toBe('exit 1')

    const all = await api('GET', `/api/strands/${strand.id}/tasks?include=all`)
    expect((all.body.tasks as Array<Record<string, unknown>>).map(t => t.id).sort()).toEqual(['done', 'fail'])
  })

  it('rejects an unknown include value and a foreign strand', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Guarded')
    const bad = await api('GET', `/api/strands/${strand.id}/tasks?include=everything`)
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('invalid_include')

    const foreign = await api('GET', `/api/strands/${strand.id}/tasks`, undefined, otherToken)
    expect(foreign.status).toBe(404)
    expect((await api('GET', '/api/strands/does-not-exist/tasks')).status).toBe(404)
  })

  it('never leaks the tasks of another strand', async () => {
    const mine = sessionManager.createThread('1', 'main', 'Mine')
    const other = sessionManager.createThread('1', 'main', 'Other')
    taskSession('sess-other', other.id)
    insertTask({ id: 'other-task', name: 'Other', sessionId: 'sess-other' })

    expect((await api('GET', `/api/strands/${mine.id}/tasks`)).body.tasks).toEqual([])
    expect(((await api('GET', `/api/strands/${other.id}/tasks`)).body.tasks as unknown[]).length).toBe(1)
  })
})

describe('project suggestions (running assignment, Stufe 2)', () => {
  function project(id: string, name: string, archived = false): void {
    db.prepare(
      `INSERT INTO projects (id, user_id, name, color, archived, created_at, updated_at)
       VALUES (?, '1', ?, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(id, name, archived ? 1 : 0)
  }

  it('delivers the open suggestion with the strand and drops it on accept', async () => {
    project('prj_haus', 'Haus & Handwerk')
    const strand = sessionManager.createThread('1', 'main', 'Dachrinne')
    expect(putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_haus', confidence: 0.63, reason: 'Dachrinne am Haus',
    })).toBe(true)

    const listed = (await api('GET', '/api/strands')).body.strands as Thread[]
    expect(listed[0]!.projectSuggestion).toMatchObject({
      projectId: 'prj_haus',
      projectName: 'Haus & Handwerk',
      confidence: 0.63,
      reason: 'Dachrinne am Haus',
    })

    const accepted = await api('POST', `/api/strands/${strand.id}/project-suggestion/accept`)
    expect(accepted.status).toBe(200)
    expect((accepted.body.strand as Thread).projectId).toBe('prj_haus')
    expect((accepted.body.strand as Thread).projectSuggestion).toBeNull()

    const again = await api('POST', `/api/strands/${strand.id}/project-suggestion/accept`)
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('project_already_set')
  })

  it('buries a dismissed suggestion for good', async () => {
    project('prj_haus', 'Haus & Handwerk')
    const strand = sessionManager.createThread('1', 'main', 'Dachrinne')
    putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_haus', confidence: 0.63, reason: 'Dachrinne am Haus',
    })

    const dismissed = await api('POST', `/api/strands/${strand.id}/project-suggestion/dismiss`)
    expect(dismissed.status).toBe(200)
    expect((dismissed.body.strand as Thread).projectSuggestion).toBeNull()
    expect((dismissed.body.strand as Thread).projectId).toBeNull()

    expect(putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_haus', confidence: 0.74, reason: 'immer noch',
    })).toBe(false)
    const listed = (await api('GET', '/api/strands')).body.strands as Thread[]
    expect(listed[0]!.projectSuggestion).toBeNull()

    const second = await api('POST', `/api/strands/${strand.id}/project-suggestion/dismiss`)
    expect(second.status).toBe(404)
    expect(second.body.code).toBe('suggestion_not_found')
  })

  it('answers 404 without a suggestion, for a foreign strand and for an unknown id', async () => {
    project('prj_haus', 'Haus & Handwerk')
    const strand = sessionManager.createThread('1', 'main', 'Ohne Vorschlag')
    expect((await api('POST', `/api/strands/${strand.id}/project-suggestion/accept`)).status).toBe(404)
    expect((await api('POST', `/api/strands/${strand.id}/project-suggestion/dismiss`)).status).toBe(404)

    putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_haus', confidence: 0.6, reason: 'x',
    })
    expect((await api('POST', `/api/strands/${strand.id}/project-suggestion/accept`, undefined, otherToken)).status).toBe(404)
    expect((await api('POST', '/api/strands/nope/project-suggestion/accept')).status).toBe(404)
  })

  it('never shows a suggestion on a strand that already has a project', async () => {
    project('prj_haus', 'Haus & Handwerk')
    project('prj_auto', 'Auto')
    const strand = sessionManager.createThread('1', 'main', 'Schon abgelegt')
    putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_haus', confidence: 0.6, reason: 'x',
    })
    sessionManager.updateThread('1', strand.id, { projectId: 'prj_auto' })

    const listed = (await api('GET', '/api/strands')).body.strands as Thread[]
    expect(listed[0]!.projectId).toBe('prj_auto')
    expect(listed[0]!.projectSuggestion).toBeNull()
  })

  it('accepts an archived project the classifier proposed', async () => {
    project('prj_old', 'Olkus', true)
    const strand = sessionManager.createThread('1', 'main', 'Altes Projekt')
    putStrandProjectSuggestion(db, {
      strandId: strand.id, userId: '1', projectId: 'prj_old', confidence: 0.6, reason: 'x',
    })
    const accepted = await api('POST', `/api/strands/${strand.id}/project-suggestion/accept`)
    expect(accepted.status).toBe(200)
    expect((accepted.body.strand as Thread).projectId).toBe('prj_old')
  })
})
