/**
 * Structured memory view (SPEC 6.4). The heavy lifting (wiki scan, fact to
 * node matching, conflict detection) lives in `@axiom/core`; this service
 * owns the request scope and a small index cache so a tree, a fact page and
 * a graph request in the same UI session do not rescan the wiki three times.
 */
import type { Database, MemoryViewIndex, MemoryViewScope } from '@axiom/core'
import {
  InvalidMemoryCursorError,
  UnknownMemoryNodeError,
  buildMemoryGraph,
  buildMemoryTree,
  buildMemoryViewIndex,
  getFactDetail,
  getMemoryDir,
  listNodeFacts,
  memoryPageIndexState,
  memoryViewSignature,
  refreshMemoryPageIndex,
} from '@axiom/core'
import type { GraphQuery, NodeFactsQuery, TreeQuery } from './schema.js'

export class MemoryViewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'MemoryViewError'
  }
}

export interface MemoryViewServiceOptions {
  db: Database
  /** Cached indices per scope. Small on purpose: one per persona scope. */
  maxCacheEntries?: number
  /** Minimum distance between two page embedding staleness probes. */
  pageIndexCheckIntervalMs?: number
  /** Tests and offline tools: never touch the embedding endpoint. */
  disableBackgroundRefresh?: boolean
}

interface CacheEntry {
  signature: string
  index: MemoryViewIndex
}

const DEFAULT_MAX_CACHE_ENTRIES = 6
/** How often a request may probe the page embedding index for staleness. */
const PAGE_INDEX_CHECK_INTERVAL_MS = 30000

export function createMemoryViewService(options: MemoryViewServiceOptions) {
  const cache = new Map<string, CacheEntry>()
  const maxEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES
  const checkInterval = options.pageIndexCheckIntervalMs ?? PAGE_INDEX_CHECK_INTERVAL_MS
  let pageIndexRefresh: Promise<void> | null = null
  let lastPageIndexCheck = 0

  /**
   * Page vectors and fact matches are rebuilt in the background: embedding a
   * changed wiki page is a network call and must never sit in a request. The
   * index signature includes the match state, so the next request after a
   * finished refresh rebuilds and picks the new assignments up.
   */
  function schedulePageIndexRefresh(memoryDir: string): void {
    if (options.disableBackgroundRefresh || pageIndexRefresh) return
    const now = Date.now()
    if (now - lastPageIndexCheck < checkInterval) return
    lastPageIndexCheck = now
    let stale = false
    try {
      const state = memoryPageIndexState(options.db, { memoryDir })
      stale = state.enabled && state.stale
    } catch (err) {
      console.warn('[memory-view] Page index probe failed:', (err as Error).message)
      return
    }
    if (!stale) return
    pageIndexRefresh = refreshMemoryPageIndex(options.db, { memoryDir })
      .then(result => {
        if (result.pages.embedded > 0 || result.matches.computed > 0) {
          console.log(
            `[memory-view] Page index refreshed: ${result.pages.embedded} pages embedded, `
            + `${result.matches.computed} facts matched in ${result.durationMs} ms`,
          )
        }
      })
      .catch(err => console.warn('[memory-view] Page index refresh failed:', (err as Error).message))
      .finally(() => { pageIndexRefresh = null })
  }

  function scopeFor(userId: number, isAdmin: boolean, agentId?: string): MemoryViewScope {
    return {
      memoryDir: getMemoryDir(),
      userId: isAdmin ? null : userId,
      ...(agentId ? { agentId } : {}),
    }
  }

  function indexFor(scope: MemoryViewScope): MemoryViewIndex {
    schedulePageIndexRefresh(scope.memoryDir ?? getMemoryDir())
    const key = `${scope.userId ?? 'all'}|${scope.agentId ?? 'all'}`
    const signature = memoryViewSignature(options.db, scope)
    const cached = cache.get(key)
    if (cached && cached.signature === signature) return cached.index
    const index = buildMemoryViewIndex(options.db, scope)
    cache.set(key, { signature: index.signature, index })
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return index
  }

  function mapError(err: unknown): never {
    if (err instanceof UnknownMemoryNodeError) throw new MemoryViewError(404, 'node_not_found', err.message)
    if (err instanceof InvalidMemoryCursorError) throw new MemoryViewError(400, 'invalid_cursor', err.message)
    throw err
  }

  return {
    tree(userId: number, isAdmin: boolean, query: TreeQuery) {
      const index = indexFor(scopeFor(userId, isAdmin, query.agentId))
      return buildMemoryTree(index, {
        ...(query.query ? { query: query.query } : {}),
        onlyWithFacts: query.onlyWithFacts,
      })
    },

    facts(userId: number, isAdmin: boolean, query: NodeFactsQuery) {
      const index = indexFor(scopeFor(userId, isAdmin, query.agentId))
      try {
        return listNodeFacts(index, query.node, {
          limit: query.limit,
          cursor: query.cursor ?? null,
          includeSuperseded: query.includeSuperseded,
          ...(query.query ? { query: query.query } : {}),
        })
      } catch (err) {
        mapError(err)
      }
    },

    graph(userId: number, isAdmin: boolean, query: GraphQuery) {
      const index = indexFor(scopeFor(userId, isAdmin, query.agentId))
      try {
        return buildMemoryGraph(index, {
          root: query.root ?? null,
          depth: query.depth,
          limit: query.limit,
        })
      } catch (err) {
        mapError(err)
      }
    },

    fact(userId: number, isAdmin: boolean, factId: number, agentId?: string) {
      const index = indexFor(scopeFor(userId, isAdmin, agentId))
      const detail = getFactDetail(options.db, index, factId)
      if (!detail) throw new MemoryViewError(404, 'fact_not_found', 'Fact not found')
      return detail
    },
  }
}

export type MemoryViewService = ReturnType<typeof createMemoryViewService>
