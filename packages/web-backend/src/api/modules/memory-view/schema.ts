import { FACTS_DEFAULT_LIMIT, FACTS_MAX_LIMIT, GRAPH_DEFAULT_NODES, GRAPH_MAX_NODES } from '@axiom/core'
import { resolveAgentId } from '../../../persona-request.js'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

function parseFlag(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes'
}

function parseAgent(raw: unknown): ParseResult<string | undefined> {
  if (raw === undefined || raw === '') return { ok: true, value: undefined }
  const agentId = resolveAgentId(raw)
  if (agentId === null) return { ok: false, error: 'Unknown agent_id', code: 'unknown_agent' }
  return { ok: true, value: agentId }
}

function parseString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

export interface TreeQuery {
  agentId?: string
  query?: string
  onlyWithFacts: boolean
}

export function parseTreeQuery(query: Record<string, unknown>): ParseResult<TreeQuery> {
  const agent = parseAgent(query.agent_id)
  if (!agent.ok) return agent
  return {
    ok: true,
    value: {
      ...(agent.value ? { agentId: agent.value } : {}),
      ...(parseString(query.q) ? { query: parseString(query.q) } : {}),
      onlyWithFacts: parseFlag(query.only_with_facts),
    },
  }
}

export interface NodeFactsQuery {
  node: string
  agentId?: string
  query?: string
  limit: number
  cursor?: string
  includeSuperseded: boolean
}

export function parseNodeFactsQuery(query: Record<string, unknown>): ParseResult<NodeFactsQuery> {
  const node = parseString(query.node)
  if (!node) return { ok: false, error: 'node is required', code: 'missing_node' }
  const agent = parseAgent(query.agent_id)
  if (!agent.ok) return agent
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10)
  const limit = Math.min(FACTS_MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : FACTS_DEFAULT_LIMIT))
  return {
    ok: true,
    value: {
      node,
      ...(agent.value ? { agentId: agent.value } : {}),
      ...(parseString(query.q) ? { query: parseString(query.q) } : {}),
      limit,
      ...(parseString(query.cursor) ? { cursor: parseString(query.cursor) } : {}),
      includeSuperseded: parseFlag(query.include_superseded),
    },
  }
}

export interface GraphQuery {
  root?: string
  agentId?: string
  depth: number
  limit: number
}

export function parseGraphQuery(query: Record<string, unknown>): ParseResult<GraphQuery> {
  const agent = parseAgent(query.agent_id)
  if (!agent.ok) return agent
  const rawDepth = Number.parseInt(String(query.depth ?? ''), 10)
  const depth = Math.min(2, Math.max(1, Number.isFinite(rawDepth) ? rawDepth : 1))
  const rawLimit = Number.parseInt(String(query.limit ?? ''), 10)
  const limit = Math.min(GRAPH_MAX_NODES, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : GRAPH_DEFAULT_NODES))
  return {
    ok: true,
    value: {
      ...(parseString(query.root) ? { root: parseString(query.root) } : {}),
      ...(agent.value ? { agentId: agent.value } : {}),
      depth,
      limit,
    },
  }
}

export interface FactDetailParams {
  id: number
  agentId?: string
}

export function parseFactDetailParams(id: unknown, query: Record<string, unknown>): ParseResult<FactDetailParams> {
  const parsed = Number.parseInt(String(id ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, error: 'Invalid fact id', code: 'invalid_fact_id' }
  const agent = parseAgent(query.agent_id)
  if (!agent.ok) return agent
  return { ok: true, value: { id: parsed, ...(agent.value ? { agentId: agent.value } : {}) } }
}
