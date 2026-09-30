/**
 * Fault injection for the isolated inference path (Abnahme 30.09.2026).
 *
 * Everything below runs the REAL production path — registry file, data policy
 * gate, buildModel, completeSimple, reservation/refund bookkeeping — and only
 * replaces the network with a controlled fake. No billable call, no production
 * provider, no timeout value changed for real users: the failure is injected at
 * the wire, exactly where a hanging or dying provider would show up.
 *
 * What is pinned here:
 *   - a provider that never answers and is aborted -> `upstream_failed` (502),
 *     no provider detail in the error, in-flight slot released again;
 *   - the budget unit of a call that DID reach the provider stays spent
 *     (no silent refund of paid attempts), while a failure BEFORE the provider
 *     (revoked mid-flight) is refunded;
 *   - a second call during a hanging one is refused with `busy` and costs
 *     nothing;
 *   - an exhausted daily budget refuses without touching the network;
 *   - the profile timeout is handed to the client as an abort signal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { saveProviders } from './provider-config.js'
import {
  ISOLATED_INFERENCE_PROFILES,
  isolatedInferenceUsage,
  resetIsolatedInferenceState,
  runIsolatedInference,
  type IsolatedInferenceService,
} from './isolated-inference.js'

const TOKEN = 'synthetic-fault-token-0003'
const service: IsolatedInferenceService = {
  id: 'fault-service',
  tokenSha256: createHash('sha256').update(TOKEN).digest('hex'),
  profiles: ['interview.v1'],
  maxConcurrent: 1,
  dailyCallBudget: 3,
  expiresAt: '',
  revoked: false,
}

let dataDir = ''
let previousDataDir: string | undefined

function writeServiceRegistry(overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'config', 'isolated-inference.json'), JSON.stringify({
    enabled: true,
    services: [{
      id: service.id, tokenSha256: service.tokenSha256, profiles: service.profiles,
      maxConcurrent: service.maxConcurrent, dailyCallBudget: service.dailyCallBudget, ...overrides,
    }],
  }), 'utf-8')
}

function configureAnthropic(): void {
  saveProviders({
    providers: [{
      id: 'anth', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1', apiKey: 'synthetic-not-a-real-key',
      enabledModels: ['claude-sonnet-5-5'],
    }],
    activeProvider: 'anth', activeModel: 'claude-sonnet-5-5',
  } as never)
}

function sseResponse(text: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 34 } },
    { type: 'message_stop' },
  ]
  const body = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * A provider that never answers. Rejects like undici does when the request
 * signal fires, so the abort travels the real error path of the client.
 * `abortAfterMs` stands in for the profile wall clock budget, which is 120 s in
 * production and must not be changed for real users just to test it.
 */
function hangingFetch(abortAfterMs: number, seen: { signals: AbortSignal[] }) {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal) seen.signals.push(signal)
    const onAbort = (): void => reject(new DOMException('This operation was aborted', 'AbortError'))
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    // the client's own timeout is longer than the test; fire the same abort the
    // wall clock budget would fire, just earlier.
    setTimeout(() => {
      if (signal && !signal.aborted) (signal as AbortSignal & { }).dispatchEvent(new Event('abort'))
      else onAbort()
    }, abortAfterMs)
  }))
}

