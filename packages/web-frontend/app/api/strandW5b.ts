/**
 * W5b endpoints: fork a strand at a message, message full text search, the
 * slim fact list and the recalled messages of the context report.
 *
 *   POST /api/strands/:id/fork   { messageId, title? } -> 201 { fork, strand }
 *   GET  /api/search?q=&limit=&cursor= -> { query, hits[], truncated, nextCursor }
 *   GET  /api/strands/:id/facts  -> { strandId, facts[], total, truncated, summaries, toolCalls }
 *   GET  /api/strands/:id/context -> ... recalled[] (additive)
 *
 * Every mapper is tolerant: unknown or malformed rows are dropped, never
 * rendered half.
 */
export const STRAND_FORK_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/fork`
export const STRAND_FACTS_PATH = (id: string) => `/api/strands/${encodeURIComponent(id)}/facts`
export const MESSAGE_SEARCH_PATH = '/api/search'
/** Minimum characters the server accepts for `q`. */
export const MESSAGE_SEARCH_MIN = 2
export const MESSAGE_SEARCH_MAX = 200

export interface ForkResult {
  strandId: string
  title: string
  parentStrandId: string
  forkedFromMessageId: number | null
}

export interface MessageHit {
  strandId: string
  strandTitle: string | null
  messageId: number
  role: 'user' | 'assistant'
  snippet: string
  /** [start, end) ranges into `snippet` that matched. */
  highlights: Array<[number, number]>
  timestamp: string | null
}

export interface RecalledMessage {
  messageId: number
  strandId: string
  role: string
  excerpt: string
  recalledAt: string | null
  source: 'recall' | 'context'
}

export interface StrandFact { id: number; text: string; createdAt: string | null; status: string }
export interface StrandFactsList { facts: StrandFact[]; total: number; truncated: boolean; summaries: number; toolCalls: number }

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

export function mapForkResult(raw: unknown): ForkResult | null {
  const fork = obj(obj(raw).fork)
  if (typeof fork.strandId !== 'string' || !fork.strandId) return null
  return {
    strandId: fork.strandId,
    title: typeof fork.title === 'string' ? fork.title : '',
    parentStrandId: typeof fork.parentStrandId === 'string' ? fork.parentStrandId : '',
    forkedFromMessageId: posInt(fork.forkedFromMessageId) ? fork.forkedFromMessageId : null,
  }
}

/** Highlight ranges are clamped to the snippet and sorted; overlapping or broken ones are dropped. */
function ranges(raw: unknown, length: number): Array<[number, number]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[number, number]> = []
  let last = 0
  for (const pair of raw) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [a, b] = pair
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue
    const start = Math.max(0, Math.min(a as number, length))
    const end = Math.max(0, Math.min(b as number, length))
    if (end <= start || start < last) continue
    out.push([start, end])
    last = end
  }
  return out
}

export function mapMessageHits(raw: unknown): MessageHit[] {
  const hits = obj(raw).hits
  if (!Array.isArray(hits)) return []
  return hits.flatMap((entry): MessageHit[] => {
    const hit = obj(entry)
    if (typeof hit.strandId !== 'string' || !posInt(hit.messageId) || typeof hit.snippet !== 'string') return []
    return [{
      strandId: hit.strandId,
      strandTitle: typeof hit.strandTitle === 'string' && hit.strandTitle.trim() ? hit.strandTitle : null,
      messageId: hit.messageId,
      role: hit.role === 'assistant' ? 'assistant' : 'user',
      snippet: hit.snippet,
      highlights: ranges(hit.highlights, hit.snippet.length),
      timestamp: typeof hit.timestamp === 'string' ? hit.timestamp : null,
    }]
  })
}

/** Snippet split into plain text parts; rendered with `{{ }}` only, never v-html. */
export function snippetParts(hit: Pick<MessageHit, 'snippet' | 'highlights'>): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = []
  let at = 0
  for (const [start, end] of hit.highlights) {
    if (start > at) parts.push({ text: hit.snippet.slice(at, start), match: false })
    parts.push({ text: hit.snippet.slice(start, end), match: true })
    at = end
  }
  if (at < hit.snippet.length) parts.push({ text: hit.snippet.slice(at), match: false })
  return parts
}

export function mapRecalled(raw: unknown): RecalledMessage[] {
  const list = obj(raw).recalled
  if (!Array.isArray(list)) return []
  return list.flatMap((entry): RecalledMessage[] => {
    const row = obj(entry)
    if (!posInt(row.messageId) || typeof row.strandId !== 'string') return []
    return [{
      messageId: row.messageId,
      strandId: row.strandId,
      role: typeof row.role === 'string' ? row.role : 'user',
      excerpt: typeof row.excerpt === 'string' ? row.excerpt : '',
      recalledAt: typeof row.recalledAt === 'string' ? row.recalledAt : null,
      source: row.source === 'context' ? 'context' : 'recall',
    }]
  })
}

export function mapFacts(raw: unknown): StrandFactsList {
  const root = obj(raw)
  const facts = Array.isArray(root.facts)
    ? root.facts.flatMap((entry): StrandFact[] => {
      const f = obj(entry)
      if (!posInt(f.id) || typeof f.text !== 'string') return []
      return [{ id: f.id, text: f.text, createdAt: typeof f.createdAt === 'string' ? f.createdAt : null, status: typeof f.status === 'string' ? f.status : 'active' }]
    })
    : []
  return { facts, total: Math.max(count(root.total), facts.length), truncated: root.truncated === true, summaries: count(root.summaries), toolCalls: count(root.toolCalls) }
}

/** Route of a message inside its strand; the strand page scrolls to the anchor. */
export function messageRoute(strandId: string, messageId: number): string {
  return `/strands/${encodeURIComponent(strandId)}#msg-${messageId}`
}

/** Term sent to the message search, or null when it is too short to ask. */
export function messageSearchTerm(query: string): string | null {
  const term = query.replace(/\s+/g, ' ').trim().slice(0, MESSAGE_SEARCH_MAX)
  return term.length >= MESSAGE_SEARCH_MIN ? term : null
}

export function useStrandW5bApi() {
  const { apiFetch } = useApi()
  return {
    async fork(strandId: string, messageId: number, title?: string): Promise<ForkResult> {
      const raw = await apiFetch<unknown>(STRAND_FORK_PATH(strandId), {
        method: 'POST',
        body: JSON.stringify(title ? { messageId, title } : { messageId }),
      })
      const result = mapForkResult(raw)
      if (!result) throw new Error('Malformed fork answer')
      return result
    },
    /**
     * One page of message hits. `cursor` continues a previous answer (W6b);
     * `nextCursor` is `null` on the last page and on a server without paging.
     */
    async search(term: string, limit: number, signal?: AbortSignal, cursor?: string | null): Promise<{ hits: MessageHit[]; truncated: boolean; nextCursor: string | null }> {
      const params = new URLSearchParams({ q: term, limit: String(limit) })
      if (cursor) params.set('cursor', cursor)
      const raw = await apiFetch<unknown>(`${MESSAGE_SEARCH_PATH}?${params}`, { signal })
      const next = obj(raw).nextCursor
      return { hits: mapMessageHits(raw), truncated: obj(raw).truncated === true, nextCursor: typeof next === 'string' && next ? next : null }
    },
  }
}
