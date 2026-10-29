import { loadConfig } from './config.js'
import type { Database } from './database.js'

/**
 * Semantic embeddings for the fact memory, served by an OpenAI-compatible
 * /v1/embeddings endpoint (typically a local Ollama, e.g. qwen3-embedding).
 *
 * Everything here is BEST-EFFORT: when disabled, unconfigured, or the
 * endpoint is down, every function degrades to a no-op / null and the
 * lexical FTS5 path keeps working unchanged.
 *
 * Config lives in settings.json:
 *   "memoryEmbeddings": {
 *     "enabled": true,
 *     "baseUrl": "http://<ollama-host>:11434/v1",
 *     "model": "qwen3-embedding:0.6b",
 *     "assignMinScore": 0.5
 *   }
 */
export interface MemoryEmbeddingSettings {
  enabled: boolean
  /** OpenAI-compatible base URL INCLUDING the /v1 suffix. */
  baseUrl: string
  model: string
  timeoutMs: number
  /** Cosine floor of the memory view semantic fact to page assignment. */
  assignMinScore: number
}

/**
 * Cosine floor for the semantic fact to wiki page assignment of the memory
 * view: the minimum similarity between a strand centroid and a wiki page.
 * Calibrated on a copy of the live fact store (4089 facts, 116 pages,
 * qwen3-embedding:4b). Override per instance with
 * `memoryEmbeddings.assignMinScore` in settings.json.
 */
export const EMBEDDING_ASSIGN_MIN_SCORE = 0.65
const DEFAULT_ASSIGN_MIN_SCORE = EMBEDDING_ASSIGN_MIN_SCORE

function normalizeAssignMinScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_ASSIGN_MIN_SCORE
  return Math.min(1, Math.max(0, raw))
}

export function loadMemoryEmbeddingSettings(): MemoryEmbeddingSettings {
  const disabled: MemoryEmbeddingSettings = {
    enabled: false,
    baseUrl: '',
    model: '',
    timeoutMs: 30000,
    assignMinScore: DEFAULT_ASSIGN_MIN_SCORE,
  }
  try {
    const settings = loadConfig<{ memoryEmbeddings?: Partial<MemoryEmbeddingSettings> }>('settings.json')
    const cfg = settings.memoryEmbeddings
    if (!cfg?.enabled || !cfg.baseUrl || !cfg.model) {
      return { ...disabled, assignMinScore: normalizeAssignMinScore(cfg?.assignMinScore) }
    }
    return {
      enabled: true,
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
      model: cfg.model,
      timeoutMs: cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 30000,
      assignMinScore: normalizeAssignMinScore(cfg.assignMinScore),
    }
  } catch {
    return disabled
  }
}

/** Upper bound of the error body that is read from the endpoint, in bytes. */
export const EMBEDDING_ERROR_BODY_MAX_BYTES = 4096

/**
 * Log-safe classes of an embedding endpoint error. Only these fixed tokens
 * ever reach the log, never text from the endpoint itself: an error body can
 * echo headers, cookies, credentials or the memory text that was sent.
 */
export type EmbeddingErrorClass =
  | 'queue_full'
  | 'model_not_found'
  | 'timeout'
  | 'context_too_long'
  | 'unknown'

/** Allowlist of known error shapes; the first match wins. */
const EMBEDDING_ERROR_PATTERNS: ReadonlyArray<readonly [EmbeddingErrorClass, RegExp]> = [
  ['queue_full', /maximum pending requests exceeded|server busy|too many (?:pending|concurrent) requests/i],
  ['model_not_found', /\bmodel\b[^\n]{0,160}?\bnot found|no such model|unknown model/i],
  ['timeout', /timed? ?out|timeout|deadline exceeded/i],
  ['context_too_long', /context length|context window|input (?:is )?too long|exceeds? (?:the )?(?:maximum )?(?:context|input)|too many tokens/i],
]

/**
 * Maps an embedding endpoint error body onto a fixed class via the allowlist
 * above. The body is only matched, never returned or logged. Never throws.
 */
export function classifyEmbeddingError(body: string): EmbeddingErrorClass {
  for (const [cls, pattern] of EMBEDDING_ERROR_PATTERNS) {
    if (pattern.test(body)) return cls
  }
  return 'unknown'
}

/**
 * Reads at most {@link EMBEDDING_ERROR_BODY_MAX_BYTES} of a response body and
 * cancels the rest of the stream, so a huge error body is never buffered.
 * Never throws; an unreadable body yields ''.
 */
export async function readBoundedBody(
  response: Response,
  maxBytes: number = EMBEDDING_ERROR_BODY_MAX_BYTES,
): Promise<string> {
  const stream = response.body
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const take = value.byteLength > maxBytes - total ? value.subarray(0, maxBytes - total) : value
      chunks.push(take)
      total += take.byteLength
    }
  } catch {
    // Unreadable remainder: classify what arrived.
  } finally {
    reader.cancel().catch(() => {})
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * Log-safe classes of a failed embedding call that threw (network, abort,
 * unparsable 200 body, ...). Like {@link EmbeddingErrorClass}, only these
 * fixed tokens are ever logged: an exception message can quote the response
 * body (a JSON `SyntaxError` does) or a URL with credentials.
 */
export type EmbeddingFailureClass = 'invalid_json' | 'timeout' | 'network' | 'unknown'

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED',
])
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