describe('isolated inference under provider faults', () => {
  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-fault-'))
    process.env.DATA_DIR = dataDir
    resetIsolatedInferenceState()
    writeServiceRegistry()
    configureAnthropic()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('hands the profile wall clock budget to the client as an abort signal', async () => {
    const seen = { signals: [] as AbortSignal[] }
    vi.stubGlobal('fetch', hangingFetch(50, seen))
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'synthetisch', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'upstream_failed', status: 502 })
    expect(seen.signals).toHaveLength(1)
    expect(seen.signals[0]).toBeInstanceOf(AbortSignal)
    expect(ISOLATED_INFERENCE_PROFILES['interview.v1'].timeoutMs).toBeLessThanOrEqual(120_000)
  })

  it('turns a hanging provider into a contract error without provider detail and frees the slot', async () => {
    const seen = { signals: [] as AbortSignal[] }
    vi.stubGlobal('fetch', hangingFetch(50, seen))
    let caught: unknown
    try {
      await runIsolatedInference(service, { profile: 'interview.v1', input: 'synthetisch', maxOutputTokens: 100 })
    } catch (err) { caught = err }
    expect(caught).toMatchObject({ code: 'upstream_failed', status: 502 })
    const message = String((caught as { message?: string }).message ?? '')
    expect(message).toBe('inference failed')
    expect(message).not.toMatch(/api\.anthropic\.com|x-api-key|synthetic-not-a-real-key|AbortError/)
    const usage = isolatedInferenceUsage(service)
    expect(usage.inFlight).toBe(0)
    // The attempt reached the provider, so its budget unit stays spent.
    expect(usage.callsToday).toBe(1)
  })

  it('serves the next call normally after a timeout — the slot is not leaked', async () => {
    const seen = { signals: [] as AbortSignal[] }
    vi.stubGlobal('fetch', hangingFetch(40, seen))
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'a', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'upstream_failed' })
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse('{"nextQuestion":"Und dann?","done":false}')))
    const result = await runIsolatedInference(service, { profile: 'interview.v1', input: 'b', maxOutputTokens: 100 })
    expect(result.json).toEqual({ nextQuestion: 'Und dann?', done: false })
    expect(isolatedInferenceUsage(service).callsToday).toBe(2)
    expect(isolatedInferenceUsage(service).inFlight).toBe(0)
  })

  it('refuses a second call while one hangs (busy) and does not charge it', async () => {
    const seen = { signals: [] as AbortSignal[] }
    vi.stubGlobal('fetch', hangingFetch(120, seen))
    const first = runIsolatedInference(service, { profile: 'interview.v1', input: 'a', maxOutputTokens: 100 })
    await new Promise(r => setTimeout(r, 20))
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'b', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'busy', status: 429 })
    expect(isolatedInferenceUsage(service).callsToday).toBe(1)
    await expect(first).rejects.toMatchObject({ code: 'upstream_failed' })
    expect(isolatedInferenceUsage(service).inFlight).toBe(0)
    expect(isolatedInferenceUsage(service).callsToday).toBe(1)
  })

  it('refunds the unit when the call dies BEFORE the provider (revoked mid-flight)', async () => {
    const fetchSpy = vi.fn(async () => sseResponse('{"nextQuestion":"x","done":false}'))
    vi.stubGlobal('fetch', fetchSpy)
    writeServiceRegistry({ revoked: true })
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'a', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(isolatedInferenceUsage(service).callsToday).toBe(0)
    expect(isolatedInferenceUsage(service).inFlight).toBe(0)
  })

  it('stops at the daily budget after repeated faults instead of retrying forever', async () => {
    const seen = { signals: [] as AbortSignal[] }
    const spy = hangingFetch(30, seen)
    vi.stubGlobal('fetch', spy)
    for (let i = 0; i < 3; i += 1) {
      await expect(runIsolatedInference(service, { profile: 'interview.v1', input: `a${i}`, maxOutputTokens: 100 }))
        .rejects.toMatchObject({ code: 'upstream_failed' })
    }
    expect(isolatedInferenceUsage(service).callsToday).toBe(3)
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'over', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'budget_exhausted', status: 429 })
    // the refused call never reached the network
    expect(spy).toHaveBeenCalledTimes(3)
  })
})

/* ------------------------------------------------- prompt cache accounting -- */

/**
 * Repro of the live finding of 30.09.2026: an input of 588 characters was
 * audited as 4 input tokens because the provider served the prompt from the
 * cache and only `usage.input` was recorded.
 */
describe('input token accounting with prompt caching', () => {
  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-cache-'))
    process.env.DATA_DIR = dataDir
    resetIsolatedInferenceState()
    writeServiceRegistry()
    configureAnthropic()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('counts cacheRead and cacheWrite as input tokens instead of reporting 4', async () => {
    const cached = {
      role: 'assistant',
      content: [{ type: 'text', text: '{"nextQuestion":"Und dann?","done":false}' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      usage: { input: 4, output: 120, cacheRead: 1401, cacheWrite: 96, totalTokens: 1621, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    const audits: { inputTokens?: number }[] = []
    const result = await runIsolatedInference(service, {
      profile: 'interview.v1', input: 'x'.repeat(588), maxOutputTokens: 200,
    }, {
      complete: async () => cached as never,
      audit: entry => audits.push(entry as never),
    })
    expect(result.usage).toEqual({ inputTokens: 4 + 1401 + 96, outputTokens: 120 })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.inputTokens).toBe(1501)
  })
})
