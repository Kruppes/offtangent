import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import {
  INTERVIEW_READ_DEFAULT_SCOPES,
  INTERVIEW_READ_PATHS,
  InterviewReadError,
  UNTRUSTED_NOTE,
  createInterviewReadClient,
  createInterviewReadManifest,
  resolveInterviewOrigin,
} from './manifest.js'
import type { ConnectorToolContext } from '../types.js'

const ORIGIN = 'https://interviews.invalid'
const TOKEN = 'synthetic-read-token-0123456789'

function fakeService(handler: (path: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(new URL(String(url)).pathname, init ?? {})
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const listBody = {
  contract: 'interview-read.v1',
  interviews: [{
    id: 'sess-1', label: 'Pilot A', status: 'summary', turns: 7,
    coveredAreas: ['branche_taetigkeit'], summaryConfirmed: true, releasedAt: 1759000000000,
    processing: { localOnly: false },
  }],
}

const resultBody = {
  contract: 'interview-read.v1', id: 'sess-1', untrusted: true,
  result: { summary: 'Synthetic summary', facts: [{ text: 'synthetic fact' }] },
}

function ctx(fetchImpl: typeof fetch, token = TOKEN): ConnectorToolContext {
  return { connectorId: 'interview-read', dataClass: 'local_only', getAccessToken: async () => token, fetchImpl }
}

describe('origin validation', () => {
  it('accepts https and loopback http', () => {
    expect(resolveInterviewOrigin('https://interviews.invalid')).toBe('https://interviews.invalid')
    expect(resolveInterviewOrigin('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })

  it('refuses plain http, a path, query, credentials and garbage', () => {
    for (const bad of [
      'http://interviews.invalid',
      'https://interviews.invalid/api/admin',
      'https://interviews.invalid?x=1',
      'https://user:pw@interviews.invalid',
      'not-a-url',
      '',
      undefined,
    ]) {
      expect(() => resolveInterviewOrigin(bad), String(bad)).toThrowError(InterviewReadError)
    }
  })
})

describe('the read client', () => {
  it('uses GET, the pinned paths, the read token header and refuses redirects', async () => {
    const service = fakeService(path => {
      if (path === INTERVIEW_READ_PATHS.list) return json(listBody)
      if (path === INTERVIEW_READ_PATHS.result('sess-1')) return json(resultBody)
      return json({ error: 'not_found' }, 404)
    })
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: INTERVIEW_READ_DEFAULT_SCOPES, fetchImpl: service.fetchImpl,
    })
    const listed = await client.list()
    expect(listed).toEqual([{
      id: 'sess-1', label: 'Pilot A', status: 'summary', turns: 7,
      coveredAreas: ['branche_taetigkeit'], summaryConfirmed: true, releasedAt: 1759000000000,
      processing: { localOnly: false },
    }])
    expect(await client.result('sess-1')).toEqual(resultBody.result)
    expect(service.calls).toHaveLength(2)
    for (const call of service.calls) {
      expect(call.init.method).toBe('GET')
      expect((call.init.headers as Record<string, string>)['x-read-token']).toBe(TOKEN)
      expect(call.init.redirect).toBe('error')
    }
    expect(service.calls[0].url).toBe(`${ORIGIN}/v1/readonly/interviews`)
    expect(service.calls[1].url).toBe(`${ORIGIN}/v1/readonly/interviews/sess-1/result`)
  })

  it('never calls the transcript path without the scope', async () => {
    const service = fakeService(() => json(resultBody))
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: INTERVIEW_READ_DEFAULT_SCOPES, fetchImpl: service.fetchImpl,
    })
    await expect(client.transcript('sess-1')).rejects.toMatchObject({ code: 'scope_denied' })
    expect(service.calls).toHaveLength(0)
  })

  it('maps a revoked, deleted or unreleased session to not_found without an existence oracle', async () => {
    const service = fakeService(() => json({ error: 'not_found' }, 404))
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list', 'interviews:result'], fetchImpl: service.fetchImpl,
    })
    await expect(client.result('sess-unknown')).rejects.toMatchObject({ code: 'not_found' })
    await expect(client.result('sess-revoked')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('maps an upstream scope refusal and rate limit to its own codes', async () => {
    const denied = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: fakeService(() => json({ error: 'scope_denied' }, 403)).fetchImpl,
    })
    await expect(denied.list()).rejects.toMatchObject({ code: 'scope_denied' })
    const limited = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: fakeService(() => json({ error: 'rate_limited' }, 429)).fetchImpl,
    })
    await expect(limited.list()).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('refuses a wrong contract label, a non-object body and an oversized response', async () => {
    const wrong = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: fakeService(() => json({ contract: 'openai.chat.v1', interviews: [] })).fetchImpl,
    })
    await expect(wrong.list()).rejects.toMatchObject({ code: 'bad_response' })
    const array = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: fakeService(() => json([1, 2, 3])).fetchImpl,
    })
    await expect(array.list()).rejects.toMatchObject({ code: 'bad_response' })
    const huge = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: fakeService(() => new Response('x'.repeat(600 * 1024), { status: 200 })).fetchImpl,
    })
    await expect(huge.list()).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('refuses a malformed session id before any request', async () => {
    const service = fakeService(() => json(resultBody))
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:result'], fetchImpl: service.fetchImpl,
    })
    for (const bad of ['../admin/sessions', 'a'.repeat(65), 'has space', '', 'a/b']) {
      await expect(client.result(bad), bad).rejects.toMatchObject({ code: 'bad_request' })
    }
    expect(service.calls).toHaveLength(0)
  })

  it('refuses to run without a credential', async () => {
    const service = fakeService(() => json(listBody))
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => '', scopes: ['interviews:list'], fetchImpl: service.fetchImpl,
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'not_connected' })
    expect(service.calls).toHaveLength(0)
  })

  it('refuses an oversized response by announced length, before buffering it', async () => {
    // Review finding 6: the old code awaited `response.text()` first and only
    // then compared a length, so a hostile service could OOM the process.
    let drained = 0
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: (async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            drained += 1
            controller.enqueue(new Uint8Array(64 * 1024))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) } },
      )) as unknown as typeof fetch,
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'response_too_large' })
    // At most the one chunk the stream prefetches on its own (highWaterMark 1);
    // the client itself never reads from the body.
    expect(drained).toBeLessThanOrEqual(1)
  })

  it('aborts an endless response once the byte budget is spent', async () => {
    let produced = 0
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: (async () => new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            produced += 64 * 1024
            if (produced > 64 * 1024 * 1024) {
              controller.error(new Error('the reader never stopped'))
              return
            }
            controller.enqueue(new Uint8Array(64 * 1024))
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    })
    await expect(client.list()).rejects.toMatchObject({ code: 'response_too_large' })
    // 512 KiB budget: the stream is cut long before a gigabyte is buffered.
    expect(produced).toBeLessThanOrEqual(1024 * 1024)
  })

  it('gives up on an upstream that sends headers and then stalls', async () => {
    // Review finding: the abort timer was cleared as soon as the HEADERS
    // arrived, so a trickling body held the tool call (and the local sub agent)
    // open forever — the byte budget never triggers because no bytes arrive.
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'], timeoutMs: 60,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"contract":'))
            // Like undici: an aborted signal tears the body stream down.
            init?.signal?.addEventListener('abort', () => {
              controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
    })
    const started = Date.now()
    await expect(client.list()).rejects.toMatchObject({ code: 'upstream_unreachable' })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('does not pre-refuse a compressed body by its encoded length', async () => {
    // `content-length` counts encoded bytes, the budget counts decoded ones.
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: (async () => new Response(
        JSON.stringify({ contract: 'interview-read.v1', interviews: [] }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': String(600 * 1024),
          },
        },
      )) as unknown as typeof fetch,
    })
    await expect(client.list()).resolves.toEqual([])
  })

  it('never leaks the token or the url in an error message', async () => {
    const client = createInterviewReadClient({
      origin: ORIGIN, getToken: async () => TOKEN, scopes: ['interviews:list'],
      fetchImpl: (async () => { throw new Error(`connect ECONNREFUSED ${ORIGIN}/v1/readonly/interviews?token=${TOKEN}`) }) as unknown as typeof fetch,
    })
    const err: unknown = await client.list().then(() => null, (e: unknown) => e)
    const message = err instanceof Error ? err.message : String(err)
    expect(message).not.toContain(TOKEN)
    expect(message).not.toContain('readonly')
  })
})

