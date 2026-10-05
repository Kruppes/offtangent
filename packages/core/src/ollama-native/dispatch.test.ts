import { describe, expect, it } from 'vitest'
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { streamSimple, SUPPORTED_APIS } from '../pi-models.js'
import { OLLAMA_CHAT_API } from './chat-stream.js'

/* Synthetic only: fake fetch, no network, no real model. */

const context: Context = { systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }

function model(api: Api, baseUrl: string): Model<Api> {
  return {
    id: 'synthetic:1b', name: 'synthetic', api, provider: `dispatch-test-${api}`, baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  } as Model<Api>
}

function ndjsonFetch(seen: Array<{ url: string; body: string; auth?: string | null }>) {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body), auth: new Headers(init?.headers).get('authorization') })
    const body = JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 1 }) + '\n'
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
}

describe('native Ollama dispatch through pi-models', () => {
  it('registers ollama-chat additively next to openai-completions', () => {
    expect(SUPPORTED_APIS.has(OLLAMA_CHAT_API)).toBe(true)
    expect(SUPPORTED_APIS.has('openai-completions')).toBe(true)
  })

  it('routes to /api/chat and forwards ollamaNumCtx verbatim', async () => {
    const seen: Array<{ url: string; body: string; auth?: string | null }> = []
    const opts = { apiKey: 'no-key', fetch: ndjsonFetch(seen), ollamaNumCtx: 65536 } as SimpleStreamOptions
    const result = await streamSimple(model(OLLAMA_CHAT_API, 'http://ollama.invalid:11434'), context, opts).result()
    expect(result.stopReason).toBe('stop')
    expect(seen[0]?.url).toBe('http://ollama.invalid:11434/api/chat')
    expect(JSON.parse(seen[0]!.body).options).toEqual({ num_ctx: 65536 })
    expect(seen[0]?.auth).toBeNull()
  })

  it('absent selection: native body carries no options.num_ctx', async () => {
    const seen: Array<{ url: string; body: string; auth?: string | null }> = []
    await streamSimple(model(OLLAMA_CHAT_API, 'http://ollama.invalid:11434'), context, { apiKey: 'no-key', fetch: ndjsonFetch(seen) }).result()
    expect(JSON.parse(seen[0]!.body)).not.toHaveProperty('options')
  })

  it('/v1 openai-completions payload is byte-identical with or without an ollamaNumCtx option', async () => {
    const capture = async (extra: Record<string, unknown>) => {
      let payload = ''
      const opts = {
        ...extra,
        apiKey: 'synthetic',
        onPayload: (p: unknown) => { payload = JSON.stringify(p) ; return undefined },
        fetch: (async () => new Response('{"error":{"message":"synthetic stop"}}', { status: 500 })) as unknown as typeof fetch,
        maxRetries: 0,
      } as SimpleStreamOptions
      await streamSimple(model('openai-completions', 'http://ollama.invalid:11434/v1'), context, opts).result()
      return payload
    }
    const plain = await capture({})
    const withCtx = await capture({ ollamaNumCtx: 131072 })
    expect(plain.length).toBeGreaterThan(0)
    expect(withCtx).toBe(plain)
    expect(plain).not.toContain('num_ctx')
  })
})
