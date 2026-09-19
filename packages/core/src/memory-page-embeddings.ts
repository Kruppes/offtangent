/**
 * Semantic link between wiki pages and facts.
 *
 * The fact to node assignment of the memory view starts with a term match and
 * a strand majority fallback. Both need the fact text to name its page, which
 * extracted facts usually do not do, so most facts ended up in the unassigned
 * bucket. This module adds the missing signal: wiki pages are embedded with
 * the SAME endpoint and model the fact store already uses (`memoryEmbeddings`
 * in settings.json), and facts are matched against those vectors by cosine.
 *
 * Two properties of the data drive the design:
 *   - a page is a long document and a fact is one sentence, so a page is
 *     embedded in overlapping chunks and scores as the best of its chunks,
 *   - a single short fact is a weak query, so a fact is only assigned when the
 *     centroid of its whole strand points at the same page. Calibration on the
 *     live store showed this roughly triples coverage at equal precision
 *     compared to matching each fact on its own.
 *
 * Three persisted caches keep all of this off the request path:
 *   - `wiki_page_embeddings`: one row per page chunk, tagged with the model and
 *     a page fingerprint (`<mtimeMs>:<size>`). A page is re-embedded only when
 *     its fingerprint or the model changes.
 *   - `memory_page_matches`: nearest page per fact, tagged with a signature
 *     over the whole page set.
 *   - `memory_strand_matches`: nearest page per strand centroid, tagged with
 *     the same signature plus a per strand fact fingerprint.
 *
 * Everything degrades to a no-op when embeddings are disabled or the endpoint
 * is down: the caches stay empty, no fact gets a semantic node, and the term
 * and strand majority rules keep working unchanged.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { getMemoryDir } from './memory.js'
import {
  EMBEDDING_ASSIGN_MIN_SCORE,
  bufferToEmbedding,
  embedTexts,
  embeddingToBuffer,
  loadMemoryEmbeddingSettings,
  type MemoryEmbeddingSettings,
} from './memory-embeddings.js'
import { listWikiFiles, scanWikiPages, wikiDirFor, type WikiPageEntry } from './wiki-scan.js'

export { EMBEDDING_ASSIGN_MIN_SCORE }

/**
 * How far a single fact may fall below the strand floor and still be filed.
 * The strand centroid carries the assignment, the fact only has to be in the
 * same neighbourhood.
 */
export const EMBEDDING_FACT_SCORE_MARGIN = 0.2

/** Page chunking. Overlap keeps sentences that straddle a cut searchable. */
export const PAGE_CHUNK_CHARS = 1200
export const PAGE_CHUNK_OVERLAP = 200
export const PAGE_MAX_CHUNKS = 12

/**
 * Facts (or strands) scored per cosine chunk before the loop yields. Sized so
 * one chunk stays around 100 ms against a few hundred page vectors: this runs
 * in the background of a live server, it must not hold the event loop.
 */
const MATCH_CHUNK_SIZE = 20
/** Same budget for strands, which cost one centroid plus one scan each. */
const STRAND_CHUNK_SIZE = 8

/** Page chunks sent to the embedding endpoint in one request. */
const PAGE_EMBED_BATCH_SIZE = 8

