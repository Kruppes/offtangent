import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  ISOLATED_INFERENCE_CONTRACT,
  ISOLATED_INFERENCE_PROFILES,
  IsolatedInferenceError,
  authenticateIsolatedService,
  isIsolatedServiceStillValid,
  isolatedInferenceAuditPath,
  isolatedInferenceUsage,
  isolatedInferenceUsagePath,
  loadIsolatedInferenceConfig,
  parseIsolatedRequest,
  parseModelJson,
  resetIsolatedInferenceState,
  runIsolatedInference,
  type IsolatedCompletion,
  type IsolatedInferenceAuditEntry,
  type IsolatedInferenceService,
} from './isolated-inference.js'

const TOKEN = 'synthetic-service-token-for-tests-0001'
const TOKEN_SHA = createHash('sha256').update(TOKEN, 'utf8').digest('hex')
const shaOf = (suffix: string): string => createHash('sha256').update(`${TOKEN}-${suffix}`, 'utf8').digest('hex')

function service(overrides: Partial<IsolatedInferenceService> = {}): IsolatedInferenceService {
  return {
    id: 'test-service',
    tokenSha256: TOKEN_SHA,
    profiles: ['interview.v1'],
    maxConcurrent: 2,
    dailyCallBudget: 5,
    expiresAt: '',
    revoked: false,
    ...overrides,
  }
}

function assistant(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    usage: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, totalTokens: 33, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage
}

const okJson = '{"nextQuestion":"Was tut Ihr Team zuerst?","done":false}'

