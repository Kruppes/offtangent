/**
 * Prompt-cache routing for OpenAI Responses / ChatGPT Codex models.
 *
 * pi-ai derives `prompt_cache_key`, the `session-id` / `session_id` affinity
 * header and (Codex WebSocket) the connection identity from
 * `options.sessionId`. Without it the Codex backend gets a fresh random
 * session id on every request and only the static system prefix is ever read
 * from cache. These tests lock that `buildStreamFn` forwards the stable
 * strand/task session id for both Responses APIs, while every other
 * non-Anthropic provider keeps receiving exactly the options it got before.
 */
import { zstdDecompressSync } from 'node:zlib'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { applyPromptCacheOptions, buildStreamFn } from './provider-config.js'
import { SYSTEM_PROMPT_CACHE_MARKER, type PromptCacheSettings } from './prompt-cache.js'
import { streamSimple as streamSimpleCodex } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple as streamSimpleResponses } from '@earendil-works/pi-ai/api/openai-responses'

const SETTINGS: PromptCacheSettings = { retention: 'long', systemBreakpoint: true, sessionAffinity: true }
const SESSION = 'session-0000-test'

const codexModel = { id: 'gpt-test-codex', api: 'openai-codex-responses' }
const responsesModel = { id: 'gpt-test', api: 'openai-responses' }
const completionsModel = { id: 'local-test', api: 'openai-completions' }

function marked(prefix: string, tail: string): string {
  return `${prefix}\n\n${SYSTEM_PROMPT_CACHE_MARKER}\n\n${tail}`
}

function input(overrides: Partial<Parameters<typeof applyPromptCacheOptions>[2]> = {}) {
  return { prefixChars: null, systemPromptLength: 0, sessionId: SESSION, settings: SETTINGS, ...overrides }
}

describe('applyPromptCacheOptions for OpenAI Responses APIs', () => {
  for (const model of [codexModel, responsesModel]) {
    describe(model.api, () => {
      it('forwards the session id as cache routing key', () => {
        const opts = applyPromptCacheOptions(model, { temperature: 0.2 }, input()) as Record<string, unknown>
        expect(opts.sessionId).toBe(SESSION)
        expect(opts.temperature).toBe(0.2)
      })

      it('works when the caller passes no options object', () => {
        const opts = applyPromptCacheOptions(model, undefined, input()) as Record<string, unknown> | undefined
        expect(opts?.sessionId).toBe(SESSION)
      })

      it('fills an explicit undefined sessionId (pi-agent-core passes the key unset)', () => {
        const opts = applyPromptCacheOptions(model, { sessionId: undefined }, input()) as Record<string, unknown>
        expect(opts.sessionId).toBe(SESSION)
      })

      it('does not set cacheRetention (would add prompt_cache_retention on openai-responses)', () => {
        const opts = applyPromptCacheOptions(model, {}, input()) as Record<string, unknown>
        expect(opts).not.toHaveProperty('cacheRetention')
      })

      it('does not install the Anthropic system-prompt breakpoint hook', () => {
        const prompt = marked('STABLE', 'VOLATILE')
        const opts = applyPromptCacheOptions(model, {}, input({
          prefixChars: 'STABLE\n\n'.length,
          systemPromptLength: prompt.length,
        })) as Record<string, unknown>
        expect(opts).not.toHaveProperty('onPayload')
      })

      it('keeps a caller-provided sessionId', () => {
        const opts = applyPromptCacheOptions(model, { sessionId: 'explicit' }, input()) as Record<string, unknown>
        expect(opts.sessionId).toBe('explicit')
      })

      it('returns the options untouched without a session id', () => {
        const original = { temperature: 0.2 }
        expect(applyPromptCacheOptions(model, original, input({ sessionId: undefined }))).toBe(original)
      })

      it('returns the options untouched when sessionAffinity is off', () => {
        const original = { temperature: 0.2 }
        const settings = { ...SETTINGS, sessionAffinity: false }
        expect(applyPromptCacheOptions(model, original, input({ settings }))).toBe(original)
      })

      it('returns the options untouched when retention is none (caching off)', () => {
        const original = { temperature: 0.2 }
        const settings = { ...SETTINGS, retention: 'none' as const }
        expect(applyPromptCacheOptions(model, original, input({ settings }))).toBe(original)
      })
    })
  }

  it('leaves openai-completions (Ollama & friends) byte-identical', () => {
    const original = { temperature: 0.2, transport: 'sse' }
    const out = applyPromptCacheOptions(completionsModel, original, input({
      prefixChars: 3,
      systemPromptLength: 10,
    }))
    expect(out).toBe(original)
    expect(JSON.stringify(out)).toBe(JSON.stringify({ temperature: 0.2, transport: 'sse' }))
  })

  it('leaves models without an api untouched', () => {
    const original = { temperature: 0.2 }
    expect(applyPromptCacheOptions(undefined, original, input())).toBe(original)
    expect(applyPromptCacheOptions({}, original, input())).toBe(original)
  })
})

