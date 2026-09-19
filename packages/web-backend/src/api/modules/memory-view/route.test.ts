/**
 * /api/memory/tree, /api/memory/facts?node=, /api/memory/graph and
 * /api/memory/fact/:id (SPEC 6.4) against a real temp wiki, an in-memory
 * database and both memory routers mounted in production order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { EMBEDDING_ASSIGN_MIN_SCORE, initDatabase, pagesSignature, wikiPageFingerprints } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createMemoryViewRouter } from './route.js'
import { createMemoryRouter } from '../memory/route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let adminToken: string
let userToken: string
let tempDataDir: string
let previousDataDir: string | undefined
let portFactId: number
let conflictingFactId: number
let semanticFactId: number

const EMBED_MODEL = 'test-embed'
const EMBED_DIM = 4

function vectorBlob(values: number[]): Buffer {
  const vector = Float32Array.from(values)
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

function writePage(wikiDir: string, relPath: string, content: string): void {
  const full = path.join(wikiDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function insertFact(
  content: string,
  overrides: Partial<{ userId: number | null; sessionId: string | null; supersessionKey: string | null; timestamp: string }> = {},
): number {
  const result = db.prepare(
    `INSERT INTO memories (user_id, session_id, content, source, agent_id, provenance, supersession_key, status, timestamp)
     VALUES (?, ?, ?, 'extracted_fact', 'main', 'agent', ?, 'active', ?)`,
  ).run(
    overrides.userId === undefined ? 1 : overrides.userId,
    overrides.sessionId ?? null,
    content,
    overrides.supersessionKey ?? null,
    overrides.timestamp ?? '2026-09-01 10:00:00',
  )
  return Number(result.lastInsertRowid)
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-view-routes-'))
  process.env.DATA_DIR = tempDataDir

  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(tempDataDir, 'config', 'settings.json'),
    JSON.stringify({ memoryEmbeddings: { enabled: true, baseUrl: 'http://embed.test/v1', model: EMBED_MODEL } }),
    'utf-8',
  )

  const wikiDir = path.join(tempDataDir, 'memory', 'wiki')
  fs.mkdirSync(wikiDir, { recursive: true })
  writePage(wikiDir, 'index.md', [
    '# Wiki Index',
    '',
    '- [looplab](looplab.md)',
    '- [werkstattlog](werkstattlog.md)',
    '- [haus-sanierung](haus-sanierung.md)',
  ].join('\n'))
  writePage(wikiDir, 'looplab.md', '---\naliases: [Loop Lab]\n---\n# Looplab\n')
  writePage(wikiDir, 'werkstattlog.md', '# Werkstattlog\n')
  writePage(wikiDir, 'haus-sanierung.md', '# Haus Sanierung\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (2, ?, ?, ?)').run('reader', 'x', 'user')
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, agent_id, title, session_user) VALUES ('strand-a', 1, 'web', 'interactive', 'main', 'Bike routing', '1')",
  ).run()

  portFactId = insertFact('Looplab runs on port 3800', { sessionId: 'strand-a', supersessionKey: 'looplab.port' })
  conflictingFactId = insertFact('Looplab runs on port 3900', { sessionId: 'strand-a', supersessionKey: 'looplab.port' })
  insertFact('Werkstattlog tracks the service intervals', { sessionId: 'strand-a' })
  insertFact('This sentence matches no page at all')
  insertFact('Looplab is only visible to the second user', { userId: 2 })

  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, agent_id, title, session_user) VALUES ('strand-embed', 1, 'web', 'interactive', 'main', 'Route trimming', '1')",
  ).run()
  semanticFactId = insertFact('The generated tour was trimmed by two dead end spurs', { sessionId: 'strand-embed' })

  const signature = pagesSignature(wikiPageFingerprints(path.join(tempDataDir, 'memory')), EMBED_MODEL)
  db.prepare(
    `INSERT INTO wiki_page_embeddings (rel_path, chunk_index, node_id, fingerprint, model, dim, embedding, updated_at)
     VALUES ('looplab.md', 0, 'wiki:looplab', 'fixed', ?, ?, ?, datetime('now'))`,
  ).run(EMBED_MODEL, EMBED_DIM, vectorBlob([1, 0, 0, 0]))
  db.prepare(
    `INSERT INTO memory_page_matches (fact_id, pages_signature, node_id, score, runner_up_score, updated_at)
     VALUES (?, ?, 'wiki:looplab', 0.71, 0.2, datetime('now'))`,
  ).run(semanticFactId, signature)
  db.prepare(
    `INSERT INTO memory_strand_matches (strand_id, pages_signature, fact_fingerprint, node_id, score, fact_count, updated_at)
     VALUES ('strand-embed', ?, 'fixed', 'wiki:looplab', 0.83, 1, datetime('now'))`,
  ).run(signature)

  const app = express()
  app.use(express.json())
  app.use('/api/memory', createMemoryViewRouter({ db, disableBackgroundRefresh: true }))
  app.use('/api/memory', createMemoryRouter({ db }))

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  adminToken = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
  userToken = generateAccessToken({ userId: 2, username: 'reader', role: 'user' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close(e => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

async function api(
  url: string,
  bearer: string | null = adminToken,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

describe('GET /api/memory/tree', () => {
  it('returns the derived tree with totals and limits', async () => {
    const res = await api('/api/memory/tree')
    expect(res.status).toBe(200)

    const nodes = res.body.nodes as Array<Record<string, unknown>>
    const totals = res.body.totals as Record<string, number>
    const hub = nodes.find(node => node.id === 'wiki:index')!

    expect(nodes.map(node => node.id)).toContain('bucket:unassigned')
    expect((hub.children as Array<Record<string, unknown>>).map(child => child.id).sort()).toEqual([
      'wiki:haus-sanierung',
      'wiki:looplab',
      'wiki:werkstattlog',
    ])
    expect(totals.pages).toBe(4)
    expect(totals.facts).toBe(6)
    expect(totals.unassignedFacts).toBe(1)
    expect((res.body.limits as Record<string, number>).hubMinOutgoingLinks).toBe(3)
    expect(Array.isArray(res.body.notes)).toBe(true)
  })

  it('filters by query and keeps the matching branch only', async () => {
    const res = await api('/api/memory/tree?q=loop%20lab')
    const nodes = res.body.nodes as Array<Record<string, unknown>>

    expect(nodes.map(node => node.id)).toEqual(['wiki:index'])
    expect((nodes[0].children as Array<Record<string, unknown>>).map(child => child.id)).toEqual(['wiki:looplab'])
  })

  it('scopes facts to the calling user', async () => {
    const res = await api('/api/memory/tree', userToken)
    expect(res.status).toBe(200)
    expect((res.body.totals as Record<string, number>).facts).toBe(1)
  })

  it('requires a token', async () => {
    const res = await api('/api/memory/tree', null)
    expect(res.status).toBe(401)
  })

  it('rejects an unknown persona', async () => {
    const res = await api('/api/memory/tree?agent_id=ghost')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('unknown_agent')
  })
})

describe('GET /api/memory/facts', () => {
  it('lists the facts of a node with conflict markers', async () => {
    const res = await api('/api/memory/facts?node=wiki:looplab')
    expect(res.status).toBe(200)

    const facts = res.body.facts as Array<Record<string, unknown>>
    expect((res.body.node as Record<string, unknown>).title).toBe('Looplab')
    // Admin scope: both port facts, the fact stored for the other user and
    // the semantically assigned one.
    expect(res.body.total).toBe(4)

    const conflicting = facts.filter(fact => fact.conflict === true)
    expect(conflicting.map(fact => fact.id).sort()).toEqual([portFactId, conflictingFactId].sort())
    expect((conflicting[0].conflictWith as Array<Record<string, unknown>>)[0].reason).toBe('same_subject_key')

    const portFact = facts.find(fact => fact.id === portFactId)!
    expect(portFact.provenance).toBe('agent')
    expect(portFact.strandTitle).toBe('Bike routing')
    expect(portFact.supersessionKey).toBe('looplab.port')
    expect(portFact.status).toBe('active')
  })

  it('paginates with a cursor', async () => {
    const first = await api('/api/memory/facts?node=wiki:looplab&limit=3')
    expect(first.body.total).toBe(4)
    expect((first.body.facts as unknown[]).length).toBe(3)
    expect(first.body.nextCursor).toBeTruthy()

    const second = await api(`/api/memory/facts?node=wiki:looplab&limit=3&cursor=${encodeURIComponent(String(first.body.nextCursor))}`)
    expect(second.status).toBe(200)
    expect((second.body.facts as unknown[]).length).toBe(1)
    expect((second.body.facts as Array<Record<string, unknown>>)[0].id)
      .not.toBe((first.body.facts as Array<Record<string, unknown>>)[0].id)
    expect(second.body.nextCursor).toBeNull()
  })

  it('answers 404 for an unknown node and 400 for a broken cursor', async () => {
    const unknown = await api('/api/memory/facts?node=wiki:nope')
    expect(unknown.status).toBe(404)
    expect(unknown.body.code).toBe('node_not_found')

    const badCursor = await api('/api/memory/facts?node=wiki:looplab&cursor=zzzz')
    expect(badCursor.status).toBe(400)
    expect(badCursor.body.code).toBe('invalid_cursor')
  })

  it('falls through to the admin fact list when no node is given', async () => {
    const res = await api('/api/memory/facts?limit=2')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.facts)).toBe(true)
    expect(res.body.total).toBeGreaterThan(0)
    expect(res.body.node).toBeUndefined()

    const forbidden = await api('/api/memory/facts?limit=2', userToken)
    expect(forbidden.status).toBe(403)
  })
})

describe('GET /api/memory/graph', () => {
  it('returns a capped node set with edges', async () => {
    const res = await api('/api/memory/graph?root=wiki:index&depth=2')
    expect(res.status).toBe(200)

    const nodes = res.body.nodes as Array<Record<string, unknown>>
    const edges = res.body.edges as Array<Record<string, unknown>>
    expect(nodes[0].id).toBe('wiki:index')
    expect(nodes.map(node => node.id)).toContain('strand:strand-a')
    expect(edges.some(edge => edge.type === 'wiki_link')).toBe(true)
    expect(edges.some(edge => edge.type === 'fact_origin')).toBe(true)
    expect(res.body.truncated).toBe(false)
  })

  it('never returns more nodes than the limit', async () => {
    const res = await api('/api/memory/graph?depth=2&limit=2')
    expect((res.body.nodes as unknown[]).length).toBeLessThanOrEqual(2)
    expect(res.body.truncated).toBe(true)
    expect(res.body.nodeLimit).toBe(2)
  })

  it('answers 404 for an unknown root', async () => {
    const res = await api('/api/memory/graph?root=wiki:nope')
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('node_not_found')
  })
})

describe('GET /api/memory/fact/:id', () => {
  it('returns the fact with origin, node and conflicts', async () => {
    const res = await api(`/api/memory/fact/${portFactId}`)
    expect(res.status).toBe(200)

    const fact = res.body.fact as Record<string, unknown>
    const origin = res.body.origin as Record<string, unknown>
    expect(fact.id).toBe(portFactId)
    expect((res.body.node as Record<string, unknown>).id).toBe('wiki:looplab')
    expect(origin.strandId).toBe('strand-a')
    expect(origin.strandTitle).toBe('Bike routing')
    expect(Array.isArray(res.body.history)).toBe(true)
    expect((res.body.conflicts as Array<Record<string, unknown>>)[0].id).toBe(conflictingFactId)
  })

  it('answers 404 for a fact outside the caller scope', async () => {
    const res = await api(`/api/memory/fact/${portFactId}`, userToken)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('fact_not_found')
  })

  it('answers 400 for a non numeric id', async () => {
    const res = await api('/api/memory/fact/abc')
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_fact_id')
  })
})

describe('semantic assignment over HTTP', () => {
  it('reports the assignment breakdown and the floor in the tree, purely additive', async () => {
    const res = await api('/api/memory/tree')
    const totals = res.body.totals as Record<string, number>
    const limits = res.body.limits as Record<string, number>

    expect(totals.byEmbedding).toBe(1)
    expect(totals.byTerm + totals.byStrandMajority + totals.byEmbedding).toBe(totals.assignedFacts)
    expect(totals.assignedFacts + totals.unassignedFacts).toBe(totals.facts)
    expect(limits.embeddingMinScore).toBe(EMBEDDING_ASSIGN_MIN_SCORE)
    expect(limits.embeddedPages).toBe(1)
    // Fields of the previous release are still there.
    expect(Object.keys(totals)).toEqual(expect.arrayContaining([
      'nodes', 'pages', 'folders', 'facts', 'assignedFacts', 'unassignedFacts', 'conflicts',
    ]))
    expect(limits.hubMinOutgoingLinks).toBe(3)
  })

  it('exposes the cosine scores on the fact list', async () => {
    const res = await api('/api/memory/facts?node=wiki:looplab')
    const facts = res.body.facts as Array<Record<string, unknown>>
    const semantic = facts.find(fact => fact.id === semanticFactId)!

    expect(semantic.matchedBy).toBe('embedding')
    expect(semantic.embeddingScore).toBeCloseTo(0.71, 4)
    expect(semantic.embeddingStrandScore).toBeCloseTo(0.83, 4)
    expect(semantic.matchedTerm).toBeNull()

    const termMatched = facts.find(fact => fact.id === portFactId)!
    expect(termMatched.matchedBy).toBe('term')
    expect(termMatched.embeddingScore).toBeNull()
  })

  it('exposes the scores on the fact detail endpoint', async () => {
    const res = await api(`/api/memory/fact/${semanticFactId}`)
    expect(res.status).toBe(200)
    const fact = res.body.fact as Record<string, unknown>
    expect(fact.matchedBy).toBe('embedding')
    expect(fact.embeddingScore).toBeCloseTo(0.71, 4)
    expect((res.body.node as Record<string, unknown>).id).toBe('wiki:looplab')
  })
})
