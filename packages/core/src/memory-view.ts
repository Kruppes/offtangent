/**
 * Structured read model over what the instance knows (SPEC 6.4): the wiki as
 * a tree, facts grouped by node instead of by timestamp, a capped graph and
 * per fact provenance.
 *
 * Everything here is derived from stored data:
 *   - nodes come from the files under `<memoryDir>/wiki` (directories, file
 *     names, the first `# ` heading and the frontmatter `aliases`),
 *   - parent/child edges come from directory nesting and from markdown links
 *     between wiki pages,
 *   - facts are attached to a node by matching a page term (name, title or
 *     alias) against the fact text, by the majority node of their strand or,
 *     last, by the nearest wiki page embedding above a cosine floor,
 *   - origin comes from `memories.session_id` joined to `sessions`.
 *
 * No taxonomy is invented. When the wiki has no hub pages and no
 * subdirectories, the tree is flat and says so in `notes`.
 */
import fs from 'node:fs'
import type { Database } from './database.js'
import { CONFLICT_SCAN_MAX, detectFactConflicts } from './memory-conflicts.js'
import type { ConflictLink } from './memory-conflicts.js'
import { loadMemoryEmbeddingSettings } from './memory-embeddings.js'
import {
  EMBEDDING_FACT_SCORE_MARGIN,
  loadFactPageMatches,
  loadStrandPageMatches,
  pagesSignature,
  wikiPageFingerprints,
} from './memory-page-embeddings.js'
import type { FactPageMatch } from './memory-page-embeddings.js'
import {
  WIKI_MAX_DEPTH,
  WIKI_MAX_PAGES,
  folderIdFor,
  humanize,
  listWikiFiles,
  scanWikiPages,
  wikiDirFor,
} from './wiki-scan.js'
import type { WikiPageEntry } from './wiki-scan.js'

export { WIKI_MAX_DEPTH, WIKI_MAX_PAGES, scanWikiPages }
export type { WikiPageEntry }

/** A page needs this many outgoing wiki links before it may adopt children. */
export const HUB_MIN_OUTGOING_LINKS = 3
/** Default and maximum node count of one graph response. */
export const GRAPH_DEFAULT_NODES = 120
export const GRAPH_MAX_NODES = 300
/** Default and maximum page size of the node fact list. */
export const FACTS_DEFAULT_LIMIT = 50
export const FACTS_MAX_LIMIT = 200

export const UNASSIGNED_NODE_ID = 'bucket:unassigned'

export type MemoryNodeType = 'page' | 'folder' | 'bucket'

export interface MemoryViewScope {
  memoryDir?: string
  /**
   * Facts of this user plus facts without a user. `null` means no user filter
   * at all (used for admins, who already see every fact in the legacy list).
   */
  userId: number | null
  /** Persona filter: `agent_id IN (agentId, 'shared')`. Omitted means all. */
  agentId?: string
  /**
   * Cosine floor for the semantic fallback. Defaults to
   * `memoryEmbeddings.assignMinScore` from settings.json, then to
   * `EMBEDDING_ASSIGN_MIN_SCORE`.
   */
  embeddingMinScore?: number
}

export interface MemoryViewFact {
  id: number
  content: string
  userId: number | null
  agentId: string | null
  source: string
  provenance: string
  status: 'active' | 'superseded'
  sessionKind: string | null
  observedAt: string | null
  supersessionKey: string | null
  supersededBy: number | null
  createdAt: string
  strandId: string | null
  strandTitle: string | null
  nodeId: string
  /** How the fact reached its node. */
  matchedBy: 'term' | 'strand_majority' | 'embedding' | 'none'
  matchedTerm: string | null
  /** Cosine of the fact against its page vector, only for `embedding`. */
  embeddingScore: number | null
  /** Cosine of the strand centroid against the same page. */
  embeddingStrandScore: number | null
  conflict: boolean
  conflictWith: ConflictLink[]
}

export interface MemoryTreeNode {
  id: string
  type: MemoryNodeType
  title: string
  path: string | null
  aliases: string[]
  factCount: number
  subtreeFactCount: number
  conflictCount: number
  linksOut: number
  linksIn: number
  updatedAt: string | null
  children: MemoryTreeNode[]
}

export interface MemoryTreeResponse {
  generatedAt: string
  totals: {
    nodes: number
    pages: number
    folders: number
    facts: number
    assignedFacts: number
    unassignedFacts: number
    conflicts: number
    /** Additive: how the assigned facts reached their node. */
    byTerm: number
    byStrandMajority: number
    byEmbedding: number
  }
  limits: {
    hubMinOutgoingLinks: number
    conflictScanPerNode: number
    wikiMaxPages: number
    embeddingMinScore: number
    embeddedPages: number
  }
  notes: string[]
  nodes: MemoryTreeNode[]
}

interface MatchTerm {
  term: string
  firstToken: string
  nodeId: string
}