function errorField(value: unknown, field: 'name' | 'code'): string {
  if (!value || typeof value !== 'object') return ''
  try {
    const raw = (value as Record<string, unknown>)[field]
    return typeof raw === 'string' ? raw : ''
  } catch {
    return ''
  }
}

/**
 * Maps a thrown error onto a fixed class using only `name` and `code` (also
 * of `cause`, where Node's fetch puts the socket error). Never reads, returns
 * or logs `message`. Never throws.
 */
export function classifyEmbeddingFailure(err: unknown): EmbeddingFailureClass {
  const name = errorField(err, 'name')
  if (name === 'SyntaxError') return 'invalid_json'
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  let cause: unknown
  try {
    cause = err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined
  } catch {
    cause = undefined
  }
  for (const code of [errorField(err, 'code'), errorField(cause, 'code')]) {
    if (TIMEOUT_ERROR_CODES.has(code)) return 'timeout'
    if (NETWORK_ERROR_CODES.has(code)) return 'network'
  }
  return 'unknown'
}

/**
 * Embed a batch of texts. Returns null when embeddings are disabled or the
 * endpoint call fails — callers must treat null as "no semantic signal".
 */
export async function embedTexts(
  texts: string[],
  settings: MemoryEmbeddingSettings = loadMemoryEmbeddingSettings(),
): Promise<Float32Array[] | null> {
  if (!settings.enabled || texts.length === 0) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  try {
    const response = await fetch(`${settings.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, input: texts }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const errorClass = classifyEmbeddingError(await readBoundedBody(response))
      console.warn(`[memory-embeddings] Endpoint returned ${response.status} (${errorClass})`)
      return null
    }
    const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> }
    if (!payload.data || payload.data.length !== texts.length) return null
    // The API guarantees an index field; sort defensively so vector i
    // belongs to text i.
    const sorted = [...payload.data].sort((a, b) => a.index - b.index)
    return sorted.map((d) => Float32Array.from(d.embedding))
  } catch (err) {
    console.warn(`[memory-embeddings] Embedding call failed (${classifyEmbeddingFailure(err)})`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

export function embeddingToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function bufferToEmbedding(blob: Buffer): Float32Array {
  // Copy: SQLite buffers may be pooled/reused by the driver.
  return new Float32Array(new Uint8Array(blob).buffer, 0, Math.floor(blob.length / 4))
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Fire-and-forget: embed one memory row and store the vector. Failures are
 * logged and the row simply stays lexical-only (picked up by the next
 * backfill run).
 */
export function embedMemoryBestEffort(db: Database, id: number, content: string): void {
  const settings = loadMemoryEmbeddingSettings()
  if (!settings.enabled) return
  void embedTexts([content], settings)
    .then((vectors) => {
      if (!vectors?.[0]) return
      db.prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(embeddingToBuffer(vectors[0]), id)
    })
    .catch((err) => {
      console.warn(`[memory-embeddings] Failed to embed memory ${id} (${classifyEmbeddingFailure(err)})`)
    })
}

export interface EmbeddingSearchHit {
  id: number
  score: number
}

/**
 * Semantic search over embedded memory rows: embed the query, brute-force
 * cosine over stored vectors (fact memory is small — thousands of rows at
 * most, a few ms). Returns null when embeddings are unavailable.
 */
export async function searchMemoriesByEmbedding(
  db: Database,
  query: string,
  options: { userId?: number; limit?: number } = {},
): Promise<EmbeddingSearchHit[] | null> {
  const settings = loadMemoryEmbeddingSettings()
  if (!settings.enabled) return null

  const vectors = await embedTexts([query], settings)
  if (!vectors?.[0]) return null
  const queryVector = vectors[0]

  const conditions: string[] = ['embedding IS NOT NULL']
  const params: unknown[] = []
  if (options.userId !== undefined) {
    conditions.push('(user_id = ? OR user_id IS NULL)')
    params.push(options.userId)
  }

  const rows = db.prepare(
    `SELECT id, embedding FROM memories WHERE ${conditions.join(' AND ')}`
  ).all(...params) as Array<{ id: number; embedding: Buffer }>

  const limit = Math.max(1, Math.floor(options.limit ?? 10))
  return rows
    .map((row) => ({ id: row.id, score: cosineSimilarity(queryVector, bufferToEmbedding(row.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Embed memory rows that don't have a vector yet, in batches. Returns the
 * number of rows embedded. Intended as a fire-and-forget startup job.
 */
export async function backfillMemoryEmbeddings(
  db: Database,
  options: { batchSize?: number; maxRows?: number } = {},
): Promise<number> {
  const settings = loadMemoryEmbeddingSettings()
  if (!settings.enabled) return 0

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 32))
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 5000))
  let embedded = 0

  while (embedded < maxRows) {
    const rows = db.prepare(
      "SELECT id, content FROM memories WHERE embedding IS NULL AND content != '' LIMIT ?"
    ).all(batchSize) as Array<{ id: number; content: string }>
    if (rows.length === 0) break

    const vectors = await embedTexts(rows.map((r) => r.content), settings)
    if (!vectors) break // endpoint down — retry on next startup

    const update = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')
    for (let i = 0; i < rows.length; i++) {
      const vector = vectors[i]
      if (vector) update.run(embeddingToBuffer(vector), rows[i]!.id)
    }
    embedded += rows.length
  }

  return embedded
}