describe('the manifest', () => {
  it('is local_only, apiKey based and read only', () => {
    const manifest = createInterviewReadManifest({ resolveOrigin: () => ORIGIN })
    expect(manifest.dataClass).toBe('local_only')
    expect(manifest.auth).toBe('apiKey')
    expect(manifest.oauth).toBeUndefined()
    const names = manifest.createTools(ctx(fakeService(() => json(listBody)).fetchImpl)).map(t => t.name)
    expect(names).toEqual(['interview_list', 'interview_result'])
    for (const tool of manifest.createTools(ctx(fakeService(() => json(listBody)).fetchImpl))) {
      expect(tool.name).not.toMatch(/write|create|delete|update|post|release|admin/)
    }
  })

  it('offers every tool only with its own scope', () => {
    // Review finding 11: `interview_result` was always advertised, even without
    // the result scope, so the tool list overstated the granted capability.
    const listOnly = createInterviewReadManifest({ resolveOrigin: () => ORIGIN, scopes: ['interviews:list'] })
    expect(listOnly.createTools(ctx(fakeService(() => json(listBody)).fetchImpl)).map(t => t.name))
      .toEqual(['interview_list'])
    const resultOnly = createInterviewReadManifest({ resolveOrigin: () => ORIGIN, scopes: ['interviews:result'] })
    expect(resultOnly.createTools(ctx(fakeService(() => json(listBody)).fetchImpl)).map(t => t.name))
      .toEqual(['interview_result'])
    const none = createInterviewReadManifest({ resolveOrigin: () => ORIGIN, scopes: [] })
    expect(none.createTools(ctx(fakeService(() => json(listBody)).fetchImpl))).toEqual([])
  })

  it('only offers the transcript tool when the scope is configured', () => {
    const withTranscript = createInterviewReadManifest({
      resolveOrigin: () => ORIGIN,
      scopes: ['interviews:list', 'interviews:result', 'interviews:transcript'],
    })
    const names = withTranscript.createTools(ctx(fakeService(() => json(listBody)).fetchImpl)).map(t => t.name)
    expect(names).toEqual(['interview_list', 'interview_result', 'interview_transcript'])
  })

  it('frames every tool result as untrusted third party data', async () => {
    const manifest = createInterviewReadManifest({ resolveOrigin: () => ORIGIN })
    const [list] = manifest.createTools(ctx(fakeService(() => json(listBody)).fetchImpl))
    const out = await (list as unknown as { execute: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }).execute({})
    expect(out.content[0].text.startsWith(UNTRUSTED_NOTE)).toBe(true)
    expect(out.content[0].text).toContain('Pilot A')
  })

  it('turns a failure into a tool error instead of throwing into the agent loop', async () => {
    const manifest = createInterviewReadManifest({ resolveOrigin: () => ORIGIN })
    const [, result] = manifest.createTools(ctx(fakeService(() => json({ error: 'not_found' }, 404)).fetchImpl))
    const out = await (result as unknown as { execute: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }).execute({ id: 'sess-1' })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('not_found')
  })

  it('reports a connection test without leaking data', async () => {
    const manifest = createInterviewReadManifest({ resolveOrigin: () => ORIGIN })
    const ok = await manifest.test?.(ctx(fakeService(() => json(listBody)).fetchImpl))
    expect(ok).toEqual({ ok: true, detail: '1 released session(s) visible' })
    const bad = await manifest.test?.(ctx(fakeService(() => json({ error: 'read_denied' }, 403)).fetchImpl))
    expect(bad).toEqual({ ok: false, detail: 'scope_denied' })
  })

  it('writes nothing: the module imports no memory, chat, strand or database module', () => {
    const source = readSource()
    const imports = [...source.matchAll(/from '(\.[^']+)'/g)].map(m => m[1])
    expect(imports).toEqual(['../types.js'])
    for (const forbidden of ['memory', 'database', 'chat', 'strand', 'board', 'feed', 'agent-']) {
      expect(source.includes(`from '../${forbidden}`), forbidden).toBe(false)
    }
  })
})

function readSource(): string {
  return fs.readFileSync(new URL('./manifest.ts', import.meta.url), 'utf-8')
}
