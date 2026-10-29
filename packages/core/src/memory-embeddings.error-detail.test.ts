/**
 * Boot warnings: a non-200 from the embedding endpoint logs only the status
 * plus a fixed error class from an allowlist, never text from the endpoint.
 * All values are made up; the "secret" below is a GitHub-token-shaped
 * string, not a real credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EMBEDDING_ERROR_BODY_MAX_BYTES,
  classifyEmbeddingError,
  classifyEmbeddingFailure,
  embedTexts,
  readBoundedBody,
  type MemoryEmbeddingSettings,
} from './memory-embeddings.js'

const SETTINGS: MemoryEmbeddingSettings = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:9',
  model: 'embed-test',
  timeoutMs: 1000,
  assignMinScore: 0.5,
} as MemoryEmbeddingSettings

const FAKE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('classifyEmbeddingError', () => {
  it('maps known error shapes onto fixed classes', () => {
    expect(classifyEmbeddingError('{"error":"maximum pending requests exceeded"}')).toBe('queue_full')
    expect(classifyEmbeddingError('{"error":{"message":"model not found","type":"x"}}')).toBe('model_not_found')
    expect(classifyEmbeddingError('{"error":"model \\"qwen3-embedding:0.6b\\" not found, try pulling it first"}'))
      .toBe('model_not_found')
    expect(classifyEmbeddingError('upstream request timed out')).toBe('timeout')
    expect(classifyEmbeddingError('{"error":"context deadline exceeded"}')).toBe('timeout')
    expect(classifyEmbeddingError('{"error":"the input length exceeds the context length"}')).toBe('context_too_long')
  })

  it('falls back to unknown for everything else, including an empty body', () => {
    expect(classifyEmbeddingError('')).toBe('unknown')
    expect(classifyEmbeddingError('upstream overloaded')).toBe('unknown')
    expect(classifyEmbeddingError('x'.repeat(5000))).toBe('unknown')
  })
})

describe('readBoundedBody', () => {
  it('stops after the byte limit and cancels the rest of the stream', async () => {
    let pulled = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(new Uint8Array(1024).fill(120))
        // Endless body: only the reader's limit ends it.
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const text = await readBoundedBody(new Response(stream, { status: 500 }))
    expect(text.length).toBe(EMBEDDING_ERROR_BODY_MAX_BYTES)
    expect(pulled).toBeLessThanOrEqual(EMBEDDING_ERROR_BODY_MAX_BYTES / 1024 + 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(cancelled).toBe(true)
  })

  it('returns a short body unchanged and an empty one as empty', async () => {
    expect(await readBoundedBody(new Response('model not found', { status: 404 }))).toBe('model not found')
    expect(await readBoundedBody(new Response(null, { status: 500 }))).toBe('')
  })
})

describe('embedTexts on a non-200', () => {
  async function warnLineFor(body: string, status: number): Promise<string> {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await embedTexts(['hello'], SETTINGS)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    return String(warn.mock.calls[0]![0])
  }

  it('logs status plus the error class', async () => {
    expect(await warnLineFor(JSON.stringify({ error: 'maximum pending requests exceeded' }), 503))
      .toBe('[memory-embeddings] Endpoint returned 503 (queue_full)')
    expect(await warnLineFor('', 500)).toBe('[memory-embeddings] Endpoint returned 500 (unknown)')
  })

  it.each([
    ['a token echoed in the error', `invalid api key ${FAKE_TOKEN}`, FAKE_TOKEN],
    ['an authorization=… pair', 'rejected: authorization=s3cr3tvalue123 is invalid', 's3cr3tvalue123'],
    ['a set-cookie header', 'proxy error\nset-cookie: session=c00kie-value-xyz; Path=/', 'c00kie-value-xyz'],
    ['an echoed memory text', '{"error":"cannot embed: Alice PIN is 4711 and lives in Musterstadt"}', 'Musterstadt'],
    ['a bearer credential', 'header Authorization: Bearer abc.def.ghi', 'abc.def.ghi'],
  ])('never logs endpoint text: %s', async (_label, body, needle) => {
    const line = await warnLineFor(body, 401)
    expect(line).toBe('[memory-embeddings] Endpoint returned 401 (unknown)')
    expect(line).not.toContain(needle)
  })
})

describe('embedTexts when the call throws', () => {
  const CANARY = 'SENSITIVE_CANARY_7f3a9c'

  /** Every argument of every console.warn call, joined: nothing may hide in a 2nd arg. */
  async function warnOutputFor(fetchImpl: () => Promise<Response>): Promise<string> {
    vi.stubGlobal('fetch', vi.fn(fetchImpl))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await embedTexts(['hello'], SETTINGS)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    return warn.mock.calls.flat().map((arg) => String(arg)).join(' | ')
  }

  it('HTTP 200 with invalid JSON logs only invalid_json, never the parser message', async () => {
    // The real JSON parser quotes the body start: `Unexpected token 'S', "SENSITIVE_"... is not valid JSON`.
    const output = await warnOutputFor(async () => new Response(`${CANARY} not json`, { status: 200 }))
    expect(output).toBe('[memory-embeddings] Embedding call failed (invalid_json)')
    expect(output).not.toContain('SENSITIVE')
  })

  it('a rejected json() logs only its class', async () => {
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(new SyntaxError(`Unexpected token in ${CANARY}`))
    const output = await warnOutputFor(async () => response)
    expect(output).toBe('[memory-embeddings] Embedding call failed (invalid_json)')
    expect(output).not.toContain(CANARY)
  })

  it('a rejected json() with a non-syntax error logs unknown', async () => {
    const response = new Response('{}', { status: 200 })
    vi.spyOn(response, 'json').mockRejectedValue(new Error(`body stream broke at ${CANARY}`))
    const output = await warnOutputFor(async () => response)
    expect(output).toBe('[memory-embeddings] Embedding call failed (unknown)')
    expect(output).not.toContain(CANARY)
  })

  it('a network error with a message logs only network', async () => {
    const output = await warnOutputFor(async () => {
      throw new TypeError(`fetch failed for http://user:${CANARY}@host/v1`, {
        cause: Object.assign(new Error(`connect ECONNREFUSED ${CANARY}`), { code: 'ECONNREFUSED' }),
      })
    })
    expect(output).toBe('[memory-embeddings] Embedding call failed (network)')
    expect(output).not.toContain(CANARY)
  })

  it('an abort (the request timeout) logs only timeout', async () => {
    const output = await warnOutputFor(async () => {
      throw new DOMException(`aborted ${CANARY}`, 'AbortError')
    })
    expect(output).toBe('[memory-embeddings] Embedding call failed (timeout)')
    expect(output).not.toContain(CANARY)
  })
})

describe('classifyEmbeddingFailure', () => {
  it('uses only name and code, falls back to unknown and never throws', () => {
    expect(classifyEmbeddingFailure(new SyntaxError('x'))).toBe('invalid_json')
    expect(classifyEmbeddingFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(classifyEmbeddingFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('timeout')
    expect(classifyEmbeddingFailure(new TypeError('x', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe('network')
    expect(classifyEmbeddingFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe('network')
    // The message alone never decides the class.
    expect(classifyEmbeddingFailure(new Error('ECONNREFUSED timeout invalid json'))).toBe('unknown')
    expect(classifyEmbeddingFailure(undefined)).toBe('unknown')
    expect(classifyEmbeddingFailure('a string')).toBe('unknown')
    const hostile = new Proxy({}, { get() { throw new Error('boom') } })
    expect(classifyEmbeddingFailure(hostile)).toBe('unknown')
  })
})
