/**
 * Page chunk embeddings, the fact and strand match caches and their
 * invalidation. The embedding endpoint is stubbed: vectors are deterministic
 * so cosine scores are predictable, and every call is counted so the tests can
 * prove that unchanged pages are never embedded twice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import type { MemoryEmbeddingSettings } from './memory-embeddings.js'
import { embeddingToBuffer } from './memory-embeddings.js'
import {
  PAGE_CHUNK_CHARS,
  PAGE_CHUNK_OVERLAP,
  PAGE_MAX_CHUNKS,
  loadFactPageMatches,
  loadStrandPageMatches,
  loadWikiPageVectors,
  memoryPageIndexState,
  pagesSignature,
  refreshFactPageMatches,
  refreshMemoryPageIndex,
  refreshWikiPageEmbeddings,
  wikiPageChunkTexts,
  wikiPageFingerprints,
} from './memory-page-embeddings.js'
import { scanWikiPages } from './wiki-scan.js'

let db: Database
let memoryDir: string
let wikiDir: string
let embedCalls: string[][]

const settings: MemoryEmbeddingSettings = {
  enabled: true,
  baseUrl: 'http://embeddings.test/v1',
  model: 'test-embed',
  timeoutMs: 1000,
  assignMinScore: 0.65,
}

/**
 * Vector by keyword: a text about looplab points at axis 0, house texts at
 * axis 1, anything else at axis 2. That makes cosine scores exactly 1, 0 or
 * a known mix without depending on a real model.
 */
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase()
  const vector = [0, 0, 0, 0]
  if (lower.includes('looplab') || lower.includes('routing')) vector[0] += 1
  if (lower.includes('haus') || lower.includes('roof')) vector[1] += 1
  if (vector[0] === 0 && vector[1] === 0) vector[2] = 1
  return vector
}

function writePage(relPath: string, content: string): void {
  const full = path.join(wikiDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function insertSession(id: string): void {
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, agent_id, title, session_user) VALUES (?, 1, 'web', 'interactive', 'main', ?, '1')",
  ).run(id, id)
}

function insertFact(content: string, sessionId: string | null, vector: number[] | null = vectorFor(content)): number {
  const result = db.prepare(
    `INSERT INTO memories (user_id, session_id, content, source, agent_id, provenance, status, timestamp, embedding)
     VALUES (1, ?, ?, 'extracted_fact', 'main', 'agent', 'active', '2026-09-01 10:00:00', ?)`,
  ).run(sessionId, content, vector ? embeddingToBuffer(Float32Array.from(vector)) : null)
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  embedCalls = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
    const payload = JSON.parse(init?.body ?? '{}') as { input: string[] }
    embedCalls.push(payload.input)
    return {
      ok: true,
      json: async () => ({
        data: payload.input.map((text, index) => ({ index, embedding: vectorFor(text) })),
      }),
    } as unknown as Response
  }))

  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-page-embed-'))
  wikiDir = path.join(memoryDir, 'wiki')
  fs.mkdirSync(wikiDir, { recursive: true })
  writePage('looplab.md', '# Looplab\n\nRouting for gravel loops.\n')
  writePage('haus-sanierung.md', '# Haus Sanierung\n\nRoof and facade work.\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  insertSession('strand-loop')
  insertSession('strand-house')
})

