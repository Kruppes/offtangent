import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { searchMemories, getMemoryById } from './memories-store.js'
import type { MemoryFact } from './memories-store.js'
import { searchMemoriesByEmbedding } from './memory-embeddings.js'
import { resolveAgentReadScope } from './agent-read-scope.js'

/**
 * Hybrid retrieval: lexical FTS5 hits + semantic embedding hits merged via
 * Reciprocal Rank Fusion. Degrades to pure FTS when embeddings are disabled
 * or the endpoint is unreachable (semantic list is simply empty).
 */
async function searchMemoriesHybrid(
  db: Database,
  query: string,
  options: { userId?: number; limit: number; agentId?: string },
): Promise<{ facts: MemoryFact[]; semantic: boolean }> {
  // Overfetch both lists so fusion has material to work with.
  const poolSize = Math.min(options.limit * 3, 50)
  const ftsFacts = searchMemories(db, query, { userId: options.userId, limit: poolSize, agentId: options.agentId })

  let embeddingHits: Array<{ id: number }> = []
  try {
    embeddingHits = (await searchMemoriesByEmbedding(db, query, {
      userId: options.userId,
      limit: poolSize,
    })) ?? []
  } catch {
    // semantic path is strictly best-effort
  }

  if (embeddingHits.length === 0) {
    return { facts: ftsFacts.slice(0, options.limit), semantic: false }
  }

  // RRF: score(id) = Σ 1 / (60 + rank) over both rankings.
  const K = 60
  const scores = new Map<number, number>()
  ftsFacts.forEach((fact, rank) => scores.set(fact.id, (scores.get(fact.id) ?? 0) + 1 / (K + rank)))
  embeddingHits.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (K + rank)))

  const factById = new Map<number, MemoryFact>(ftsFacts.map((f) => [f.id, f]))
  const merged: MemoryFact[] = []
  for (const [id] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    const fact = factById.get(id) ?? getMemoryById(db, id) ?? undefined
    // Enforce the agent scope on embedding hits too: getMemoryById bypasses
    // the SQL agent filter, so a semantic match could otherwise leak another
    // persona's fact into a scoped search.
    if (fact && options.agentId !== undefined && fact.agentId !== null
      && fact.agentId !== options.agentId && fact.agentId !== 'shared') {
      continue
    }
    if (fact) merged.push(fact)
    if (merged.length >= options.limit) break
  }
  return { facts: merged, semantic: true }
}

export interface SearchMemoriesToolOptions {
  db: Database
  getCurrentUserId?: () => number | undefined
  /**
   * Supplies the persona (agentId) the calling runtime belongs to.
   * Non-'main' personas only see their own facts plus 'shared' facts;
   * 'main' (and legacy callers without this option) see everything.
   */
  getCurrentAgentId?: () => string | undefined
  /**
   * Injectable list of known persona ids (excludes 'main'), used to validate
   * the optional `agent` cross-persona read parameter. Defaults to the
   * on-disk personas. Injectable for tests.
   */
  listAgentIds?: () => string[]
}

export function createSearchMemoriesTool(options: SearchMemoriesToolOptions): AgentTool {
  return {
    name: 'search_memories',
    label: 'Search Memories',
    description:
      'Search the agent\'s fact memory for previously learned information. ' +
      'Returns atomic facts extracted from past conversations. ' +
      'Use this when the user asks about past decisions, preferences, or details discussed in earlier sessions. ' +
      'Plain queries match facts containing ANY of the keywords, ranked by relevance — ' +
      'so provide several related keywords (e.g. docker deployment server) rather than a full sentence. ' +
      'For strict matching, FTS5 syntax is supported: prefix queries (e.g. config*), ' +
      'quoted phrases (e.g. "postgres port"), and boolean operators (e.g. docker AND compose). ' +
      'By default you search your own persona\'s memory (plus shared facts). To read another ' +
      'persona\'s memory on demand — e.g. the user asks what was discussed with another persona, ' +
      'or you need to continue work started in another persona — pass the `agent` parameter with ' +
      'that persona\'s id (e.g. "main", "bob"), or "all" to search across every persona.',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query for finding relevant facts from memory.',
      }),
      limit: Type.Optional(
        Type.Number({
          description: 'Maximum number of facts to return (default: 10, max: 50).',
        }),
      ),
      agent: Type.Optional(
        Type.String({
          description:
            'Cross-persona read scope. Omit to search your own persona\'s memory (plus shared facts) — ' +
            'the default. Pass a persona id (e.g. "main", "bob") to search exactly that persona\'s memory ' +
            '(plus shared facts), or "all" to search across every persona. An unknown id returns an error.',
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { query, limit: rawLimit, agent: rawAgent } = params as { query?: string; limit?: number; agent?: string }

      if (typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: query must be a non-empty string.' }],
          details: { error: true },
        }
      }

      if (rawLimit !== undefined && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
        return {
          content: [{ type: 'text' as const, text: 'Error: limit must be a positive number.' }],
          details: { error: true },
        }
      }

      try {
        const limit = Math.min(Math.max(Math.floor(rawLimit ?? 10), 1), 50)
        const userId = options.getCurrentUserId?.()
        // Persona scoping: by default non-'main' personas only search their own
        // facts (+ 'shared'); 'main' stays unscoped. An explicit `agent` param
        // opts into cross-persona reads ('all' → unscoped; a concrete id → that
        // bucket + 'shared'). Unknown ids error out instead of returning [].
        const scope = resolveAgentReadScope({
          requested: rawAgent,
          callerAgentId: options.getCurrentAgentId?.(),
          listAgentIds: options.listAgentIds,
        })
        if (!scope.ok) {
          return {
            content: [{ type: 'text' as const, text: scope.error }],
            details: { error: true },
          }
        }
        const agentScope = scope.agentId
        const { facts, semantic } = await searchMemoriesHybrid(options.db, query, {
          userId,
          limit,
          agentId: agentScope,
        })

        if (facts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No memories found for query "${query}".` }],
            details: {
              count: 0,
              query,
              limit,
              userId,
            },
          }
        }

        const formatted = facts.map((fact, index) => {
          const header = `${index + 1}. [${fact.timestamp}] [${fact.source}]`
          const sessionLine = fact.sessionId ? `Session: ${fact.sessionId}\n` : ''
          return `${header}\n${sessionLine}${fact.content}`
        }).join('\n\n')

        return {
          content: [{ type: 'text' as const, text: formatted }],
          details: {
            count: facts.length,
            query,
            limit,
            userId,
            semantic,
            facts,
          },
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error searching memories: ${errorMessage}` }],
          details: { error: true },
        }
      }
    },
  }
}