describe('buildStreamFn forwards the session id to Responses models', () => {
  it('passes sessionId through to the stream implementation for Codex', async () => {
    const fakeStream = vi.fn().mockReturnValue({ ok: true })
    const fn = buildStreamFn({}, fakeStream as never, { getSessionId: () => SESSION, settings: SETTINGS })
    const context = { systemPrompt: marked('STABLE', 'VOLATILE'), messages: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn(codexModel as any, context as any, { reasoning: 'high' } as any)

    const [, ctx, opts] = fakeStream.mock.calls[0]!
    expect(ctx.systemPrompt).toBe('STABLE\n\nVOLATILE')
    expect(opts).toEqual({ reasoning: 'high', sessionId: SESSION })
  })

  it('reads the session id per call (one runtime serves many strands)', async () => {
    const fakeStream = vi.fn().mockReturnValue({ ok: true })
    let current = 'strand-a'
    const fn = buildStreamFn({}, fakeStream as never, { getSessionId: () => current, settings: SETTINGS })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn(responsesModel as any, { systemPrompt: 'p', messages: [] } as any, undefined as any)
    current = 'strand-b'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn(responsesModel as any, { systemPrompt: 'p', messages: [] } as any, undefined as any)
    expect(fakeStream.mock.calls[0]![2].sessionId).toBe('strand-a')
    expect(fakeStream.mock.calls[1]![2].sessionId).toBe('strand-b')
  })

  it('keeps openai-completions requests identical even with a session id available', async () => {
    const fakeStream = vi.fn().mockReturnValue({ ok: true })
    const fn = buildStreamFn({}, fakeStream as never, { getSessionId: () => SESSION, settings: SETTINGS })
    const callerOpts = { temperature: 0.4 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn(completionsModel as any, { systemPrompt: 'plain', messages: [] } as any, callerOpts as any)
    expect(fakeStream.mock.calls[0]![2]).toBe(callerOpts)
  })
})

/**
 * End to end through the real pi-ai adapters: capture the HTTP request the
 * adapter builds (fetch injected via options, SSE transport, no retries) and
 * check that the session id becomes `prompt_cache_key` plus the affinity
 * header. No network access, no real credentials.
 */
describe('real pi-ai request shape with the forwarded session id', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function fakeCodexToken(): string {
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } }
    return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
  }

  interface Captured { url: string, headers: Headers, body: Record<string, unknown> }

  function capturingFetch(captured: Captured[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const raw = init?.body
      const headers = new Headers(init?.headers)
      let text: string
      if (typeof raw === 'string') text = raw
      else if (headers.get('content-encoding') === 'zstd') {
        // The Codex SSE transport zstd-compresses the body when Node supports it.
        text = zstdDecompressSync(raw as Uint8Array).toString('utf8')
      } else text = new TextDecoder().decode(raw as Uint8Array)
      captured.push({ url: String(url), headers, body: JSON.parse(text) })
      return new Response('{"error":{"message":"synthetic test stop"}}', { status: 400 })
    }) as typeof fetch
  }

  async function drain(stream: AsyncIterable<unknown>): Promise<void> {
    for await (const _event of stream) { /* consume until error/done */ }
  }

  const context = {
    systemPrompt: marked('STABLE', 'VOLATILE'),
    messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
  }

  it('openai-codex-responses: prompt_cache_key and session-id header carry the session id', async () => {
    const captured: Captured[] = []
    const model = {
      id: 'gpt-test-codex', name: 'test', api: 'openai-codex-responses', provider: 'openai-codex',
      baseUrl: 'https://codex.invalid/backend-api', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    }
    const fn = buildStreamFn({}, streamSimpleCodex as never, { getSessionId: () => SESSION, settings: SETTINGS })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await fn(model as any, context as any, {
      apiKey: fakeCodexToken(), transport: 'sse', maxRetries: 0, fetch: capturingFetch(captured),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await drain(stream as AsyncIterable<unknown>)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.headers.get('session-id')).toBe(SESSION)
    expect(captured[0]!.headers.get('x-client-request-id')).toBe(SESSION)
    expect(captured[0]!.body.prompt_cache_key).toBe(SESSION)
    expect(captured[0]!.body).not.toHaveProperty('prompt_cache_retention')
  })

  it('openai-codex-responses without a session id sends no affinity (control)', async () => {
    const captured: Captured[] = []
    const model = {
      id: 'gpt-test-codex', name: 'test', api: 'openai-codex-responses', provider: 'openai-codex',
      baseUrl: 'https://codex.invalid/backend-api', reasoning: true, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    }
    const fn = buildStreamFn({}, streamSimpleCodex as never, { getSessionId: () => undefined, settings: SETTINGS })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await fn(model as any, context as any, {
      apiKey: fakeCodexToken(), transport: 'sse', maxRetries: 0, fetch: capturingFetch(captured),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await drain(stream as AsyncIterable<unknown>)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.headers.get('session-id')).toBeNull()
    expect(captured[0]!.body.prompt_cache_key).toBeUndefined()
  })

  it('openai-responses: prompt_cache_key and session_id header carry the session id, no retention field', async () => {
    const captured: Captured[] = []
    const model = {
      id: 'gpt-test', name: 'test', api: 'openai-responses', provider: 'openai',
      baseUrl: 'https://responses.invalid/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000,
    }
    const fn = buildStreamFn({}, streamSimpleResponses as never, { getSessionId: () => SESSION, settings: SETTINGS })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await fn(model as any, context as any, {
      apiKey: 'sk-test-synthetic', maxRetries: 0, fetch: capturingFetch(captured),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await drain(stream as AsyncIterable<unknown>)

    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0]!.headers.get('session_id')).toBe(SESSION)
    expect(captured[0]!.body.prompt_cache_key).toBe(SESSION)
    expect(captured[0]!.body.prompt_cache_retention).toBeUndefined()
  })
})