describe('isolated inference config', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-inf-'))
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    previous = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    resetIsolatedInferenceState()
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(body: unknown): void {
    fs.writeFileSync(path.join(dir, 'config', 'isolated-inference.json'), JSON.stringify(body))
  }

  it('is off when the config file is absent', () => {
    expect(loadIsolatedInferenceConfig()).toEqual({ enabled: false, services: [] })
  })

  it('is off when the file is malformed', () => {
    fs.writeFileSync(path.join(dir, 'config', 'isolated-inference.json'), '{ not json')
    expect(loadIsolatedInferenceConfig().enabled).toBe(false)
  })

  it('is off without the explicit enabled flag', () => {
    writeConfig({ services: [{ id: 'a', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'] }] })
    expect(loadIsolatedInferenceConfig().enabled).toBe(false)
  })

  it('drops entries without a sha256 token, without a known profile or with an unknown profile only', () => {
    writeConfig({
      enabled: true,
      services: [
        { id: 'plain-token', tokenSha256: 'not-a-hash', profiles: ['interview.v1'] },
        { id: 'no-profile', tokenSha256: TOKEN_SHA, profiles: [] },
        { id: 'unknown-profile', tokenSha256: TOKEN_SHA, profiles: ['agent.v1'] },
      ],
    })
    expect(loadIsolatedInferenceConfig()).toEqual({ enabled: false, services: [] })
  })

  it('clamps concurrency and budget and keeps only the hash', () => {
    writeConfig({ enabled: true, services: [{ id: 'svc', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'], maxConcurrent: 999, dailyCallBudget: 0 }] })
    const config = loadIsolatedInferenceConfig()
    expect(config.services).toHaveLength(1)
    expect(config.services[0].maxConcurrent).toBe(8)
    expect(config.services[0].dailyCallBudget).toBe(100)
    expect(JSON.stringify(config)).not.toContain(TOKEN)
  })

  it('keeps an optional providerId reference, trimmed, and treats an empty one as absent', () => {
    writeConfig({
      enabled: true,
      services: [
        { id: 'svc-a', tokenSha256: shaOf('a'), profiles: ['interview.v1'], providerId: '  prov-b  ' },
        { id: 'svc-b', tokenSha256: shaOf('b'), profiles: ['interview.v1'], providerId: '   ' },
        { id: 'svc-c', tokenSha256: shaOf('c'), profiles: ['interview.v1'] },
      ],
    })
    const services = loadIsolatedInferenceConfig().services
    expect(services.map(s => s.id)).toEqual(['svc-a', 'svc-b', 'svc-c'])
    expect(services[0].providerId).toBe('prov-b')
    expect(services[1]).not.toHaveProperty('providerId')
    expect(services[2]).not.toHaveProperty('providerId')
  })

  it('drops an entry whose providerId is not a string instead of falling back to the global provider', () => {
    writeConfig({
      enabled: true,
      services: [
        { id: 'svc-a', tokenSha256: shaOf('a'), profiles: ['interview.v1'], providerId: 42 },
        { id: 'svc-b', tokenSha256: shaOf('b'), profiles: ['interview.v1'], providerId: { id: 'prov-b' } },
        { id: 'svc-c', tokenSha256: shaOf('c'), profiles: ['interview.v1'] },
      ],
    })
    expect(loadIsolatedInferenceConfig().services.map(s => s.id)).toEqual(['svc-c'])
  })

  it('authenticates only the configured token', () => {
    writeConfig({ enabled: true, services: [{ id: 'svc', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'] }] })
    const config = loadIsolatedInferenceConfig()
    expect(authenticateIsolatedService(TOKEN, config)?.id).toBe('svc')
    expect(authenticateIsolatedService(`${TOKEN}x`, config)).toBeNull()
    expect(authenticateIsolatedService('', config)).toBeNull()
    expect(authenticateIsolatedService(TOKEN_SHA, config)).toBeNull()
    expect(authenticateIsolatedService(null, config)).toBeNull()
  })

  it('never authenticates while disabled', () => {
    expect(authenticateIsolatedService(TOKEN, { enabled: false, services: [service()] })).toBeNull()
  })
})

describe('request validation', () => {
  beforeEach(() => resetIsolatedInferenceState())

  it('accepts exactly profile, input and maxOutputTokens', () => {
    const parsed = parseIsolatedRequest({ profile: 'interview.v1', input: 'hallo', maxOutputTokens: 900 }, service())
    expect(parsed).toEqual({ profile: 'interview.v1', input: 'hallo', maxOutputTokens: 900 })
  })

  for (const field of ['system', 'model', 'tools', 'tool_choice', 'temperature', 'thinking', 'messages', 'provider', 'baseUrl']) {
    it(`rejects the field ${field}`, () => {
      const body: Record<string, unknown> = { profile: 'interview.v1', input: 'hallo', maxOutputTokens: 100 }
      body[field] = field === 'temperature' ? 0.2 : 'x'
      try {
        parseIsolatedRequest(body, service())
        throw new Error('expected rejection')
      } catch (err) {
        expect(err).toBeInstanceOf(IsolatedInferenceError)
        expect((err as IsolatedInferenceError).code).toBe('unknown_field')
        expect((err as IsolatedInferenceError).status).toBe(400)
      }
    })
  }

  it('rejects an unknown profile and a profile the service does not have', () => {
    expect(() => parseIsolatedRequest({ profile: 'agent.v1', input: 'x' }, service()))
      .toThrowError(/profile not available/)
    expect(() => parseIsolatedRequest({ profile: 'interview.v1', input: 'x' }, service({ profiles: ['interview.v1'] })))
      .not.toThrow()
    expect(() => parseIsolatedRequest({ profile: 'interview.v1', input: 'x' }, service({ profiles: ['other.v1'] })))
      .toThrowError(/profile not available/)
  })

  it('clamps maxOutputTokens to the profile ceiling', () => {
    const parsed = parseIsolatedRequest({ profile: 'interview.v1', input: 'x', maxOutputTokens: 999_999 }, service())
    expect(parsed.maxOutputTokens).toBe(ISOLATED_INFERENCE_PROFILES['interview.v1'].maxOutputTokens)
  })

  it('rejects an empty input and an oversized input', () => {
    expect(() => parseIsolatedRequest({ profile: 'interview.v1', input: '   ' }, service())).toThrowError(/non-empty/)
    const tooLong = 'a'.repeat(ISOLATED_INFERENCE_PROFILES['interview.v1'].maxInputChars + 1)
    try {
      parseIsolatedRequest({ profile: 'interview.v1', input: tooLong }, service())
      throw new Error('expected rejection')
    } catch (err) {
      expect((err as IsolatedInferenceError).code).toBe('input_too_large')
      expect((err as IsolatedInferenceError).status).toBe(413)
    }
  })

  it('rejects a non-object body', () => {
    expect(() => parseIsolatedRequest('x', service())).toThrowError(/JSON object/)
    expect(() => parseIsolatedRequest([{ profile: 'interview.v1' }], service())).toThrowError(/JSON object/)
  })
})

describe('the model call', () => {
  beforeEach(() => resetIsolatedInferenceState())

  const request = { profile: 'interview.v1', input: 'ZUSTAND: x', maxOutputTokens: 900 }
  const resolved = {
    model: { id: 'claude-sonnet-5-5', provider: 'anthropic-test' },
    apiKey: 'no-key',
    providerId: 'anthropic-test',
    modelId: 'claude-sonnet-5-5',
  }

  function runWithFakeModel(complete: IsolatedCompletion, svc = service(), idempotencyKey?: string) {
    return runIsolatedInference(svc, request, {
      complete,
      idempotencyKey,
      resolveModel: async () => resolved as never,
      // These cases exercise request shape, limits and idempotency. The live
      // revocation re-check has its own suite ("service credential lifecycle")
      // and is fail-closed by default in production, where the route passes
      // no seam at all.
      stillValid: () => true,
      audit: () => {},
    })
  }

  it('passes the server side system prompt and never a temperature or a disabled thinking block', async () => {
    const seen: unknown[] = []
    const result = await runWithFakeModel(async input => {
      seen.push(input)
      return assistant(okJson)
    })
    expect(result.contract).toBe(ISOLATED_INFERENCE_CONTRACT)
    expect(result.json).toEqual({ nextQuestion: 'Was tut Ihr Team zuerst?', done: false })
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 })
    const call = seen[0] as Record<string, unknown>
    expect(call.systemPrompt).toBe(ISOLATED_INFERENCE_PROFILES['interview.v1'].systemPrompt)
    expect(call.input).toBe(request.input)
    expect(call.maxOutputTokens).toBe(900)
    expect(call).not.toHaveProperty('temperature')
    expect(call).not.toHaveProperty('thinking')
    expect(call).not.toHaveProperty('tools')
  })

  it('turns a provider error into upstream_failed without the provider message', async () => {
    await expect(runWithFakeModel(async () => {
      throw new Error('401 from https://api.example.com with key sk-live-abc')
    })).rejects.toMatchObject({ code: 'upstream_failed', status: 502, message: 'inference failed' })
  })

  it('turns an error stopReason into upstream_failed', async () => {
    await expect(runWithFakeModel(async () => assistant('', 'error')))
      .rejects.toMatchObject({ code: 'upstream_failed' })
  })

  it('rejects non-JSON model output', async () => {
    await expect(runWithFakeModel(async () => assistant('Sure! Here is the answer.')))
      .rejects.toMatchObject({ code: 'bad_model_output', status: 502 })
  })

  it('enforces the daily budget and counts every call', async () => {
    const svc = service({ dailyCallBudget: 2 })
    const complete = async () => assistant(okJson)
    await runWithFakeModel(complete, svc)
    await runWithFakeModel(complete, svc)
    expect(isolatedInferenceUsage(svc).callsToday).toBe(2)
    await expect(runWithFakeModel(complete, svc)).rejects.toMatchObject({ code: 'budget_exhausted', status: 429 })
  })

  it('enforces the concurrency limit and releases the slot afterwards', async () => {
    const svc = service({ maxConcurrent: 1 })
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocked = runWithFakeModel(async () => {
      await gate
      return assistant(okJson)
    }, svc)
    await vi.waitFor(() => expect(isolatedInferenceUsage(svc).inFlight).toBe(1))
    await expect(runWithFakeModel(async () => assistant(okJson), svc)).rejects.toMatchObject({ code: 'busy', status: 429 })
    release()
    await blocked
    expect(isolatedInferenceUsage(svc).inFlight).toBe(0)
  })

  it('does not pay twice for the same idempotency key', async () => {
    const svc = service()
    let calls = 0
    const complete = async () => { calls += 1; return assistant(okJson) }
    const first = await runWithFakeModel(complete, svc, 'idem-turn-7')
    const second = await runWithFakeModel(complete, svc, 'idem-turn-7')
    expect(calls).toBe(1)
    expect(second).toEqual(first)
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
  })

  it('lets a failed idempotent call be retried', async () => {
    const svc = service()
    let calls = 0
    const complete = async () => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return assistant(okJson)
    }
    await expect(runWithFakeModel(complete, svc, 'idem-turn-8')).rejects.toMatchObject({ code: 'upstream_failed' })
    await expect(runWithFakeModel(complete, svc, 'idem-turn-8')).resolves.toMatchObject({ contract: ISOLATED_INFERENCE_CONTRACT })
    expect(calls).toBe(2)
  })
})

describe('model json parsing', () => {
  it('accepts a fenced object', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('rejects an array, a scalar and malformed json', () => {
    expect(() => parseModelJson('[1,2]')).toThrowError(/JSON/)
    expect(() => parseModelJson('42')).toThrowError(/JSON/)
    expect(() => parseModelJson('{"a":')).toThrowError(/JSON/)
  })
})

describe('the module stays free of agent surface', () => {
  it('imports no agent, memory, chat, strand, connector, tool or database module', () => {
    const source = fs.readFileSync(new URL('./isolated-inference.ts', import.meta.url), 'utf-8')
    const imports = [...source.matchAll(/from '(\.[^']+)'/g)].map(m => m[1])
    expect(imports.sort()).toEqual([
      './config.js',
      './data-policy.js',
      './pi-models.js',
      './provider-config.js',
    ])
    for (const forbidden of ['agent', 'memory', 'database', 'chat', 'strand', 'connector', 'tool', 'persona', 'skill']) {
      expect(imports.some(i => i.includes(forbidden))).toBe(false)
    }
  })
})


/* ------------------------------------------------- token lifecycle (maintainer) */

describe('service credential lifecycle', () => {
  const resolveModel = async () => ({
    model: { id: 'claude-sonnet-5-5' } as never,
    apiKey: 'synthetic',
    providerId: 'anthropic',
    modelId: 'claude-sonnet-5-5',
  })

  beforeEach(() => resetIsolatedInferenceState())

  it('refuses a missing, wrong, revoked and expired credential the same way', () => {
    const config = {
      enabled: true,
      services: [
        service({ id: 'live' }),
        service({ id: 'dead', tokenSha256: createHash('sha256').update('revoked-token-xyz', 'utf8').digest('hex'), revoked: true }),
        service({ id: 'old', tokenSha256: createHash('sha256').update('expired-token-xyz', 'utf8').digest('hex'), expiresAt: '2020-01-01T00:00:00.000Z' }),
      ],
    }
    expect(authenticateIsolatedService(TOKEN, config)?.id).toBe('live')
    expect(authenticateIsolatedService(null, config)).toBeNull()
    expect(authenticateIsolatedService('unknown-token', config)).toBeNull()
    expect(authenticateIsolatedService('revoked-token-xyz', config)).toBeNull()
    expect(authenticateIsolatedService('expired-token-xyz', config)).toBeNull()
  })

  it('treats an unparseable expiry as expired, not as unlimited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-exp-'))
    const previous = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    try {
      fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'config', 'isolated-inference.json'), JSON.stringify({
        enabled: true,
        services: [{ id: 'svc', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'], expiresAt: 'whenever' }],
      }))
      const loaded = loadIsolatedInferenceConfig()
      expect(loaded.services[0]?.expiresAt).toBe('1970-01-01T00:00:00.000Z')
      expect(authenticateIsolatedService(TOKEN, loaded)).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previous
    }
  })

  it('honours an expiry boundary exactly', () => {
    const svc = service({ expiresAt: '2026-01-01T00:00:00.000Z' })
    const config = { enabled: true, services: [svc] }
    expect(authenticateIsolatedService(TOKEN, config, Date.parse('2025-12-31T23:59:59Z'))?.id).toBe('test-service')
    expect(authenticateIsolatedService(TOKEN, config, Date.parse('2026-01-01T00:00:00Z'))).toBeNull()
  })

  it('re-checks the credential before the provider call and spends nothing when it was revoked meanwhile', async () => {
    const svc = service()
    let called = 0
    const complete: IsolatedCompletion = async () => { called += 1; return assistant(okJson) }
    const audits: IsolatedInferenceAuditEntry[] = []
    await expect(runIsolatedInference(svc, { profile: 'interview.v1', input: 'x', maxOutputTokens: 100 }, {
      complete, resolveModel, stillValid: () => false, audit: entry => audits.push(entry),
    })).rejects.toMatchObject({ code: 'unauthorized' })
    expect(called).toBe(0)
    expect(isolatedInferenceUsage(svc).callsToday).toBe(0)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ status: 'error', code: 'unauthorized', serviceId: 'test-service', profile: 'interview.v1' })
  })

  it('reads the revocation from the live config, not from a cached copy', () => {
    const svc = service()
    expect(isIsolatedServiceStillValid(svc, { enabled: true, services: [service()] })).toBe(true)
    expect(isIsolatedServiceStillValid(svc, { enabled: true, services: [service({ revoked: true })] })).toBe(false)
    expect(isIsolatedServiceStillValid(svc, { enabled: true, services: [] })).toBe(false)
    expect(isIsolatedServiceStillValid(svc, { enabled: false, services: [service()] })).toBe(false)
    expect(isIsolatedServiceStillValid(svc, { enabled: true, services: [service({ expiresAt: '2020-01-01T00:00:00.000Z' })] })).toBe(false)
  })

  it('writes one audit line per request with token id, request id, profile, model, status and usage — and no prompt', async () => {
    const audits: IsolatedInferenceAuditEntry[] = []
    const result = await runIsolatedInference(service(), { profile: 'interview.v1', input: 'secret business detail 42', maxOutputTokens: 100 }, {
      complete: async () => assistant(okJson), resolveModel, stillValid: () => true, audit: entry => audits.push(entry), requestId: 'req-1',
    })
    expect(result.contract).toBe(ISOLATED_INFERENCE_CONTRACT)
    expect(audits).toHaveLength(1)
    const entry = audits[0]!
    expect(entry).toMatchObject({
      requestId: 'req-1', serviceId: 'test-service', profile: 'interview.v1',
      model: 'anthropic/claude-sonnet-5-5', status: 'ok', code: 'ok',
      inputTokens: 11, outputTokens: 22, inputChars: 25,
    })
    const line = JSON.stringify(entry)
    expect(line).not.toContain('secret business detail')
    expect(line).not.toContain(TOKEN)
    expect(line).not.toContain(TOKEN_SHA)
    expect(line).not.toContain('nextQuestion')
  })

  it('audits budget and upstream failures too', async () => {
    const audits: IsolatedInferenceAuditEntry[] = []
    const svc = service({ dailyCallBudget: 1 })
    await runIsolatedInference(svc, { profile: 'interview.v1', input: 'a', maxOutputTokens: 50 }, {
      complete: async () => assistant(okJson), resolveModel, stillValid: () => true, audit: e => audits.push(e),
    })
    await expect(runIsolatedInference(svc, { profile: 'interview.v1', input: 'a', maxOutputTokens: 50 }, {
      complete: async () => assistant(okJson), resolveModel, stillValid: () => true, audit: e => audits.push(e),
    })).rejects.toMatchObject({ code: 'budget_exhausted' })
    await expect(runIsolatedInference(service({ id: 'other' }), { profile: 'interview.v1', input: 'a', maxOutputTokens: 50 }, {
      complete: async () => { throw new Error('provider exploded with key sk-live-123') }, resolveModel, stillValid: () => true, audit: e => audits.push(e),
    })).rejects.toMatchObject({ code: 'upstream_failed' })
    expect(audits.map(e => e.code)).toEqual(['ok', 'budget_exhausted', 'upstream_failed'])
    expect(JSON.stringify(audits)).not.toContain('sk-live-123')
  })

  it('puts the audit file under DATA_DIR/logs and never into the config dir', () => {
    const previous = process.env.DATA_DIR
    process.env.DATA_DIR = '/tmp/iso-audit-path'
    try {
      expect(isolatedInferenceAuditPath()).toBe('/tmp/iso-audit-path/logs/isolated-inference.audit.jsonl')
    } finally {
      if (previous === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previous
    }
  })
})

/**
 * Regression suite for the adversarial review of 2026-09-30 (findings 1, 2, 4,
 * 5 plus "daily budget across a restart"). Every test here fails on the state
 * before the fix; all fixtures are synthetic.
 */
describe('cost brake, profile registry and idempotency (review regressions)', () => {
  let dir: string
  let previousDataDir: string | undefined

  const request = { profile: 'interview.v1', input: 'ZUSTAND: x', maxOutputTokens: 900 }
  const resolved = {
    model: { id: 'claude-sonnet-5-5', provider: 'anthropic-test' },
    apiKey: 'no-key',
    providerId: 'anthropic-test',
    modelId: 'claude-sonnet-5-5',
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-cost-'))
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    previousDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = dir
    resetIsolatedInferenceState()
  })

  afterEach(() => {
    resetIsolatedInferenceState()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function run(
    svc: IsolatedInferenceService,
    complete: IsolatedCompletion,
    extra: { idempotencyKey?: string; resolveModel?: () => Promise<never>; body?: typeof request } = {},
  ) {
    return runIsolatedInference(svc, extra.body ?? request, {
      complete,
      idempotencyKey: extra.idempotencyKey,
      resolveModel: extra.resolveModel ?? (async () => resolved as never),
      stillValid: () => true,
      audit: () => {},
    })
  }

  it('keeps the daily budget and the concurrency limit under parallel load', async () => {
    // Finding 1: the guard read the counters, then awaited the provider
    // resolution, then incremented — so N parallel calls all passed a budget
    // of 1. The model resolution here yields the event loop, exactly like
    // `resolveProfileModel` does in production (decrypt + getApiKeyForProvider).
    const svc = service({ maxConcurrent: 1, dailyCallBudget: 1 })
    let providerCalls = 0
    const complete: IsolatedCompletion = async () => {
      providerCalls += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return assistant(okJson)
    }
    const slowResolve = async () => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return resolved as never
    }
    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, () => runIsolatedInference(svc, request, {
        complete,
        resolveModel: slowResolve,
        stillValid: () => true,
        audit: () => {},
      })),
    )
    const ok = settled.filter(entry => entry.status === 'fulfilled').length
    const refused = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
      .map(entry => (entry.reason as IsolatedInferenceError).code)
    expect(providerCalls).toBe(1)
    expect(ok).toBe(1)
    expect(refused).toHaveLength(7)
    expect(refused.every(code => code === 'busy' || code === 'budget_exhausted')).toBe(true)
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
    expect(isolatedInferenceUsage(svc).inFlight).toBe(0)
  })

  it('keeps the spent daily budget across a process restart', async () => {
    const svc = service({ dailyCallBudget: 1 })
    await run(svc, async () => assistant(okJson))
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
    expect(fs.existsSync(isolatedInferenceUsagePath())).toBe(true)
    // A restart loses the in-memory counters but must not hand out a new budget.
    resetIsolatedInferenceState({ keepPersistedUsage: true })
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
    await expect(run(svc, async () => assistant(okJson)))
      .rejects.toMatchObject({ code: 'budget_exhausted', status: 429 })
  })

  it('writes no prompt and no token into the persisted usage file', async () => {
    const svc = service({ dailyCallBudget: 3 })
    await run(svc, async () => assistant(okJson))
    const raw = fs.readFileSync(isolatedInferenceUsagePath(), 'utf-8')
    expect(raw).not.toContain(request.input)
    expect(raw).not.toContain(TOKEN)
    expect(raw).not.toContain(TOKEN_SHA)
    expect(JSON.parse(raw)).toEqual({ version: 1, services: { 'test-service': { day: expect.any(String), calls: 1 } } })
  })

  it('does not charge the budget for a call that never reached the provider', async () => {
    const svc = service({ dailyCallBudget: 1 })
    await expect(run(svc, async () => assistant(okJson), {
      resolveModel: async () => { throw new IsolatedInferenceError('model_blocked_by_policy', 503, 'blocked') },
    })).rejects.toMatchObject({ code: 'model_blocked_by_policy' })
    expect(isolatedInferenceUsage(svc).callsToday).toBe(0)
    await expect(run(svc, async () => assistant(okJson))).resolves.toMatchObject({ contract: ISOLATED_INFERENCE_CONTRACT })
  })

  it('treats a prototype chain name as an unknown profile', () => {
    // Finding 2: `'constructor' in ISOLATED_INFERENCE_PROFILES` was true, so a
    // config with only bogus profiles was accepted (fail open) and both profile
    // ceilings became undefined.
    fs.writeFileSync(
      path.join(dir, 'config', 'isolated-inference.json'),
      JSON.stringify({
        enabled: true,
        services: [{ id: 'svc', tokenSha256: TOKEN_SHA, profiles: ['constructor', 'toString', '__proto__'] }],
      }),
    )
    expect(loadIsolatedInferenceConfig()).toEqual({ enabled: false, services: [] })
    for (const name of ['constructor', 'toString', '__proto__', 'valueOf']) {
      expect(() => parseIsolatedRequest(
        { profile: name, input: 'x' },
        service({ profiles: [name] }),
      )).toThrowError(/profile not available/)
    }
  })

  it('binds the idempotency key to the request body', async () => {
    // Finding 4: the cache key was `service:key`, so a reused key served the
    // answer of another interview.
    const svc = service({ dailyCallBudget: 5 })
    const IDEM_KEY = 'idem-turn-7'
    const answers = ['{"answer":"A"}', '{"answer":"B"}']
    let calls = 0
    const complete: IsolatedCompletion = async () => assistant(answers[calls++] ?? '{"answer":"X"}')
    const first = await run(svc, complete, { idempotencyKey: IDEM_KEY })
    const second = await run(svc, complete, {
      idempotencyKey: IDEM_KEY,
      body: { ...request, input: 'ZUSTAND: a completely different interview' },
    })
    expect(first.json).toEqual({ answer: 'A' })
    expect(second.json).toEqual({ answer: 'B' })
    // The unchanged body still joins the first call, so a retry is still free.
    const retry = await run(svc, complete, { idempotencyKey: IDEM_KEY })
    expect(retry.json).toEqual({ answer: 'A' })
    expect(calls).toBe(2)
  })

  it('does not let a call in flight over midnight wipe the new day (review 2)', async () => {
    // Second review, BLOCKER 1: the release path used `usageOf(id, now)`, whose
    // day rollover set `calls = 0`. A call started at 23:59 and released after
    // midnight therefore handed the whole new day's budget back.
    const svc = service({ maxConcurrent: 2, dailyCallBudget: 2 })
    const dayA = Date.parse('2026-09-30T23:59:30.000Z')
    const dayB = Date.parse('2026-10-01T00:00:30.000Z')
    let releaseStraggler = (): void => {}
    const straggler = runIsolatedInference(svc, request, {
      now: dayA,
      complete: async () => {
        await new Promise<void>(resolve => { releaseStraggler = resolve })
        return assistant(okJson)
      },
      resolveModel: async () => resolved as never,
      stillValid: () => true,
      audit: () => {},
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    // Burn the whole budget of day B.
    for (let i = 0; i < 2; i += 1) {
      await runIsolatedInference(svc, request, {
        now: dayB, complete: async () => assistant(okJson),
        resolveModel: async () => resolved as never, stillValid: () => true, audit: () => {},
      })
    }
    expect(isolatedInferenceUsage(svc, dayB).callsToday).toBe(2)
    releaseStraggler()
    await straggler
    // The straggler belongs to day A; day B stays spent.
    expect(isolatedInferenceUsage(svc, dayB).callsToday).toBe(2)
    await expect(runIsolatedInference(svc, request, {
      now: dayB, complete: async () => assistant(okJson),
      resolveModel: async () => resolved as never, stillValid: () => true, audit: () => {},
    })).rejects.toMatchObject({ code: 'budget_exhausted' })
    expect(JSON.parse(fs.readFileSync(isolatedInferenceUsagePath(), 'utf-8')))
      .toEqual({ version: 1, services: { 'test-service': { day: '2026-10-01', calls: 2 } } })
  })

  it('bounds how many refunded failures one service gets per day (review 2)', async () => {
    // Second review, SHOULD-FIX 2: a refunded failure cost no budget at all, so
    // a service with an unconfigured or policy blocked profile model was an
    // unlimited authenticated request generator with two sync disk writes each.
    const svc = service({ dailyCallBudget: 2 })
    const codes: string[] = []
    for (let i = 0; i < 40; i += 1) {
      const err: unknown = await run(svc, async () => assistant(okJson), {
        resolveModel: async () => { throw new IsolatedInferenceError('model_not_available', 503, 'no model') },
      }).then(() => null, (e: unknown) => e)
      codes.push((err as IsolatedInferenceError).code)
    }
    // The first failures are free (that is the point), then the budget applies.
    expect(codes[0]).toBe('model_not_available')
    expect(codes.at(-1)).toBe('budget_exhausted')
    expect(codes.filter(code => code === 'budget_exhausted').length).toBeGreaterThan(10)
    expect(isolatedInferenceUsage(svc).callsToday).toBe(2)
  })

  it('takes the higher count when another writer persisted more calls (review 2)', async () => {
    // Second review, SHOULD-FIX 4: the file was rewritten from one process's
    // memory, so two writers on the same DATA_DIR each handed out a full budget.
    const svc = service({ dailyCallBudget: 2 })
    await run(svc, async () => assistant(okJson))
    expect(isolatedInferenceUsage(svc).callsToday).toBe(1)
    const file = isolatedInferenceUsagePath()
    const state = JSON.parse(fs.readFileSync(file, 'utf-8')) as { services: Record<string, { day: string; calls: number }> }
    // Another process spent the rest of the budget.
    state.services['test-service'].calls = 2
    fs.writeFileSync(file, JSON.stringify(state))
    await expect(run(svc, async () => assistant(okJson)))
      .rejects.toMatchObject({ code: 'budget_exhausted' })
  })

  it('keeps a rotated token from joining a pre-rotation idempotent answer (review 2)', async () => {
    const svc = service({ dailyCallBudget: 5 })
    const rotated = service({ dailyCallBudget: 5, tokenSha256: `${'a'.repeat(63)}1` })
    let calls = 0
    const complete: IsolatedCompletion = async () => assistant(`{"answer":"${++calls}"}`)
    const first = await run(svc, complete, { idempotencyKey: 'idem-rotate-1' })
    const second = await run(rotated, complete, { idempotencyKey: 'idem-rotate-1' })
    expect(first.json).toEqual({ answer: '1' })
    expect(second.json).toEqual({ answer: '2' })
  })

  it('clamps maxOutputTokens up and down', () => {
    const svc = service()
    expect(parseIsolatedRequest({ profile: 'interview.v1', input: 'x', maxOutputTokens: 0.5 }, svc).maxOutputTokens).toBe(1)
    expect(parseIsolatedRequest({ profile: 'interview.v1', input: 'x', maxOutputTokens: 1e9 }, svc).maxOutputTokens)
      .toBe(ISOLATED_INFERENCE_PROFILES['interview.v1'].maxOutputTokens)
  })

  it('re-reads the config when it changes, so a revoke is never cached away', () => {
    const file = path.join(dir, 'config', 'isolated-inference.json')
    const entry = { id: 'svc', tokenSha256: TOKEN_SHA, profiles: ['interview.v1'] }
    fs.writeFileSync(file, JSON.stringify({ enabled: true, services: [entry] }))
    expect(authenticateIsolatedService(TOKEN, loadIsolatedInferenceConfig())).toMatchObject({ id: 'svc' })
    fs.writeFileSync(file, JSON.stringify({ enabled: true, services: [{ ...entry, revoked: true }] }))
    expect(authenticateIsolatedService(TOKEN, loadIsolatedInferenceConfig())).toBeNull()
  })
})