export function ensureMemoryPageEmbeddingTables(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_page_embeddings (
      rel_path TEXT NOT NULL,
      chunk_index INTEGER NOT NULL DEFAULT 0,
      node_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (rel_path, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS memory_page_matches (
      fact_id INTEGER PRIMARY KEY,
      pages_signature TEXT NOT NULL,
      node_id TEXT NOT NULL,
      score REAL NOT NULL,
      runner_up_score REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_page_matches_signature
      ON memory_page_matches(pages_signature);

    CREATE TABLE IF NOT EXISTS memory_strand_matches (
      strand_id TEXT PRIMARY KEY,
      pages_signature TEXT NOT NULL,
      fact_fingerprint TEXT NOT NULL,
      node_id TEXT NOT NULL,
      score REAL NOT NULL,
      fact_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_strand_matches_signature
      ON memory_strand_matches(pages_signature);
  `)
}

export interface WikiPageFingerprint {
  relPath: string
  fingerprint: string
}

/** Stat only, so the request path can check staleness without reading files. */
export function wikiPageFingerprints(memoryDir?: string): WikiPageFingerprint[] {
  const wikiDir = wikiDirFor(memoryDir)
  const out: WikiPageFingerprint[] = []
  for (const file of listWikiFiles(wikiDir)) {
    try {
      const stats = fs.statSync(file)
      out.push({
        relPath: path.relative(wikiDir, file).split(path.sep).join('/'),
        fingerprint: `${Math.round(stats.mtimeMs)}:${stats.size}`,
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath))
}

export function pagesSignature(fingerprints: readonly WikiPageFingerprint[], model: string): string {
  const payload = [model, ...fingerprints.map(entry => `${entry.relPath}=${entry.fingerprint}`)].join('\n')
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

function pageHeader(page: WikiPageEntry): string {
  return [page.title, page.name.replace(/[-_]+/g, ' '), ...page.aliases]
    .map(part => part.trim())
    .filter(Boolean)
    .join('. ')
}

function pageBody(content: string): string {
  return content
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Texts embedded for one page: overlapping body windows, each prefixed with
 * title and aliases so a chunk stays attributable to its subject.
 */
export function wikiPageChunkTexts(page: WikiPageEntry, content: string): string[] {
  const header = pageHeader(page)
  const body = pageBody(content)
  if (!body) return [header]
  const step = PAGE_CHUNK_CHARS - PAGE_CHUNK_OVERLAP
  const texts: string[] = []
  for (let start = 0; start < body.length && texts.length < PAGE_MAX_CHUNKS; start += step) {
    texts.push(`${header}\n${body.slice(start, start + PAGE_CHUNK_CHARS)}`)
    if (start + PAGE_CHUNK_CHARS >= body.length) break
  }
  return texts
}

interface PageEmbeddingRow {
  node_id: string
  dim: number
  embedding: Buffer
}

export interface WikiPageVectors {
  model: string
  dim: number
  /** Node id per row of `matrix`, several rows per page (one per chunk). */
  nodeIds: string[]
  /** `nodeIds.length * dim` floats, L2 normalized. */
  matrix: Float32Array
}

/** Normalized chunk matrix for the current model. Null when nothing is stored. */
export function loadWikiPageVectors(db: Database, model: string): WikiPageVectors | null {
  let rows: PageEmbeddingRow[]
  try {
    rows = db.prepare(
      'SELECT node_id, dim, embedding FROM wiki_page_embeddings WHERE model = ? ORDER BY rel_path, chunk_index',
    ).all(model) as PageEmbeddingRow[]
  } catch {
    return null
  }
  if (rows.length === 0) return null

  const dim = rows[0]!.dim
  const usable = rows.filter(row => row.dim === dim && row.embedding.length >= dim * 4)
  if (usable.length === 0) return null

  const matrix = new Float32Array(usable.length * dim)
  const nodeIds: string[] = []
  for (let i = 0; i < usable.length; i++) {
    const row = usable[i]!
    const vector = bufferToEmbedding(row.embedding)
    let norm = 0
    for (let d = 0; d < dim; d++) norm += vector[d]! * vector[d]!
    norm = Math.sqrt(norm)
    const scale = norm === 0 ? 0 : 1 / norm
    const offset = i * dim
    for (let d = 0; d < dim; d++) matrix[offset + d] = vector[d]! * scale
    nodeIds.push(row.node_id)
  }
  return { model, dim, nodeIds, matrix }
}

export interface PageEmbeddingRefreshResult {
  enabled: boolean
  /** Pages whose chunks were embedded in this run. */
  embedded: number
  chunks: number
  removed: number
  unchanged: number
  failed: number
}

/**
 * Embed wiki pages whose fingerprint or model changed and drop rows of pages
 * that no longer exist. Reads page files only for the pages it embeds.
 */
export async function refreshWikiPageEmbeddings(
  db: Database,
  options: { memoryDir?: string; settings?: MemoryEmbeddingSettings } = {},
): Promise<PageEmbeddingRefreshResult> {
  const settings = options.settings ?? loadMemoryEmbeddingSettings()
  const result: PageEmbeddingRefreshResult = {
    enabled: settings.enabled,
    embedded: 0,
    chunks: 0,
    removed: 0,
    unchanged: 0,
    failed: 0,
  }
  if (!settings.enabled) return result

  ensureMemoryPageEmbeddingTables(db)
  const memoryDir = options.memoryDir ?? getMemoryDir()
  const wikiDir = wikiDirFor(memoryDir)
  const fingerprints = new Map(wikiPageFingerprints(memoryDir).map(entry => [entry.relPath, entry.fingerprint]))

  const stored = new Map<string, { fingerprint: string; model: string }>()
  for (const row of db.prepare(
    'SELECT rel_path, fingerprint, model FROM wiki_page_embeddings GROUP BY rel_path',
  ).all() as Array<{ rel_path: string; fingerprint: string; model: string }>) {
    stored.set(row.rel_path, { fingerprint: row.fingerprint, model: row.model })
  }

  const removeStatement = db.prepare('DELETE FROM wiki_page_embeddings WHERE rel_path = ?')
  for (const relPath of stored.keys()) {
    if (fingerprints.has(relPath)) continue
    removeStatement.run(relPath)
    result.removed += 1
  }

  const pages = scanWikiPages(memoryDir)
  const pending: Array<{ page: WikiPageEntry; fingerprint: string; texts: string[] }> = []
  for (const page of pages) {
    const fingerprint = fingerprints.get(page.relPath)
    if (!fingerprint) continue
    const current = stored.get(page.relPath)
    if (current && current.fingerprint === fingerprint && current.model === settings.model) {
      result.unchanged += 1
      continue
    }
    let content = ''
    try {
      content = fs.readFileSync(path.join(wikiDir, page.relPath), 'utf-8')
    } catch {
      result.failed += 1
      continue
    }
    pending.push({ page, fingerprint, texts: wikiPageChunkTexts(page, content) })
  }

  const insert = db.prepare(
    `INSERT INTO wiki_page_embeddings (rel_path, chunk_index, node_id, fingerprint, model, dim, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(rel_path, chunk_index) DO UPDATE SET
       node_id = excluded.node_id, fingerprint = excluded.fingerprint, model = excluded.model,
       dim = excluded.dim, embedding = excluded.embedding, updated_at = excluded.updated_at`,
  )

  for (const entry of pending) {
    let stored = 0
    let failed = false
    for (let start = 0; start < entry.texts.length; start += PAGE_EMBED_BATCH_SIZE) {
      const batch = entry.texts.slice(start, start + PAGE_EMBED_BATCH_SIZE)
      const vectors = await embedTexts(batch, settings)
      if (!vectors) {
        failed = true
        break
      }
      for (let i = 0; i < batch.length; i++) {
        const vector = vectors[i]
        if (!vector || vector.length === 0) continue
        insert.run(
          entry.page.relPath,
          start + i,
          entry.page.id,
          entry.fingerprint,
          settings.model,
          vector.length,
          embeddingToBuffer(vector),
        )
        stored += 1
      }
    }
    if (failed || stored === 0) {
      // Leave the page unfingerprinted so the next run retries it.
      db.prepare('DELETE FROM wiki_page_embeddings WHERE rel_path = ?').run(entry.page.relPath)
      result.failed += 1
      continue
    }
    db.prepare('DELETE FROM wiki_page_embeddings WHERE rel_path = ? AND chunk_index >= ?').run(entry.page.relPath, stored)
    result.embedded += 1
    result.chunks += stored
  }

  return result
}

export interface FactMatchRefreshResult {
  signature: string
  computed: number
  strands: number
  vectors: number
  cleared: number
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

interface BestMatch {
  index: number
  score: number
  runnerUp: number
}

function bestMatch(vector: Float32Array, matrix: Float32Array, dim: number, rows: number): BestMatch | null {
  let best = -1
  let bestIndex = -1
  let runnerUp = -1
  for (let r = 0; r < rows; r++) {
    const offset = r * dim
    let dot = 0
    for (let d = 0; d < dim; d++) dot += vector[d]! * matrix[offset + d]!
    if (dot > best) {
      runnerUp = best
      best = dot
      bestIndex = r
    } else if (dot > runnerUp) {
      runnerUp = dot
    }
  }
  return bestIndex < 0 ? null : { index: bestIndex, score: best, runnerUp: Math.max(runnerUp, 0) }
}

function normalizedCopy(vector: Float32Array, dim: number, target: Float32Array): boolean {
  if (vector.length < dim) return false
  let norm = 0
  for (let d = 0; d < dim; d++) norm += vector[d]! * vector[d]!
  norm = Math.sqrt(norm)
  if (norm === 0) return false
  const scale = 1 / norm
  for (let d = 0; d < dim; d++) target[d] = vector[d]! * scale
  return true
}

/**
 * Nearest wiki page per fact and per strand centroid. Pure cosine over stored
 * vectors, so a cached row stays valid until the page signature changes (fact
 * rows) or the strand gains facts (strand rows).
 */
export async function refreshFactPageMatches(
  db: Database,
  options: { memoryDir?: string; settings?: MemoryEmbeddingSettings; maxFacts?: number } = {},
): Promise<FactMatchRefreshResult> {
  const settings = options.settings ?? loadMemoryEmbeddingSettings()
  ensureMemoryPageEmbeddingTables(db)
  const memoryDir = options.memoryDir ?? getMemoryDir()
  const signature = pagesSignature(wikiPageFingerprints(memoryDir), settings.model)
  const empty: FactMatchRefreshResult = { signature, computed: 0, strands: 0, vectors: 0, cleared: 0 }
  if (!settings.enabled) return empty

  const vectors = loadWikiPageVectors(db, settings.model)
  if (!vectors) return empty

  const clearedFacts = db.prepare('DELETE FROM memory_page_matches WHERE pages_signature != ?').run(signature)
  db.prepare('DELETE FROM memory_strand_matches WHERE pages_signature != ?').run(signature)
  const cleared = typeof clearedFacts.changes === 'number' ? clearedFacts.changes : 0

  const { dim, nodeIds, matrix } = vectors
  const rowCount = nodeIds.length
  const scratch = new Float32Array(dim)
  const maxFacts = Math.max(1, Math.floor(options.maxFacts ?? 100000))

  const factRows = db.prepare(
    `SELECT m.id, m.embedding FROM memories m
     LEFT JOIN memory_page_matches p ON p.fact_id = m.id AND p.pages_signature = ?
     WHERE m.embedding IS NOT NULL AND p.fact_id IS NULL
     LIMIT ?`,
  ).all(signature, maxFacts) as Array<{ id: number; embedding: Buffer }>

  const upsertFact = db.prepare(
    `INSERT INTO memory_page_matches (fact_id, pages_signature, node_id, score, runner_up_score, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(fact_id) DO UPDATE SET
       pages_signature = excluded.pages_signature, node_id = excluded.node_id, score = excluded.score,
       runner_up_score = excluded.runner_up_score, updated_at = excluded.updated_at`,
  )

  let computed = 0
  for (let start = 0; start < factRows.length; start += MATCH_CHUNK_SIZE) {
    const chunk = factRows.slice(start, start + MATCH_CHUNK_SIZE)
    db.transaction(() => {
      for (const row of chunk) {
        if (!normalizedCopy(bufferToEmbedding(row.embedding), dim, scratch)) continue
        const best = bestMatch(scratch, matrix, dim, rowCount)
        if (!best) continue
        upsertFact.run(row.id, signature, nodeIds[best.index]!, best.score, best.runnerUp)
        computed += 1
      }
    })()
    if (start + MATCH_CHUNK_SIZE < factRows.length) await yieldToEventLoop()
  }

  const strands = await refreshStrandMatches(db, { signature, dim, nodeIds, matrix })
  return { signature, computed, strands, vectors: rowCount, cleared }
}

async function refreshStrandMatches(
  db: Database,
  context: { signature: string; dim: number; nodeIds: string[]; matrix: Float32Array },
): Promise<number> {
  const { signature, dim, nodeIds, matrix } = context
  const rowCount = nodeIds.length

  const current = db.prepare(
    `SELECT session_id AS strandId, COUNT(*) AS factCount, MAX(id) AS maxId
     FROM memories
     WHERE session_id IS NOT NULL AND embedding IS NOT NULL
     GROUP BY session_id`,
  ).all() as Array<{ strandId: string; factCount: number; maxId: number }>

  const stored = new Map<string, string>()
  for (const row of db.prepare(
    'SELECT strand_id, fact_fingerprint FROM memory_strand_matches WHERE pages_signature = ?',
  ).all(signature) as Array<{ strand_id: string; fact_fingerprint: string }>) {
    stored.set(row.strand_id, row.fact_fingerprint)
  }

  const outdated = current.filter(row => stored.get(row.strandId) !== `${row.factCount}:${row.maxId}`)
  if (outdated.length === 0) return 0

  const upsert = db.prepare(
    `INSERT INTO memory_strand_matches (strand_id, pages_signature, fact_fingerprint, node_id, score, fact_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(strand_id) DO UPDATE SET
       pages_signature = excluded.pages_signature, fact_fingerprint = excluded.fact_fingerprint,
       node_id = excluded.node_id, score = excluded.score, fact_count = excluded.fact_count,
       updated_at = excluded.updated_at`,
  )
  const factsOf = db.prepare('SELECT embedding FROM memories WHERE session_id = ? AND embedding IS NOT NULL')

  const centroid = new Float32Array(dim)
  const scratch = new Float32Array(dim)
  let written = 0
  for (let start = 0; start < outdated.length; start += STRAND_CHUNK_SIZE) {
    const chunk = outdated.slice(start, start + STRAND_CHUNK_SIZE)
    db.transaction(() => {
      for (const strand of chunk) {
        centroid.fill(0)
        let used = 0
        for (const row of factsOf.all(strand.strandId) as Array<{ embedding: Buffer }>) {
          if (!normalizedCopy(bufferToEmbedding(row.embedding), dim, scratch)) continue
          for (let d = 0; d < dim; d++) centroid[d]! += scratch[d]!
          used += 1
        }
        if (used === 0) continue
        if (!normalizedCopy(centroid, dim, scratch)) continue
        const best = bestMatch(scratch, matrix, dim, rowCount)
        if (!best) continue
        upsert.run(
          strand.strandId,
          signature,
          `${strand.factCount}:${strand.maxId}`,
          nodeIds[best.index]!,
          best.score,
          used,
        )
        written += 1
      }
    })()
    if (start + STRAND_CHUNK_SIZE < outdated.length) await yieldToEventLoop()
  }
  return written
}

export interface FactPageMatch {
  nodeId: string
  score: number
}

export function loadFactPageMatches(db: Database, signature: string): Map<number, FactPageMatch> {
  const out = new Map<number, FactPageMatch>()
  try {
    for (const row of db.prepare(
      'SELECT fact_id, node_id, score FROM memory_page_matches WHERE pages_signature = ?',
    ).all(signature) as Array<{ fact_id: number; node_id: string; score: number }>) {
      out.set(row.fact_id, { nodeId: row.node_id, score: row.score })
    }
  } catch {
    return out
  }
  return out
}

export function loadStrandPageMatches(db: Database, signature: string): Map<string, FactPageMatch> {
  const out = new Map<string, FactPageMatch>()
  try {
    for (const row of db.prepare(
      'SELECT strand_id, node_id, score FROM memory_strand_matches WHERE pages_signature = ?',
    ).all(signature) as Array<{ strand_id: string; node_id: string; score: number }>) {
      out.set(row.strand_id, { nodeId: row.node_id, score: row.score })
    }
  } catch {
    return out
  }
  return out
}

export interface MemoryPageIndexState {
  enabled: boolean
  model: string
  signature: string
  pages: number
  embeddedPages: number
  chunks: number
  matchedFacts: number
  embeddableFacts: number
  matchedStrands: number
  strands: number
  stale: boolean
}

/** Cheap staleness probe for the request path: stat plus a few COUNT queries. */
export function memoryPageIndexState(
  db: Database,
  options: { memoryDir?: string; settings?: MemoryEmbeddingSettings } = {},
): MemoryPageIndexState {
  const settings = options.settings ?? loadMemoryEmbeddingSettings()
  const fingerprints = wikiPageFingerprints(options.memoryDir)
  const signature = pagesSignature(fingerprints, settings.model)
  const state: MemoryPageIndexState = {
    enabled: settings.enabled,
    model: settings.model,
    signature,
    pages: fingerprints.length,
    embeddedPages: 0,
    chunks: 0,
    matchedFacts: 0,
    embeddableFacts: 0,
    matchedStrands: 0,
    strands: 0,
    stale: false,
  }
  if (!settings.enabled) return state

  try {
    const pageRow = db.prepare(
      'SELECT COUNT(DISTINCT rel_path) AS pages, COUNT(*) AS chunks FROM wiki_page_embeddings WHERE model = ?',
    ).get(settings.model) as { pages: number; chunks: number }
    state.embeddedPages = pageRow.pages
    state.chunks = pageRow.chunks
    state.matchedFacts = (db.prepare(
      'SELECT COUNT(*) AS count FROM memory_page_matches WHERE pages_signature = ?',
    ).get(signature) as { count: number }).count
    state.embeddableFacts = (db.prepare(
      'SELECT COUNT(*) AS count FROM memories WHERE embedding IS NOT NULL',
    ).get() as { count: number }).count
    state.matchedStrands = (db.prepare(
      'SELECT COUNT(*) AS count FROM memory_strand_matches WHERE pages_signature = ?',
    ).get(signature) as { count: number }).count
    state.strands = (db.prepare(
      'SELECT COUNT(DISTINCT session_id) AS count FROM memories WHERE session_id IS NOT NULL AND embedding IS NOT NULL',
    ).get() as { count: number }).count
  } catch {
    return state
  }

  state.stale = state.embeddedPages !== fingerprints.length
    || state.matchedFacts < state.embeddableFacts
    || state.matchedStrands < state.strands
  return state
}

export interface MemoryPageIndexRefreshResult {
  pages: PageEmbeddingRefreshResult
  matches: FactMatchRefreshResult
  durationMs: number
}

/**
 * Full refresh: page chunk vectors first, then the nearest page per fact and
 * per strand. Safe to call on every startup and whenever the state probe
 * reports staleness; it does no network call and no cosine work when nothing
 * changed.
 */
export async function refreshMemoryPageIndex(
  db: Database,
  options: { memoryDir?: string; settings?: MemoryEmbeddingSettings } = {},
): Promise<MemoryPageIndexRefreshResult> {
  const started = Date.now()
  const pages = await refreshWikiPageEmbeddings(db, options)
  const matches = await refreshFactPageMatches(db, options)
  return { pages, matches, durationMs: Date.now() - started }
}