afterEach(() => {
  db.close()
  fs.rmSync(memoryDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('wikiPageChunkTexts', () => {
  it('prefixes every chunk with title and aliases and overlaps the windows', () => {
    writePage('long.md', `---\naliases: [LP, loop lab]\n---\n# Long Page\n\n${'x'.repeat(PAGE_CHUNK_CHARS * 2)}\n`)
    const page = scanWikiPages(memoryDir).find(entry => entry.relPath === 'long.md')!
    const texts = wikiPageChunkTexts(page, fs.readFileSync(path.join(wikiDir, 'long.md'), 'utf-8'))

    expect(texts.length).toBeGreaterThan(1)
    for (const text of texts) {
      expect(text.startsWith('Long Page. long. LP. loop lab\n')).toBe(true)
      expect(text.length).toBeLessThanOrEqual(PAGE_CHUNK_CHARS + 64)
    }
    const bodyOf = (text: string): string => text.slice(text.indexOf('\n') + 1)
    expect(bodyOf(texts[0]!).length - bodyOf(texts[1]!).slice(0, PAGE_CHUNK_OVERLAP).length)
      .toBe(PAGE_CHUNK_CHARS - PAGE_CHUNK_OVERLAP)
  })

  it('never produces more than the chunk cap', () => {
    writePage('huge.md', `# Huge\n\n${'y'.repeat(PAGE_CHUNK_CHARS * (PAGE_MAX_CHUNKS + 5))}\n`)
    const page = scanWikiPages(memoryDir).find(entry => entry.relPath === 'huge.md')!
    const texts = wikiPageChunkTexts(page, fs.readFileSync(path.join(wikiDir, 'huge.md'), 'utf-8'))
    expect(texts).toHaveLength(PAGE_MAX_CHUNKS)
  })
})

describe('refreshWikiPageEmbeddings', () => {
  it('embeds every page once and skips unchanged pages on the next run', async () => {
    const first = await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    expect(first).toMatchObject({ enabled: true, embedded: 2, removed: 0, unchanged: 0, failed: 0 })
    expect(embedCalls.length).toBeGreaterThan(0)

    const callsAfterFirst = embedCalls.length
    const second = await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    expect(second).toMatchObject({ embedded: 0, unchanged: 2 })
    expect(embedCalls.length).toBe(callsAfterFirst)
  })

  it('re-embeds only the page whose fingerprint changed', async () => {
    await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    const callsAfterFirst = embedCalls.length

    writePage('looplab.md', '# Looplab\n\nRouting for gravel loops and trail hunts.\n')
    const result = await refreshWikiPageEmbeddings(db, { memoryDir, settings })

    expect(result).toMatchObject({ embedded: 1, unchanged: 1 })
    expect(embedCalls.length).toBeGreaterThan(callsAfterFirst)
    for (const call of embedCalls.slice(callsAfterFirst)) {
      for (const text of call) expect(text.toLowerCase()).toContain('looplab')
    }
  })

  it('re-embeds everything when the model changes', async () => {
    await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    const result = await refreshWikiPageEmbeddings(db, { memoryDir, settings: { ...settings, model: 'other-embed' } })
    expect(result).toMatchObject({ embedded: 2, unchanged: 0 })
    expect(loadWikiPageVectors(db, 'other-embed')).not.toBeNull()
  })

  it('drops rows of deleted pages', async () => {
    await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    fs.rmSync(path.join(wikiDir, 'haus-sanierung.md'))
    const result = await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    expect(result.removed).toBe(1)
    const vectors = loadWikiPageVectors(db, settings.model)!
    expect(new Set(vectors.nodeIds)).toEqual(new Set(['wiki:looplab']))
  })

  it('is a no-op when embeddings are disabled', async () => {
    const result = await refreshWikiPageEmbeddings(db, { memoryDir, settings: { ...settings, enabled: false } })
    expect(result).toMatchObject({ enabled: false, embedded: 0 })
    expect(embedCalls).toHaveLength(0)
  })

  it('keeps the page unfingerprinted when the endpoint fails, so the next run retries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response))
    const failed = await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    expect(failed.embedded).toBe(0)
    expect(failed.failed).toBe(2)
    expect(loadWikiPageVectors(db, settings.model)).toBeNull()
  })
})

describe('refreshFactPageMatches', () => {
  beforeEach(async () => {
    await refreshWikiPageEmbeddings(db, { memoryDir, settings })
  })

  it('stores the nearest page per fact and per strand centroid', async () => {
    const loopFact = insertFact('Routing avoids dead ends', 'strand-loop')
    const houseFact = insertFact('Roof insulation is 80 mm', 'strand-house')

    const result = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(result.computed).toBe(2)
    expect(result.strands).toBe(2)

    const facts = loadFactPageMatches(db, result.signature)
    expect(facts.get(loopFact)?.nodeId).toBe('wiki:looplab')
    expect(facts.get(loopFact)?.score).toBeCloseTo(1, 5)
    expect(facts.get(houseFact)?.nodeId).toBe('wiki:haus-sanierung')

    const strands = loadStrandPageMatches(db, result.signature)
    expect(strands.get('strand-loop')?.nodeId).toBe('wiki:looplab')
    expect(strands.get('strand-house')?.nodeId).toBe('wiki:haus-sanierung')
  })

  it('computes nothing on a second run and only picks up new facts', async () => {
    insertFact('Routing avoids dead ends', 'strand-loop')
    const first = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(first.computed).toBe(1)

    const second = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(second.computed).toBe(0)
    expect(second.strands).toBe(0)

    insertFact('Routing prefers forest roads', 'strand-loop')
    const third = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(third.computed).toBe(1)
    expect(third.strands).toBe(1)
  })

  it('drops matches of a stale page signature when a page changes', async () => {
    const factId = insertFact('Routing avoids dead ends', 'strand-loop')
    const before = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(loadFactPageMatches(db, before.signature).has(factId)).toBe(true)

    writePage('looplab.md', '# Looplab\n\nRouting for gravel loops, now with trail hunts.\n')
    await refreshWikiPageEmbeddings(db, { memoryDir, settings })
    const after = await refreshFactPageMatches(db, { memoryDir, settings })

    expect(after.signature).not.toBe(before.signature)
    expect(after.cleared).toBe(1)
    expect(loadFactPageMatches(db, before.signature).size).toBe(0)
    expect(loadFactPageMatches(db, after.signature).has(factId)).toBe(true)
  })

  it('ignores facts without an embedding', async () => {
    insertFact('No vector here', 'strand-loop', null)
    const result = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(result.computed).toBe(0)
  })

  it('returns an empty result when no page vectors exist', async () => {
    db.prepare('DELETE FROM wiki_page_embeddings').run()
    insertFact('Routing avoids dead ends', 'strand-loop')
    const result = await refreshFactPageMatches(db, { memoryDir, settings })
    expect(result).toMatchObject({ computed: 0, vectors: 0 })
  })
})

describe('memoryPageIndexState', () => {
  it('reports staleness until pages, facts and strands are all matched', async () => {
    insertFact('Routing avoids dead ends', 'strand-loop')
    const empty = memoryPageIndexState(db, { memoryDir, settings })
    expect(empty).toMatchObject({ enabled: true, pages: 2, embeddedPages: 0, stale: true })

    await refreshMemoryPageIndex(db, { memoryDir, settings })
    const filled = memoryPageIndexState(db, { memoryDir, settings })
    expect(filled).toMatchObject({ embeddedPages: 2, matchedFacts: 1, matchedStrands: 1, stale: false })
    expect(filled.signature).toBe(pagesSignature(wikiPageFingerprints(memoryDir), settings.model))

    writePage('looplab.md', '# Looplab\n\nRouting, changed.\n')
    expect(memoryPageIndexState(db, { memoryDir, settings }).stale).toBe(true)
  })

  it('never reports staleness when embeddings are disabled', () => {
    const state = memoryPageIndexState(db, { memoryDir, settings: { ...settings, enabled: false } })
    expect(state.enabled).toBe(false)
    expect(state.stale).toBe(false)
  })
})