export interface MemoryViewIndex {
  signature: string
  generatedAt: string
  pages: WikiPageEntry[]
  nodes: Map<string, MemoryTreeNode>
  roots: string[]
  parentOf: Map<string, string | null>
  factsByNode: Map<string, MemoryViewFact[]>
  factById: Map<number, MemoryViewFact>
  strandFactsByNode: Map<string, Map<string, number>>
  strandTitles: Map<string, string>
  notes: string[]
  totalFacts: number
  unassignedFacts: number
  conflictCount: number
  matchedByCounts: Record<MemoryViewFact['matchedBy'], number>
  embeddingMinScore: number
  embeddedPages: number
}

interface FactRow {
  id: number
  user_id: number | null
  session_id: string | null
  content: string
  source: string
  timestamp: string
  agent_id: string | null
  provenance: string | null
  session_kind: string | null
  observed_at: string | null
  supersession_key: string | null
  status: string | null
  superseded_by: number | null
  strand_title: string | null
}

function foldDiacritics(text: string): string {
  return text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
}

/** Lowercase, diacritics folded, punctuation to single spaces, padded. */
export function normalizeForMatch(text: string): string {
  return ` ${foldDiacritics(text.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()} `
}

function buildMatchTerms(pages: WikiPageEntry[]): Map<string, MatchTerm[]> {
  const byFirstToken = new Map<string, MatchTerm[]>()
  const seen = new Set<string>()
  for (const page of pages) {
    const raw = [humanize(page.name), page.title, ...page.aliases]
    for (const candidate of raw) {
      const normalized = normalizeForMatch(candidate).trim()
      if (normalized.length < 3) continue
      if (!/\p{L}/u.test(normalized)) continue
      const key = `${page.id}|${normalized}`
      if (seen.has(key)) continue
      seen.add(key)
      const firstToken = normalized.split(' ')[0]
      const term: MatchTerm = { term: normalized, firstToken, nodeId: page.id }
      const list = byFirstToken.get(firstToken)
      if (list) list.push(term)
      else byFirstToken.set(firstToken, [term])
    }
  }
  for (const list of byFirstToken.values()) {
    list.sort((a, b) => (b.term.length - a.term.length) || a.nodeId.localeCompare(b.nodeId))
  }
  return byFirstToken
}

/** A strand must have this many term matches on one node before it adopts its unmatched facts. */
export const STRAND_MAJORITY_MIN_MATCHES = 2
/** ...and it must have at least this factor more matches than the runner up. */
const STRAND_MAJORITY_FACTOR = 2

/**
 * Facts extracted from one strand are usually about the same subject, but
 * most of them never name it ("the garage is 7.48 m wide" belongs to a house
 * page it does not mention). When a clear majority of the term matched facts
 * of a strand points at one node, the unmatched facts of that strand inherit
 * it. Deterministic: ties never win, and the node id breaks equal counts.
 */
function strandMajorityNodes(
  rows: readonly FactRow[],
  matchedTermByFactId: ReadonlyMap<number, MatchTerm>,
): Map<string, string> {
  const perStrand = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const matched = matchedTermByFactId.get(row.id)
    if (!matched || !row.session_id) continue
    let counts = perStrand.get(row.session_id)
    if (!counts) {
      counts = new Map<string, number>()
      perStrand.set(row.session_id, counts)
    }
    counts.set(matched.nodeId, (counts.get(matched.nodeId) ?? 0) + 1)
  }

  const majority = new Map<string, string>()
  for (const [strandId, counts] of perStrand) {
    const sorted = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    const [topNode, topCount] = sorted[0]
    const runnerUp = sorted[1]?.[1] ?? 0
    if (topCount < STRAND_MAJORITY_MIN_MATCHES) continue
    if (topCount < STRAND_MAJORITY_FACTOR * runnerUp) continue
    majority.set(strandId, topNode)
  }
  return majority
}

