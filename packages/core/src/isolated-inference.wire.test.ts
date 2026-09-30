/**
 * Wire level integration for the isolated inference path: the production
 * resolution (providers.json -> data-policy gate -> buildModel ->
 * completeSimple) runs unchanged, only the network is a controlled fake.
 * No billable call happens here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { saveProviders } from './provider-config.js'
import {
  ISOLATED_INFERENCE_PROFILES,
  resetIsolatedInferenceState,
  runIsolatedInference,
  type IsolatedInferenceService,
} from './isolated-inference.js'

const TOKEN = 'synthetic-wire-token-0002'
const service: IsolatedInferenceService = {
  id: 'wire-service',
  tokenSha256: createHash('sha256').update(TOKEN).digest('hex'),
  profiles: ['interview.v1'],
  maxConcurrent: 1,
  dailyCallBudget: 10,
  expiresAt: '',
  revoked: false,
}

let dataDir = ''
let previousDataDir: string | undefined

/**
 * The service registry as production has it: the run path re-reads this file
 * before every provider call to honour a revoke, so the wire test writes a real
 * one instead of bypassing that check with a seam.
 */
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

function writeSettings(privacy: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'config', 'settings.json'), JSON.stringify({ privacy }), 'utf-8')
}

function configureAnthropic(dataPolicy?: Record<string, unknown>): void {
  saveProviders({
    providers: [{
      id: 'anth', name: 'Anthropic', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1', apiKey: 'synthetic-not-a-real-key',
      enabledModels: ['claude-sonnet-5-5'],
      ...(dataPolicy ? { dataPolicy } : {}),
    }],
    activeProvider: 'anth', activeModel: 'claude-sonnet-5-5',
  } as never)
}

/** Minimal Anthropic messages SSE stream carrying one text block. */
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

describe('isolated inference over the real provider client', () => {
  beforeEach(() => {
    previousDataDir = process.env.DATA_DIR
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-wire-'))
    process.env.DATA_DIR = dataDir
    resetIsolatedInferenceState()
    writeServiceRegistry()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('refuses the call when the registry revoked the service, without touching the network', async () => {
    configureAnthropic()
    writeServiceRegistry({ revoked: true })
    const fetchSpy = vi.fn(async () => sseResponse('{"x":1}'))
    vi.stubGlobal('fetch', fetchSpy)
    await expect(runIsolatedInference(service, {
      profile: 'interview.v1', input: 'synthetic', maxOutputTokens: 100,
    })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends the server side system prompt, the capped max_tokens, no temperature, no thinking and no tools', async () => {
    configureAnthropic()
    let captured: Record<string, unknown> | undefined
    let capturedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
      capturedUrl = String(url)
      captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      return sseResponse('{"nextQuestion":"Und dann?","done":false}')
    }))

    const result = await runIsolatedInference(service, {
      profile: 'interview.v1',
      input: 'AUFGABE: eine Frage. DATEN: synthetisch.',
      maxOutputTokens: 900,
    })

    expect(result.contract).toBe('isolated-inference.v1')
    expect(result.json).toEqual({ nextQuestion: 'Und dann?', done: false })
    expect(result.usage.outputTokens).toBeGreaterThan(0)
    // The preset pins the Anthropic messages endpoint; the caller has no way
    // to point this anywhere else.
    expect(capturedUrl).toContain('https://api.anthropic.com/v1/messages')
    expect(captured).toBeDefined()
    expect(captured!.model).toBe('claude-sonnet-5-5')
    expect(captured!.max_tokens).toBe(900)
    expect(captured).not.toHaveProperty('temperature')
    expect(captured!.thinking).toBeUndefined()
    expect(captured!.tools).toBeUndefined()
    const system = JSON.stringify(captured!.system)
    expect(system).toContain('stateless JSON inference endpoint')
    expect(JSON.stringify(captured!.messages)).toContain('AUFGABE: eine Frage')
  })

  it('fails closed when the profile model is not configured at all', async () => {
    saveProviders({ providers: [], activeProvider: '', activeModel: '' } as never)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'x', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'model_not_available', status: 503 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses the call when the data policy blocks the provider (enforce mode)', async () => {
    configureAnthropic({ region: 'cn', training: 'unknown' })
    writeSettings({ modelGate: 'enforce' })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(runIsolatedInference(service, { profile: 'interview.v1', input: 'x', maxOutputTokens: 100 }))
      .rejects.toMatchObject({ code: 'model_blocked_by_policy', status: 503 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps the profile ceiling even when the model would allow far more', () => {
    expect(ISOLATED_INFERENCE_PROFILES['interview.v1'].maxOutputTokens).toBeLessThanOrEqual(2000)
  })
})
