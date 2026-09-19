/**
 * Structured memory view over a real temp wiki and an in-memory database.
 * The tree must come out of the data, so every expectation here is derived
 * from the files and rows written in `beforeEach`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { EMBEDDING_ASSIGN_MIN_SCORE, embeddingToBuffer } from './memory-embeddings.js'
import { pagesSignature, refreshFactPageMatches, wikiPageFingerprints } from './memory-page-embeddings.js'
import {
  UNASSIGNED_NODE_ID,
  buildMemoryGraph,
  buildMemoryTree,
  buildMemoryViewIndex,
  getFactDetail,
  listNodeFacts,
  memoryViewSignature,
  scanWikiPages,
} from './memory-view.js'

let db: Database
let memoryDir: string
let wikiDir: string

function writePage(relPath: string, content: string): void {
  const full = path.join(wikiDir, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf-8')
}

function insertSession(id: string, title: string): void {
  db.prepare(
    "INSERT INTO sessions (id, user_id, source, type, agent_id, title, session_user) VALUES (?, 1, 'web', 'interactive', 'main', ?, '1')",
  ).run(id, title)
}

function insertFact(
  content: string,
  overrides: Partial<{
    userId: number | null
    sessionId: string | null
    agentId: string
    source: string
    provenance: string
    status: string
    supersessionKey: string | null
    supersededBy: number | null
    timestamp: string
  }> = {},
): number {
  const result = db.prepare(
    `INSERT INTO memories (user_id, session_id, content, source, agent_id, provenance, supersession_key, status, superseded_by, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.userId === undefined ? 1 : overrides.userId,
    overrides.sessionId ?? null,
    content,
    overrides.source ?? 'extracted_fact',
    overrides.agentId ?? 'main',
    overrides.provenance ?? 'agent',
    overrides.supersessionKey ?? null,
    overrides.status ?? 'active',
    overrides.supersededBy ?? null,
    overrides.timestamp ?? '2026-09-01 10:00:00',
  )
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-memory-view-'))
  wikiDir = path.join(memoryDir, 'wiki')
  fs.mkdirSync(wikiDir, { recursive: true })

  writePage('index.md', [
    '---',
    'type: index',
    '---',
    '# Wiki Index',
    '',
    '- [looplab](looplab.md) route generator',
    '- [werkstattlog](werkstattlog.md) maintenance log',
    '- [haus-sanierung](haus-sanierung.md) house project',
    '- [missing](missing-page.md) dangling link',
    '- [external](https://example.com/page.md)',
  ].join('\n'))
  writePage('looplab.md', '---\naliases: [Loop Lab, loopgen]\n---\n# Looplab\n\nSee [werkstattlog](werkstattlog.md).\n')
  writePage('werkstattlog.md', '# Werkstattlog\n\nNo links here.\n')
  writePage('haus-sanierung.md', '---\naliases: [Sanierung]\n---\n# Haus Sanierung\n')
  writePage('orphan.md', '# Orphan Page\n')
  writePage('research/finance-tracker.md', '# Finance Tracker\n')
  writePage('research/index.md', '# Research Index\n\n[finance tracker](finance-tracker.md)\n')

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('admin', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (2, ?, ?, ?)').run('other', 'x', 'user')
  insertSession('strand-a', 'Bike routing')
  insertSession('strand-b', 'House work')
})

afterEach(() => {
  db.close()
  fs.rmSync(memoryDir, { recursive: true, force: true })
})

describe('scanWikiPages', () => {
  it('reads titles, aliases, directories and resolves links between pages', () => {
    const pages = scanWikiPages(memoryDir)
    const byId = new Map(pages.map(page => [page.id, page]))

    expect(pages.map(page => page.relPath)).toEqual([
      'haus-sanierung.md',
      'index.md',
      'looplab.md',
      'orphan.md',
      'research/finance-tracker.md',
      'research/index.md',
      'werkstattlog.md',
    ])
    expect(byId.get('wiki:looplab')?.title).toBe('Looplab')
    expect(byId.get('wiki:looplab')?.aliases).toEqual(['Loop Lab', 'loopgen'])
    expect(byId.get('wiki:research/finance-tracker')?.dir).toBe('research')
    expect(byId.get('wiki:index')?.linksOut).toEqual(['haus-sanierung.md', 'looplab.md', 'werkstattlog.md'])
    expect(byId.get('wiki:research/index')?.linksOut).toEqual(['research/finance-tracker.md'])
  })
})

describe('buildMemoryTree', () => {
  it('derives folders and hub pages from the data instead of a fixed taxonomy', () => {
    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const tree = buildMemoryTree(index)
    const rootIds = tree.nodes.map(node => node.id)

    expect(rootIds).toContain('folder:research')
    expect(rootIds).toContain('wiki:index')
    expect(rootIds).toContain('wiki:orphan')
    expect(rootIds).toContain(UNASSIGNED_NODE_ID)

    const hub = tree.nodes.find(node => node.id === 'wiki:index')!
    expect(hub.children.map(child => child.id).sort()).toEqual([
      'wiki:haus-sanierung',
      'wiki:looplab',
      'wiki:werkstattlog',
    ])

    const folder = tree.nodes.find(node => node.id === 'folder:research')!
    expect(folder.type).toBe('folder')
    expect(folder.children.map(child => child.id)).toEqual([
      'wiki:research/finance-tracker',
      'wiki:research/index',
    ])
    expect(tree.totals.pages).toBe(7)
    expect(tree.totals.folders).toBe(1)
  })

  it('counts facts per node and rolls them up into the subtree count', () => {
    insertFact('Looplab generates round trips from a start point', { sessionId: 'strand-a' })
    insertFact('The Loop Lab router uses gpx exports', { sessionId: 'strand-a' })
    insertFact('Werkstattlog tracks the bike service intervals', { sessionId: 'strand-a' })
    insertFact('Nothing in this sentence matches any page name')

    const tree = buildMemoryTree(buildMemoryViewIndex(db, { memoryDir, userId: 1 }))
    const hub = tree.nodes.find(node => node.id === 'wiki:index')!
    const looplab = hub.children.find(child => child.id === 'wiki:looplab')!

    expect(looplab.factCount).toBe(2)
    expect(hub.factCount).toBe(0)
    expect(hub.subtreeFactCount).toBe(3)
    expect(tree.totals.facts).toBe(4)
    expect(tree.totals.unassignedFacts).toBe(1)
    expect(tree.nodes.find(node => node.id === UNASSIGNED_NODE_ID)!.factCount).toBe(1)
  })

  it('lets a fact inherit the node of its strand when the strand has a clear majority', () => {
    insertFact('Looplab generates round trips from a start point', { sessionId: 'strand-a' })
    insertFact('Looplab exports the result as gpx', { sessionId: 'strand-a' })
    insertFact('The elevation filter drops anything above 400 metres', { sessionId: 'strand-a' })

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const facts = index.factsByNode.get('wiki:looplab')!

    expect(facts).toHaveLength(3)
    const inherited = facts.find(fact => fact.content.startsWith('The elevation filter'))!
    expect(inherited.matchedBy).toBe('strand_majority')
    expect(inherited.matchedTerm).toBeNull()
    expect(facts.find(fact => fact.content.startsWith('Looplab generates'))!.matchedBy).toBe('term')
    expect(index.unassignedFacts).toBe(0)
  })

  it('does not inherit when the strand has no clear majority', () => {
    insertFact('Looplab generates round trips', { sessionId: 'strand-b' })
    insertFact('Werkstattlog tracks the service intervals', { sessionId: 'strand-b' })
    insertFact('The elevation filter drops anything above 400 metres', { sessionId: 'strand-b' })

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })

    expect(index.unassignedFacts).toBe(1)
    expect(index.factsByNode.get(UNASSIGNED_NODE_ID)![0].matchedBy).toBe('none')
  })

  it('does not inherit from a single term match', () => {
    insertFact('Looplab generates round trips', { sessionId: 'strand-a' })
    insertFact('The elevation filter drops anything above 400 metres', { sessionId: 'strand-a' })

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })

    expect(index.unassignedFacts).toBe(1)
  })

  it('keeps parents of matching nodes when a query is given', () => {
    const tree = buildMemoryTree(buildMemoryViewIndex(db, { memoryDir, userId: 1 }), { query: 'loopgen' })

    expect(tree.nodes.map(node => node.id)).toEqual(['wiki:index'])
    expect(tree.nodes[0].children.map(node => node.id)).toEqual(['wiki:looplab'])
  })

  it('reports a flat tree honestly when the wiki has no structure', () => {
    fs.rmSync(wikiDir, { recursive: true, force: true })
    fs.mkdirSync(wikiDir, { recursive: true })
    writePage('alpha.md', '# Alpha\n')
    writePage('beta.md', '# Beta\n')

    const tree = buildMemoryTree(buildMemoryViewIndex(db, { memoryDir, userId: 1 }))

    expect(tree.nodes.every(node => node.children.length === 0)).toBe(true)
    expect(tree.notes.some(note => note.includes('flat by construction'))).toBe(true)
  })

  it('scopes facts to the requesting user and to the persona when asked', () => {
    insertFact('Looplab belongs to the first user', { userId: 1 })
    insertFact('Looplab belongs to the second user', { userId: 2 })
    insertFact('Looplab has a shared note', { userId: null, agentId: 'shared' })
    insertFact('Looplab has a bob note', { userId: 1, agentId: 'bob' })

    const mine = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    expect(mine.totalFacts).toBe(3)

    const admin = buildMemoryViewIndex(db, { memoryDir, userId: null })
    expect(admin.totalFacts).toBe(4)

    const bob = buildMemoryViewIndex(db, { memoryDir, userId: 1, agentId: 'bob' })
    expect(bob.totalFacts).toBe(2)
  })
})

describe('listNodeFacts', () => {
  it('paginates with a stable cursor and hides superseded facts by default', () => {
    const ids = [1, 2, 3, 4, 5].map(n => insertFact(`Looplab detail number ${n}`, {
      sessionId: 'strand-a',
      timestamp: `2026-09-0${n} 10:00:00`,
    }))
    insertFact('Looplab retired detail', { status: 'superseded', supersededBy: ids[0] })

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const first = listNodeFacts(index, 'wiki:looplab', { limit: 2 })
    expect(first.total).toBe(5)
    expect(first.facts).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()

    const second = listNodeFacts(index, 'wiki:looplab', { limit: 2, cursor: first.nextCursor })
    expect(second.facts.map(fact => fact.id)).not.toEqual(first.facts.map(fact => fact.id))

    const third = listNodeFacts(index, 'wiki:looplab', { limit: 2, cursor: second.nextCursor })
    expect(third.facts).toHaveLength(1)
    expect(third.nextCursor).toBeNull()

    const withSuperseded = listNodeFacts(index, 'wiki:looplab', { limit: 50, includeSuperseded: true })
    expect(withSuperseded.total).toBe(6)
  })

  it('marks contradicting facts on the same node', () => {
    insertFact('Looplab runs on port 3800', { supersessionKey: 'looplab.port' })
    insertFact('Looplab runs on port 3900', { supersessionKey: 'looplab.port' })
    insertFact('Looplab is written in typescript')

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const result = listNodeFacts(index, 'wiki:looplab', { limit: 50 })
    const conflicting = result.facts.filter(fact => fact.conflict)

    expect(conflicting).toHaveLength(2)
    expect(conflicting[0].conflictWith[0].reason).toBe('same_subject_key')
    expect(result.facts.find(fact => fact.content.includes('typescript'))!.conflict).toBe(false)
  })

  it('rejects an unknown node and a foreign cursor', () => {
    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    expect(() => listNodeFacts(index, 'wiki:does-not-exist')).toThrow(/Unknown node/)
    expect(() => listNodeFacts(index, 'wiki:looplab', { cursor: 'not-a-cursor' })).toThrow()
  })
})

describe('buildMemoryGraph', () => {
  it('returns nodes and edges around a root and never exceeds the node cap', () => {
    insertFact('Looplab generates round trips', { sessionId: 'strand-a' })
    insertFact('Werkstattlog tracks services', { sessionId: 'strand-b' })

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const graph = buildMemoryGraph(index, { root: 'wiki:index', depth: 1 })

    expect(graph.nodes[0].id).toBe('wiki:index')
    expect(graph.nodes.map(node => node.id)).toContain('wiki:looplab')
    expect(graph.edges.some(edge => edge.from === 'wiki:index' && edge.to === 'wiki:looplab' && edge.type === 'wiki_link')).toBe(true)

    const deep = buildMemoryGraph(index, { root: 'wiki:index', depth: 2 })
    expect(deep.nodes.map(node => node.id)).toContain('strand:strand-a')
    expect(deep.edges.some(edge => edge.from === 'strand:strand-a' && edge.type === 'fact_origin')).toBe(true)

    const capped = buildMemoryGraph(index, { depth: 2, limit: 3 })
    expect(capped.nodes.length).toBeLessThanOrEqual(3)
    expect(capped.truncated).toBe(true)
  })

  it('includes the folder containment edge', () => {
    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const graph = buildMemoryGraph(index, { root: 'folder:research', depth: 1 })

    expect(graph.edges.some(edge => edge.from === 'folder:research' && edge.type === 'contains')).toBe(true)
  })

  it('rejects an unknown root', () => {
    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    expect(() => buildMemoryGraph(index, { root: 'wiki:nope' })).toThrow(/Unknown node/)
  })
})

describe('getFactDetail', () => {
  it('returns origin, supersession chain and conflicts', () => {
    const oldId = insertFact('Looplab runs on port 3700', {
      sessionId: 'strand-a',
      supersessionKey: 'looplab.port',
      status: 'superseded',
      timestamp: '2026-08-01 10:00:00',
    })
    const newId = insertFact('Looplab runs on port 3800', {
      sessionId: 'strand-a',
      supersessionKey: 'looplab.port',
      timestamp: '2026-09-01 10:00:00',
    })
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newId, oldId)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const detail = getFactDetail(db, index, newId)!

    expect(detail.fact.id).toBe(newId)
    expect(detail.node?.id).toBe('wiki:looplab')
    expect(detail.origin.strandId).toBe('strand-a')
    expect(detail.origin.strandTitle).toBe('Bike routing')
    expect(detail.supersedes.map(entry => entry.id)).toEqual([oldId])
    expect(detail.supersededBy).toBeNull()
    expect(detail.history.map(entry => entry.id)).toEqual([oldId, newId])

    const older = getFactDetail(db, index, oldId)!
    expect(older.supersededBy?.id).toBe(newId)
  })

  it('returns null for a fact outside the scope', () => {
    const foreignId = insertFact('Looplab belongs to the second user', { userId: 2 })
    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })

    expect(getFactDetail(db, index, foreignId)).toBeNull()
  })
})

describe('memoryViewSignature', () => {
  it('changes when a fact is added and stays stable otherwise', () => {
    const before = memoryViewSignature(db, { memoryDir, userId: 1 })
    expect(memoryViewSignature(db, { memoryDir, userId: 1 })).toBe(before)

    insertFact('Looplab gained a new fact')
    expect(memoryViewSignature(db, { memoryDir, userId: 1 })).not.toBe(before)
  })
})

describe('semantic assignment (matchedBy: embedding)', () => {
  const MODEL = 'test-embed'
  const DIM = 4
  let previousDataDir: string | undefined
  let configDir: string

  const LOOP_VECTOR = [1, 0, 0, 0]
  const HOUSE_VECTOR = [0, 1, 0, 0]
  const MIXED_VECTOR = [0.6, 0.8, 0, 0]

  function writePageVector(relPath: string, nodeId: string, vector: number[]): void {
    db.prepare(
      `INSERT INTO wiki_page_embeddings (rel_path, chunk_index, node_id, fingerprint, model, dim, embedding, updated_at)
       VALUES (?, 0, ?, 'fixed', ?, ?, ?, datetime('now'))`,
    ).run(relPath, nodeId, MODEL, DIM, embeddingToBuffer(Float32Array.from(vector)))
  }

  function currentSignature(): string {
    return pagesSignature(wikiPageFingerprints(memoryDir), MODEL)
  }

  function writeMatch(factId: number, nodeId: string, score: number, signature = currentSignature()): void {
    db.prepare(
      `INSERT INTO memory_page_matches (fact_id, pages_signature, node_id, score, runner_up_score, updated_at)
       VALUES (?, ?, ?, ?, 0, datetime('now'))`,
    ).run(factId, signature, nodeId, score)
  }

  function writeStrandMatch(strandId: string, nodeId: string, score: number, signature = currentSignature()): void {
    db.prepare(
      `INSERT INTO memory_strand_matches (strand_id, pages_signature, fact_fingerprint, node_id, score, fact_count, updated_at)
       VALUES (?, ?, 'fixed', ?, ?, 1, datetime('now'))`,
    ).run(strandId, signature, nodeId, score)
  }

  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-embed-config-'))
    fs.mkdirSync(path.join(configDir, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'config', 'settings.json'),
      JSON.stringify({ memoryEmbeddings: { enabled: true, baseUrl: 'http://embed.test/v1', model: MODEL } }),
      'utf-8',
    )
    process.env.DATA_DIR = configDir
    writePageVector('looplab.md', 'wiki:looplab', LOOP_VECTOR)
    writePageVector('haus-sanierung.md', 'wiki:haus-sanierung', HOUSE_VECTOR)
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('files a fact whose strand centroid points at the same page', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.72)
    writeStrandMatch('strand-a', 'wiki:looplab', 0.81)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const fact = index.factById.get(factId)!

    expect(fact.nodeId).toBe('wiki:looplab')
    expect(fact.matchedBy).toBe('embedding')
    expect(fact.embeddingScore).toBeCloseTo(0.72, 4)
    expect(fact.embeddingStrandScore).toBeCloseTo(0.81, 4)
    expect(fact.matchedTerm).toBeNull()
    expect(index.matchedByCounts.embedding).toBe(1)
  })

  it('leaves a fact unassigned when the strand score is below the floor', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.72)
    writeStrandMatch('strand-a', 'wiki:looplab', 0.61)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const fact = index.factById.get(factId)!

    expect(fact.nodeId).toBe(UNASSIGNED_NODE_ID)
    expect(fact.matchedBy).toBe('none')
    expect(fact.embeddingScore).toBeNull()
  })

  it('leaves a fact unassigned when its own score is far below the floor', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.3)
    writeStrandMatch('strand-a', 'wiki:looplab', 0.9)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    expect(index.factById.get(factId)!.matchedBy).toBe('none')
  })

  it('leaves a fact unassigned when fact and strand disagree', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.9)
    writeStrandMatch('strand-a', 'wiki:haus-sanierung', 0.9)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    expect(index.factById.get(factId)!.matchedBy).toBe('none')
  })

  it('honours an explicit floor from the scope', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.55)
    writeStrandMatch('strand-a', 'wiki:looplab', 0.6)

    expect(buildMemoryViewIndex(db, { memoryDir, userId: 1 }).factById.get(factId)!.matchedBy).toBe('none')
    expect(buildMemoryViewIndex(db, { memoryDir, userId: 1, embeddingMinScore: 0.5 }).factById.get(factId)!.matchedBy)
      .toBe('embedding')
  })

  it('ignores matches that belong to an older page signature', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.9, 'stale-signature')
    writeStrandMatch('strand-a', 'wiki:looplab', 0.9, 'stale-signature')

    expect(buildMemoryViewIndex(db, { memoryDir, userId: 1 }).factById.get(factId)!.matchedBy).toBe('none')
  })

  it('keeps the term match and the strand majority ahead of the embedding rule', () => {
    const termFact = insertFact('Looplab got a new profile', { sessionId: 'strand-a' })
    writeMatch(termFact, 'wiki:haus-sanierung', 0.95)
    writeStrandMatch('strand-a', 'wiki:haus-sanierung', 0.95)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
    const fact = index.factById.get(termFact)!
    expect(fact.matchedBy).toBe('term')
    expect(fact.nodeId).toBe('wiki:looplab')
    expect(fact.embeddingScore).toBeNull()
  })

  it('reports the semantic count and the floor in the tree', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    writeMatch(factId, 'wiki:looplab', 0.72)
    writeStrandMatch('strand-a', 'wiki:looplab', 0.81)

    const tree = buildMemoryTree(buildMemoryViewIndex(db, { memoryDir, userId: 1 }))
    expect(tree.totals.byEmbedding).toBe(1)
    expect(tree.totals.byTerm + tree.totals.byStrandMajority + tree.totals.byEmbedding)
      .toBe(tree.totals.assignedFacts)
    expect(tree.limits.embeddingMinScore).toBe(EMBEDDING_ASSIGN_MIN_SCORE)
    expect(tree.limits.embeddedPages).toBe(2)
    expect(tree.notes.some(note => note.includes('embedding similarity'))).toBe(true)
  })

  it('changes the view signature when new matches land', () => {
    const factId = insertFact('The tour was trimmed by two dead ends', { sessionId: 'strand-a' })
    const before = memoryViewSignature(db, { memoryDir, userId: 1 })
    writeMatch(factId, 'wiki:looplab', 0.72)
    expect(memoryViewSignature(db, { memoryDir, userId: 1 })).not.toBe(before)
  })

  it('assigns end to end from the real matcher without any network call', async () => {
    const factId = insertFact('Something about roof and haus work', { sessionId: 'strand-b' })
    db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
      .run(embeddingToBuffer(Float32Array.from(MIXED_VECTOR)), factId)

    const result = await refreshFactPageMatches(db, {
      memoryDir,
      settings: { enabled: true, baseUrl: 'http://embed.test/v1', model: MODEL, timeoutMs: 1000, assignMinScore: 0.65 },
    })
    expect(result.computed).toBe(1)
    expect(result.strands).toBe(1)

    const index = buildMemoryViewIndex(db, { memoryDir, userId: 1, embeddingMinScore: 0.7 })
    const fact = index.factById.get(factId)!
    expect(fact.nodeId).toBe('wiki:haus-sanierung')
    expect(fact.matchedBy).toBe('embedding')
    expect(fact.embeddingScore).toBeCloseTo(0.8, 4)
  })
})

describe('notes while the page index is still filling', () => {
  it('separates missing page vectors from missing fact matches', () => {
    const previousDataDir = process.env.DATA_DIR
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-embed-note-'))
    fs.mkdirSync(path.join(configDir, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'config', 'settings.json'),
      JSON.stringify({ memoryEmbeddings: { enabled: true, baseUrl: 'http://embed.test/v1', model: 'note-model' } }),
      'utf-8',
    )
    process.env.DATA_DIR = configDir
    try {
      insertFact('A fact without any page vector')
      const empty = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
      expect(empty.notes.some(note => note.includes('No wiki page embeddings are stored'))).toBe(true)

      const vector = Float32Array.from([1, 0, 0, 0])
      db.prepare(
        `INSERT INTO wiki_page_embeddings (rel_path, chunk_index, node_id, fingerprint, model, dim, embedding, updated_at)
         VALUES ('looplab.md', 0, 'wiki:looplab', 'fixed', 'note-model', 4, ?, datetime('now'))`,
      ).run(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))

      const pending = buildMemoryViewIndex(db, { memoryDir, userId: 1 })
      expect(pending.notes.some(note => note.includes('no fact has been matched against them yet'))).toBe(true)
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previousDataDir
      fs.rmSync(configDir, { recursive: true, force: true })
    }
  })
})