function factScopeClause(scope: MemoryViewScope): { where: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []
  if (scope.userId !== null) {
    conditions.push('(m.user_id = ? OR m.user_id IS NULL)')
    params.push(scope.userId)
  }
  if (scope.agentId) {
    conditions.push("m.agent_id IN (?, 'shared')")
    params.push(scope.agentId)
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

interface EmbeddingContext {
  model: string
  signature: string
  minScore: number
}

function embeddingContext(scope: MemoryViewScope): EmbeddingContext {
  const settings = loadMemoryEmbeddingSettings()
  return {
    model: settings.model,
    signature: pagesSignature(wikiPageFingerprints(scope.memoryDir), settings.model),
    minScore: scope.embeddingMinScore ?? settings.assignMinScore,
  }
}

function countEmbeddedPages(db: Database, model: string): number {
  try {
    return (db.prepare(
      'SELECT COUNT(*) AS count FROM wiki_page_embeddings WHERE model = ?',
    ).get(model) as { count: number }).count
  } catch {
    return 0
  }
}

/** Number of fact rows matched against the current page set, 0 when absent. */
function matchedFactCount(db: Database, signature: string): number {
  try {
    return (db.prepare(
      'SELECT COUNT(*) AS count FROM memory_page_matches WHERE pages_signature = ?',
    ).get(signature) as { count: number }).count
  } catch {
    return 0
  }
}

/**
 * Cheap fingerprint of everything the index depends on. Used to reuse a built
 * index without rescanning the wiki and re-running conflict detection. The
 * page signature and the match count are part of it so a finished background
 * embedding refresh invalidates the cached index.
 */
export function memoryViewSignature(db: Database, scope: MemoryViewScope): string {
  const { where, params } = factScopeClause(scope)
  const row = db.prepare(
    `SELECT COUNT(*) AS count, COALESCE(MAX(m.id), 0) AS maxId, COALESCE(MAX(m.timestamp), '') AS maxTs,
            COALESCE(SUM(CASE WHEN m.status = 'superseded' THEN 1 ELSE 0 END), 0) AS superseded
     FROM memories m ${where}`,
  ).get(...params) as { count: number; maxId: number; maxTs: string; superseded: number }

  const wikiDir = wikiDirFor(scope.memoryDir)
  let wikiCount = 0
  let wikiMtime = 0
  for (const file of listWikiFiles(wikiDir)) {
    try {
      const stats = fs.statSync(file)
      wikiCount += 1
      wikiMtime = Math.max(wikiMtime, stats.mtimeMs)
    } catch {
      continue
    }
  }

  const embedding = embeddingContext(scope)
  return [
    scope.userId ?? 'all',
    scope.agentId ?? 'all',
    row.count,
    row.maxId,
    row.maxTs,
    row.superseded,
    wikiCount,
    Math.round(wikiMtime),
    embedding.signature,
    embedding.minScore,
    matchedFactCount(db, embedding.signature),
  ].join(':')
}

function emptyNode(id: string, type: MemoryNodeType, title: string, page?: WikiPageEntry): MemoryTreeNode {
  return {
    id,
    type,
    title,
    path: page ? `wiki/${page.relPath}` : null,
    aliases: page ? page.aliases : [],
    factCount: 0,
    subtreeFactCount: 0,
    conflictCount: 0,
    linksOut: page ? page.linksOut.length : 0,
    linksIn: 0,
    updatedAt: page ? page.modifiedAt : null,
    children: [],
  }
}

export function buildMemoryViewIndex(db: Database, scope: MemoryViewScope): MemoryViewIndex {
  const signature = memoryViewSignature(db, scope)
  const pages = scanWikiPages(scope.memoryDir)
  const nodes = new Map<string, MemoryTreeNode>()
  const parentOf = new Map<string, string | null>()
  const notes: string[] = []

  const pageById = new Map<string, WikiPageEntry>()
  const pageByRelPath = new Map<string, WikiPageEntry>()
  for (const page of pages) {
    pageById.set(page.id, page)
    pageByRelPath.set(page.relPath, page)
    nodes.set(page.id, emptyNode(page.id, 'page', page.title, page))
  }

  for (const page of pages) {
    for (const target of page.linksOut) {
      const targetPage = pageByRelPath.get(target)
      if (!targetPage) continue
      const node = nodes.get(targetPage.id)
      if (node) node.linksIn += 1
    }
  }

  for (const page of pages) {
    if (!page.dir) continue
    const folderId = folderIdFor(page.dir)
    if (!nodes.has(folderId)) {
      nodes.set(folderId, emptyNode(folderId, 'folder', humanize(page.dir.split('/').pop() ?? page.dir)))
      nodes.get(folderId)!.path = `wiki/${page.dir}`
      parentOf.set(folderId, null)
    }
    parentOf.set(page.id, folderId)
  }

  const hubIds = new Set(
    pages
      .filter(page => !page.dir && page.linksOut.length >= HUB_MIN_OUTGOING_LINKS)
      .map(page => page.id),
  )

  for (const page of pages) {
    if (parentOf.has(page.id)) continue
    if (hubIds.has(page.id)) {
      parentOf.set(page.id, null)
      continue
    }
    let best: WikiPageEntry | null = null
    for (const hubId of hubIds) {
      const hub = pageById.get(hubId)
      if (!hub || !hub.linksOut.includes(page.relPath)) continue
      if (
        !best
        || hub.linksOut.length < best.linksOut.length
        || (hub.linksOut.length === best.linksOut.length && hub.id.localeCompare(best.id) < 0)
      ) {
        best = hub
      }
    }
    parentOf.set(page.id, best ? best.id : null)
  }

  const unassigned = emptyNode(UNASSIGNED_NODE_ID, 'bucket', 'Unassigned facts')
  nodes.set(UNASSIGNED_NODE_ID, unassigned)
  parentOf.set(UNASSIGNED_NODE_ID, null)

  const termsByFirstToken = buildMatchTerms(pages)
  const { where, params } = factScopeClause(scope)
  const matchedTermByFactId = new Map<number, MatchTerm>()
  const rows = db.prepare(
    `SELECT m.id, m.user_id, m.session_id, m.content, m.source, m.timestamp, m.agent_id, m.provenance,
            m.session_kind, m.observed_at, m.supersession_key, m.status, m.superseded_by,
            s.title AS strand_title
     FROM memories m
     LEFT JOIN sessions s ON s.id = m.session_id
     ${where}
     ORDER BY m.timestamp DESC, m.id DESC`,
  ).all(...params) as FactRow[]

  const factsByNode = new Map<string, MemoryViewFact[]>()
  const factById = new Map<number, MemoryViewFact>()
  const strandFactsByNode = new Map<string, Map<string, number>>()
  const strandTitles = new Map<string, string>()
  let unassignedFacts = 0

  for (const row of rows) {
    const normalized = normalizeForMatch(row.content)
    const tokens = normalized.trim().split(' ')
    let matched: MatchTerm | null = null
    for (const token of tokens) {
      const candidates = termsByFirstToken.get(token)
      if (!candidates) continue
      for (const candidate of candidates) {
        if (!normalized.includes(` ${candidate.term} `)) continue
        if (
          !matched
          || candidate.term.length > matched.term.length
          || (candidate.term.length === matched.term.length && candidate.nodeId.localeCompare(matched.nodeId) < 0)
        ) {
          matched = candidate
        }
      }
    }
    if (matched) matchedTermByFactId.set(row.id, matched)
  }

  const strandNodeId = strandMajorityNodes(rows, matchedTermByFactId)
  const embedding = embeddingContext(scope)
  const pageMatches = loadFactPageMatches(db, embedding.signature)
  const strandMatches = loadStrandPageMatches(db, embedding.signature)
  const factMinScore = Math.max(0, embedding.minScore - EMBEDDING_FACT_SCORE_MARGIN)
  const matchedByCounts: Record<MemoryViewFact['matchedBy'], number> = {
    term: 0,
    strand_majority: 0,
    embedding: 0,
    none: 0,
  }

  /**
   * A single fact is a weak query, so the semantic rule only fires when the
   * centroid of its strand lands on the same page above the floor. Calibration
   * on the live store: agreement roughly triples coverage at equal precision
   * compared to trusting the per fact nearest neighbour alone.
   */
  const semanticMatch = (row: FactRow): { page: FactPageMatch; strandScore: number } | null => {
    if (!row.session_id) return null
    const factMatch = pageMatches.get(row.id)
    const strandMatch = strandMatches.get(row.session_id)
    if (!factMatch || !strandMatch) return null
    if (factMatch.nodeId !== strandMatch.nodeId) return null
    if (strandMatch.score < embedding.minScore || factMatch.score < factMinScore) return null
    if (!nodes.has(factMatch.nodeId)) return null
    return { page: factMatch, strandScore: strandMatch.score }
  }

  for (const row of rows) {
    const matched = matchedTermByFactId.get(row.id) ?? null
    const inherited = matched ? null : (row.session_id ? strandNodeId.get(row.session_id) ?? null : null)
    const semantic = (!matched && !inherited) ? semanticMatch(row) : null
    const nodeId = matched ? matched.nodeId : (inherited ?? semantic?.page.nodeId ?? UNASSIGNED_NODE_ID)
    if (!matched && !inherited && !semantic) unassignedFacts += 1
    const matchedBy: MemoryViewFact['matchedBy'] = matched
      ? 'term'
      : (inherited ? 'strand_majority' : (semantic ? 'embedding' : 'none'))
    matchedByCounts[matchedBy] += 1

    const fact: MemoryViewFact = {
      id: row.id,
      content: row.content,
      userId: row.user_id,
      agentId: row.agent_id,
      source: row.source,
      provenance: row.provenance ?? 'agent',
      status: row.status === 'superseded' ? 'superseded' : 'active',
      sessionKind: row.session_kind,
      observedAt: row.observed_at,
      supersessionKey: row.supersession_key,
      supersededBy: row.superseded_by,
      createdAt: row.timestamp,
      strandId: row.session_id,
      strandTitle: row.strand_title,
      nodeId,
      matchedBy,
      matchedTerm: matched ? matched.term.trim() : null,
      embeddingScore: semantic ? Number(semantic.page.score.toFixed(4)) : null,
      embeddingStrandScore: semantic ? Number(semantic.strandScore.toFixed(4)) : null,
      conflict: false,
      conflictWith: [],
    }

    factById.set(fact.id, fact)
    const list = factsByNode.get(nodeId)
    if (list) list.push(fact)
    else factsByNode.set(nodeId, [fact])

    if (row.session_id) {
      if (row.strand_title) strandTitles.set(row.session_id, row.strand_title)
      let perStrand = strandFactsByNode.get(nodeId)
      if (!perStrand) {
        perStrand = new Map<string, number>()
        strandFactsByNode.set(nodeId, perStrand)
      }
      perStrand.set(row.session_id, (perStrand.get(row.session_id) ?? 0) + 1)
    }
  }

  let conflictCount = 0
  for (const [nodeId, facts] of factsByNode) {
    const links = detectFactConflicts(facts, { maxScan: CONFLICT_SCAN_MAX })
    if (links.size === 0) continue
    for (const fact of facts) {
      const link = links.get(fact.id)
      if (!link) continue
      fact.conflict = true
      fact.conflictWith = link
    }
    const node = nodes.get(nodeId)
    if (node) node.conflictCount = links.size
    conflictCount += links.size
  }

  for (const [nodeId, facts] of factsByNode) {
    const node = nodes.get(nodeId)
    if (!node) continue
    node.factCount = facts.filter(fact => fact.status === 'active').length
  }

  if (pages.length === 0) {
    notes.push('No wiki pages found: the tree only contains the unassigned bucket.')
  } else if (hubIds.size === 0 && !pages.some(page => page.dir)) {
    notes.push('The wiki has no hub pages and no subdirectories, so the tree is flat by construction.')
  }
  if (pages.length >= WIKI_MAX_PAGES) {
    notes.push(`Wiki scan stopped at ${WIKI_MAX_PAGES} pages.`)
  }
  notes.push(`Conflict detection compares at most ${CONFLICT_SCAN_MAX} facts per node, newest first.`)
  const embeddedPages = countEmbeddedPages(db, embedding.model)
  if (matchedByCounts.embedding > 0) {
    notes.push(
      `${matchedByCounts.embedding} facts reached their page by embedding similarity: their strand centroid `
      + `scored at least ${embedding.minScore} on that page and the fact itself at least `
      + `${Number(factMinScore.toFixed(2))}.`,
    )
  } else if (pages.length > 0 && embeddedPages === 0) {
    notes.push('No wiki page embeddings are stored, so the semantic rule is inactive.')
  } else if (pages.length > 0 && pageMatches.size === 0) {
    notes.push('Wiki pages are embedded but no fact has been matched against them yet, so the semantic rule stays inactive until the background refresh finishes.')
  }
  if (unassignedFacts > 0 && rows.length > 0) {
    const share = Math.round((unassignedFacts / rows.length) * 100)
    notes.push(`${share}% of the facts name no wiki page, have no strand with a clear node and no page vector above the similarity floor, so they stay in the unassigned bucket.`)
  }

  return {
    signature,
    generatedAt: new Date().toISOString(),
    pages,
    nodes,
    roots: [],
    parentOf,
    factsByNode,
    factById,
    strandFactsByNode,
    strandTitles,
    notes,
    totalFacts: rows.length,
    unassignedFacts,
    conflictCount,
    matchedByCounts,
    embeddingMinScore: embedding.minScore,
    embeddedPages,
  }
}

function childrenOf(index: MemoryViewIndex): Map<string | null, string[]> {
  const byParent = new Map<string | null, string[]>()
  for (const [id, parent] of index.parentOf) {
    const list = byParent.get(parent)
    if (list) list.push(id)
    else byParent.set(parent, [id])
  }
  const typeRank: Record<MemoryNodeType, number> = { folder: 0, page: 1, bucket: 2 }
  for (const list of byParent.values()) {
    list.sort((a, b) => {
      const na = index.nodes.get(a)
      const nb = index.nodes.get(b)
      const rankDiff = typeRank[na?.type ?? 'page'] - typeRank[nb?.type ?? 'page']
      if (rankDiff !== 0) return rankDiff
      return (na?.title ?? a).localeCompare(nb?.title ?? b) || a.localeCompare(b)
    })
  }
  return byParent
}

function matchesQuery(node: MemoryTreeNode, query: string): boolean {
  if (!query) return true
  const haystack = normalizeForMatch([node.title, node.path ?? '', ...node.aliases].join(' '))
  return haystack.includes(normalizeForMatch(query).trim())
}

export interface BuildTreeOptions {
  /** Case insensitive filter on title, path and aliases. Parents are kept. */
  query?: string
  /** Drop nodes (and subtrees) without facts. */
  onlyWithFacts?: boolean
}

export function buildMemoryTree(index: MemoryViewIndex, options: BuildTreeOptions = {}): MemoryTreeResponse {
  const byParent = childrenOf(index)
  const query = options.query?.trim() ?? ''

  const render = (id: string, inheritedMatch: boolean): MemoryTreeNode | null => {
    const base = index.nodes.get(id)
    if (!base) return null
    const selfMatches = inheritedMatch || matchesQuery(base, query)
    const children = (byParent.get(id) ?? [])
      .map(childId => render(childId, selfMatches))
      .filter((child): child is MemoryTreeNode => child !== null)
    const subtreeFactCount = base.factCount + children.reduce((sum, child) => sum + child.subtreeFactCount, 0)
    if (!selfMatches && children.length === 0) return null
    if (options.onlyWithFacts && subtreeFactCount === 0) return null
    return { ...base, children, subtreeFactCount }
  }

  const rendered = (byParent.get(null) ?? [])
    .map(id => render(id, false))
    .filter((node): node is MemoryTreeNode => node !== null)

  const countNodes = (list: MemoryTreeNode[]): number =>
    list.reduce((sum, node) => sum + 1 + countNodes(node.children), 0)

  const pages = index.pages.length
  const folders = [...index.nodes.values()].filter(node => node.type === 'folder').length
  const assignedFacts = index.totalFacts - index.unassignedFacts

  return {
    generatedAt: index.generatedAt,
    totals: {
      nodes: countNodes(rendered),
      pages,
      folders,
      facts: index.totalFacts,
      assignedFacts,
      unassignedFacts: index.unassignedFacts,
      conflicts: index.conflictCount,
      byTerm: index.matchedByCounts.term,
      byStrandMajority: index.matchedByCounts.strand_majority,
      byEmbedding: index.matchedByCounts.embedding,
    },
    limits: {
      hubMinOutgoingLinks: HUB_MIN_OUTGOING_LINKS,
      conflictScanPerNode: CONFLICT_SCAN_MAX,
      wikiMaxPages: WIKI_MAX_PAGES,
      embeddingMinScore: index.embeddingMinScore,
      embeddedPages: index.embeddedPages,
    },
    notes: index.notes,
    nodes: rendered,
  }
}

export interface NodeFactsOptions {
  limit?: number
  /** Opaque cursor from a previous page. */
  cursor?: string | null
  includeSuperseded?: boolean
  query?: string
}

export interface NodeFactsResult {
  node: { id: string; type: MemoryNodeType; title: string; path: string | null }
  facts: MemoryViewFact[]
  total: number
  limit: number
  nextCursor: string | null
  conflictScanLimit: number
}

export function encodeFactCursor(fact: MemoryViewFact): string {
  return Buffer.from(`${fact.createdAt}|${fact.id}`, 'utf-8').toString('base64url')
}

function decodeFactCursor(cursor: string): { createdAt: string; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf-8')
    const separator = decoded.lastIndexOf('|')
    if (separator < 0) return null
    const id = Number.parseInt(decoded.slice(separator + 1), 10)
    if (!Number.isFinite(id)) return null
    return { createdAt: decoded.slice(0, separator), id }
  } catch {
    return null
  }
}

export class UnknownMemoryNodeError extends Error {}
export class InvalidMemoryCursorError extends Error {}

export function listNodeFacts(
  index: MemoryViewIndex,
  nodeId: string,
  options: NodeFactsOptions = {},
): NodeFactsResult {
  const node = index.nodes.get(nodeId)
  if (!node) throw new UnknownMemoryNodeError(`Unknown node: ${nodeId}`)

  const limit = Math.min(FACTS_MAX_LIMIT, Math.max(1, Math.floor(options.limit ?? FACTS_DEFAULT_LIMIT)))
  const query = options.query?.trim() ? normalizeForMatch(options.query).trim() : ''
  const all = (index.factsByNode.get(nodeId) ?? []).filter(fact => {
    if (!options.includeSuperseded && fact.status !== 'active') return false
    if (query && !normalizeForMatch(fact.content).includes(query)) return false
    return true
  })

  let startIndex = 0
  if (options.cursor) {
    const decoded = decodeFactCursor(options.cursor)
    if (!decoded) throw new InvalidMemoryCursorError('Malformed cursor')
    const position = all.findIndex(fact => fact.id === decoded.id)
    if (position < 0) throw new InvalidMemoryCursorError('Cursor does not point into this node')
    startIndex = position + 1
  }

  const page = all.slice(startIndex, startIndex + limit)
  const nextCursor = startIndex + limit < all.length && page.length > 0
    ? encodeFactCursor(page[page.length - 1])
    : null

  return {
    node: { id: node.id, type: node.type, title: node.title, path: node.path },
    facts: page,
    total: all.length,
    limit,
    nextCursor,
    conflictScanLimit: CONFLICT_SCAN_MAX,
  }
}

export type MemoryGraphNodeType = MemoryNodeType | 'strand'
export type MemoryGraphEdgeType = 'contains' | 'wiki_link' | 'fact_origin'

export interface MemoryGraphNode {
  id: string
  type: MemoryGraphNodeType
  title: string
  factCount: number
  conflictCount: number
  depth: number
}

export interface MemoryGraphEdge {
  from: string
  to: string
  type: MemoryGraphEdgeType
  weight: number
}

export interface MemoryGraphResult {
  root: string | null
  depth: number
  nodeLimit: number
  truncated: boolean
  nodes: MemoryGraphNode[]
  edges: MemoryGraphEdge[]
}

export interface GraphOptions {
  root?: string | null
  depth?: number
  limit?: number
}

interface Neighbour {
  id: string
  type: MemoryGraphEdgeType
  weight: number
  directed: 'out' | 'in'
}

function buildAdjacency(index: MemoryViewIndex): Map<string, Neighbour[]> {
  const adjacency = new Map<string, Neighbour[]>()
  const add = (from: string, to: string, type: MemoryGraphEdgeType, weight: number): void => {
    const listFrom = adjacency.get(from)
    const entryOut: Neighbour = { id: to, type, weight, directed: 'out' }
    if (listFrom) listFrom.push(entryOut)
    else adjacency.set(from, [entryOut])
    const listTo = adjacency.get(to)
    const entryIn: Neighbour = { id: from, type, weight, directed: 'in' }
    if (listTo) listTo.push(entryIn)
    else adjacency.set(to, [entryIn])
  }

  for (const [id, parent] of index.parentOf) {
    if (!parent) continue
    const parentNode = index.nodes.get(parent)
    if (parentNode?.type === 'folder') add(parent, id, 'contains', 1)
  }

  const byRelPath = new Map(index.pages.map(page => [page.relPath, page]))
  for (const page of index.pages) {
    for (const target of page.linksOut) {
      const targetPage = byRelPath.get(target)
      if (targetPage) add(page.id, targetPage.id, 'wiki_link', 1)
    }
  }

  for (const [nodeId, strands] of index.strandFactsByNode) {
    for (const [strandId, count] of strands) {
      add(`strand:${strandId}`, nodeId, 'fact_origin', count)
    }
  }

  for (const list of adjacency.values()) {
    list.sort((a, b) => (b.weight - a.weight) || a.id.localeCompare(b.id))
  }
  return adjacency
}

function graphNodeFor(index: MemoryViewIndex, id: string, depth: number): MemoryGraphNode | null {
  if (id.startsWith('strand:')) {
    const strandId = id.slice('strand:'.length)
    let factCount = 0
    for (const strands of index.strandFactsByNode.values()) {
      factCount += strands.get(strandId) ?? 0
    }
    if (factCount === 0) return null
    return {
      id,
      type: 'strand',
      title: index.strandTitles.get(strandId) ?? 'Untitled strand',
      factCount,
      conflictCount: 0,
      depth,
    }
  }
  const node = index.nodes.get(id)
  if (!node) return null
  return {
    id,
    type: node.type,
    title: node.title,
    factCount: node.factCount,
    conflictCount: node.conflictCount,
    depth,
  }
}

export function buildMemoryGraph(index: MemoryViewIndex, options: GraphOptions = {}): MemoryGraphResult {
  const depth = Math.min(2, Math.max(1, Math.floor(options.depth ?? 1)))
  const nodeLimit = Math.min(GRAPH_MAX_NODES, Math.max(1, Math.floor(options.limit ?? GRAPH_DEFAULT_NODES)))
  const root = options.root?.trim() ? options.root.trim() : null
  if (root && !index.nodes.has(root) && !root.startsWith('strand:')) {
    throw new UnknownMemoryNodeError(`Unknown node: ${root}`)
  }

  const adjacency = buildAdjacency(index)
  const seeds = root
    ? [root]
    : [...index.parentOf.entries()]
      .filter(([, parent]) => parent === null)
      .map(([id]) => id)
      .sort((a, b) => {
        const na = index.nodes.get(a)
        const nb = index.nodes.get(b)
        return (nb?.factCount ?? 0) - (na?.factCount ?? 0) || a.localeCompare(b)
      })

  const nodes = new Map<string, MemoryGraphNode>()
  const queue: Array<{ id: string; depth: number }> = []
  let truncated = false

  for (const seed of seeds) {
    const node = graphNodeFor(index, seed, 0)
    if (!node) continue
    if (nodes.size >= nodeLimit) {
      truncated = true
      break
    }
    nodes.set(seed, node)
    queue.push({ id: seed, depth: 0 })
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth >= depth) continue
    for (const neighbour of adjacency.get(current.id) ?? []) {
      if (nodes.has(neighbour.id)) continue
      if (nodes.size >= nodeLimit) {
        truncated = true
        break
      }
      const node = graphNodeFor(index, neighbour.id, current.depth + 1)
      if (!node) continue
      nodes.set(neighbour.id, node)
      queue.push({ id: neighbour.id, depth: current.depth + 1 })
    }
    if (truncated) break
  }

  const edges: MemoryGraphEdge[] = []
  const seenEdges = new Set<string>()
  for (const id of nodes.keys()) {
    for (const neighbour of adjacency.get(id) ?? []) {
      if (!nodes.has(neighbour.id)) continue
      const from = neighbour.directed === 'out' ? id : neighbour.id
      const to = neighbour.directed === 'out' ? neighbour.id : id
      const key = `${from}|${to}|${neighbour.type}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push({ from, to, type: neighbour.type, weight: neighbour.weight })
    }
  }
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type))

  return {
    root,
    depth,
    nodeLimit,
    truncated,
    nodes: [...nodes.values()].sort((a, b) => a.depth - b.depth || b.factCount - a.factCount || a.id.localeCompare(b.id)),
    edges,
  }
}

export interface FactOrigin {
  strandId: string | null
  strandTitle: string | null
  strandType: string | null
  strandAgentId: string | null
  startedAt: string | null
  lastActivity: string | null
  archived: boolean | null
}

export interface FactHistoryEntry {
  id: number
  content: string
  status: 'active' | 'superseded'
  createdAt: string
  supersededBy: number | null
}

export interface FactDetail {
  fact: MemoryViewFact
  node: { id: string; type: MemoryNodeType; title: string; path: string | null } | null
  origin: FactOrigin
  supersedes: FactHistoryEntry[]
  supersededBy: FactHistoryEntry | null
  history: FactHistoryEntry[]
  conflicts: Array<{ id: number; reason: string; content: string }>
}

interface SessionRow {
  id: string
  title: string | null
  type: string | null
  agent_id: string | null
  started_at: string | null
  last_activity: string | null
  archived: number | null
}

interface HistoryRow {
  id: number
  content: string
  status: string | null
  timestamp: string
  superseded_by: number | null
}

function toHistoryEntry(row: HistoryRow): FactHistoryEntry {
  return {
    id: row.id,
    content: row.content,
    status: row.status === 'superseded' ? 'superseded' : 'active',
    createdAt: row.timestamp,
    supersededBy: row.superseded_by,
  }
}

const HISTORY_COLUMNS = 'id, content, status, timestamp, superseded_by'
const HISTORY_MAX_CHAIN = 20

export function getFactDetail(db: Database, index: MemoryViewIndex, factId: number): FactDetail | null {
  const fact = index.factById.get(factId)
  if (!fact) return null

  const node = index.nodes.get(fact.nodeId)
  let origin: FactOrigin = {
    strandId: fact.strandId,
    strandTitle: fact.strandTitle,
    strandType: null,
    strandAgentId: null,
    startedAt: null,
    lastActivity: null,
    archived: null,
  }
  if (fact.strandId) {
    const session = db.prepare(
      'SELECT id, title, type, agent_id, started_at, last_activity, archived FROM sessions WHERE id = ?',
    ).get(fact.strandId) as SessionRow | undefined
    if (session) {
      origin = {
        strandId: session.id,
        strandTitle: session.title,
        strandType: session.type,
        strandAgentId: session.agent_id,
        startedAt: session.started_at,
        lastActivity: session.last_activity,
        archived: session.archived === 1,
      }
    }
  }

  const supersedes = (db.prepare(
    `SELECT ${HISTORY_COLUMNS} FROM memories WHERE superseded_by = ? ORDER BY timestamp DESC, id DESC LIMIT ?`,
  ).all(factId, HISTORY_MAX_CHAIN) as HistoryRow[]).map(toHistoryEntry)

  let supersededBy: FactHistoryEntry | null = null
  if (fact.supersededBy !== null) {
    const row = db.prepare(`SELECT ${HISTORY_COLUMNS} FROM memories WHERE id = ?`).get(fact.supersededBy) as HistoryRow | undefined
    if (row) supersededBy = toHistoryEntry(row)
  }

  const history: FactHistoryEntry[] = []
  if (fact.supersessionKey) {
    const rows = db.prepare(
      `SELECT ${HISTORY_COLUMNS} FROM memories
       WHERE supersession_key = ? AND agent_id IS ? AND user_id IS ?
       ORDER BY timestamp ASC, id ASC LIMIT ?`,
    ).all(fact.supersessionKey, fact.agentId, fact.userId, HISTORY_MAX_CHAIN) as HistoryRow[]
    history.push(...rows.map(toHistoryEntry))
  } else {
    const self = db.prepare(`SELECT ${HISTORY_COLUMNS} FROM memories WHERE id = ?`).get(factId) as HistoryRow | undefined
    if (self) history.push(toHistoryEntry(self))
    for (const entry of supersedes) history.unshift(entry)
    if (supersededBy) history.push(supersededBy)
  }

  const conflicts = fact.conflictWith.map(link => ({
    id: link.id,
    reason: link.reason,
    content: index.factById.get(link.id)?.content ?? '',
  }))

  return {
    fact,
    node: node ? { id: node.id, type: node.type, title: node.title, path: node.path } : null,
    origin,
    supersedes,
    supersededBy,
    history,
    conflicts,
  }
}
