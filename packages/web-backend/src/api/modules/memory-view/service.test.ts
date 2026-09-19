/**
 * Service level behaviour of the page embedding refresh: it runs in the
 * background, it runs only when the caches are stale, and the memory view
 * picks the result up on the next request. The embedding endpoint is stubbed,
 * no network call leaves the test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, memoryPageIndexState } from '@axiom/core'
import type { Database } from '@axiom/core'
import { createMemoryViewService } from './service.js'

let db: Database
let dataDir: string
let previousDataDir: string | undefined
let embedCalls: number

const MODEL = 'test-embed'

function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  return [lower.includes('looplab') ? 1 : 0, lower.includes('haus') ? 1 : 0, 0, 0]
}

function writePage(relPath: string, content: string): void {
  const full = path.join(dataDir, 'memory', 'wiki', relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function insertFact(content: string, sessionId: string, vector: number[]): number {
  const embedding = Float32Array.from(vector)
  const result = db.prepare(
    `INSERT INTO memories (user_id, session_id, content, source, agent_id, provenance, status, timestamp, embedding)
     VALUES (1, ?, ?, 'extracted_fact', 'main', 'agent', 'active', '2026-09-01 10:00:00', ?)`,
  ).run(sessionId, content, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength))
  return Number(result.lastInsertRowid)
}

async function waitForFreshIndex(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!memoryPageIndexState(db, { memoryDir: path.join(dataDir, 'memory') }).stale) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('page index stayed stale')
}

beforeEach(() => {
  embedCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const payload = JSON.parse(init?.body ?? '{}') as { input: string[] }
    embedCalls += 1
    return {
      ok: true,
      json: async () => ({ data: payload.input.map((text, index) => ({ index, embedding: vectorFor(text) })) }),
    } as unknown as Response
  }))

  previousDataDir = process.env.DATA_DIR
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-view-service-'))
  process.env.DATA_DIR = dataDir
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'config', 'settings.json'),
    JSON.stringify({ memoryEmbeddings: { enabled: true, baseUrl: 'http://embed.test/v1', model: MODEL } }),
    'utf-8',
  )
  writePage('looplab.md', '# Looplab\n\nA route generator.\n')
  writePage('haus-sanierung.md', '# Haus Sanierung\n\nRenovation notes.\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, agent_id, title, session_user) VALUES ('strand-a', 1, 'web', 'interactive', 'main', 'Routing', '1')",
  ).run()
})

afterEach(() => {
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('createMemoryViewService page index refresh', () => {
  it('serves the first request immediately and assigns after the background refresh', async () => {
    const factId = insertFact('The tour skips dead end spurs', 'strand-a', [1, 0, 0, 0])
    const service = createMemoryViewService({ db })

    const before = service.tree(1, true, { onlyWithFacts: false })
    expect(before.totals.byEmbedding).toBe(0)
    expect(before.totals.unassignedFacts).toBe(1)

    await waitForFreshIndex()

    const after = service.tree(1, true, { onlyWithFacts: false })
    expect(after.totals.byEmbedding).toBe(1)
    expect(after.totals.unassignedFacts).toBe(0)
    const facts = service.facts(1, true, { node: 'wiki:looplab', limit: 10, includeSuperseded: false })
    expect(facts.facts.map(fact => fact.id)).toContain(factId)
    expect(facts.facts[0]!.matchedBy).toBe('embedding')
    expect(facts.facts[0]!.embeddingScore).toBeCloseTo(1, 4)
  })

  it('does not touch the endpoint again while the caches are fresh', async () => {
    insertFact('The tour skips dead end spurs', 'strand-a', [1, 0, 0, 0])
    const service = createMemoryViewService({ db, pageIndexCheckIntervalMs: 0 })
    service.tree(1, true, { onlyWithFacts: false })
    await waitForFreshIndex()

    const callsAfterWarmup = embedCalls
    for (let i = 0; i < 5; i++) service.tree(1, true, { onlyWithFacts: false })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(embedCalls).toBe(callsAfterWarmup)
  })

  it('never refreshes when the background refresh is disabled', async () => {
    insertFact('The tour skips dead end spurs', 'strand-a', [1, 0, 0, 0])
    const service = createMemoryViewService({ db, disableBackgroundRefresh: true })
    service.tree(1, true, { onlyWithFacts: false })
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(embedCalls).toBe(0)
    expect(memoryPageIndexState(db, { memoryDir: path.join(dataDir, 'memory') }).stale).toBe(true)
  })

  it('re-embeds a changed page and re-files the affected facts', async () => {
    insertFact('Renovation of the haus continues', 'strand-a', [0, 1, 0, 0])
    const service = createMemoryViewService({ db, pageIndexCheckIntervalMs: 0 })
    service.tree(1, true, { onlyWithFacts: false })
    await waitForFreshIndex()
    expect(service.tree(1, true, { onlyWithFacts: false }).totals.byEmbedding).toBe(1)

    const callsBefore = embedCalls
    writePage('haus-sanierung.md', '# Haus Sanierung\n\nRenovation notes, extended.\n')
    service.tree(1, true, { onlyWithFacts: false })
    await waitForFreshIndex()

    expect(embedCalls).toBeGreaterThan(callsBefore)
    const after = service.tree(1, true, { onlyWithFacts: false })
    expect(after.totals.byEmbedding).toBe(1)
  })
})
