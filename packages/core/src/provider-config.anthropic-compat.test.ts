/**
 * Claude Sonnet 5.5 rejects `thinking: { type: "disabled" }` and rejects the
 * `temperature` field. The api-key (`anthropic`) provider type takes the
 * generic build path in `buildModel()`, which does not consult the pi-ai
 * catalog, so every wire quirk has to come from our own override. Since pi-ai
 * 0.99.0 the pinned catalog carries Sonnet 5.5 itself, and the subscription
 * (`anthropic-oauth`) provider type resolves the model from that catalog entry
 * (same path as Claude Opus 5.5) with our wire override (thinking map + compat)
 * layered on top, so both provider types must stay correct.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildModel,
  getAvailableModels,
  loadProviders,
  syncNewCatalogModels,
  type ProviderConfig,
} from './provider-config.js'
import { completeSimple } from './pi-models.js'

const SONNET_55 = 'claude-sonnet-5-5'

function anthropicProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anth-test',
    name: 'Anthropic',
    type: 'anthropic-messages',
    providerType: 'anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-test',
    enabledModels: [SONNET_55],
    ...overrides,
  } as ProviderConfig
}

describe('buildModel for Claude Sonnet 5.5', () => {
  for (const providerType of ['anthropic', 'anthropic-oauth'] as const) {
    it(`carries the full catalog metadata on providerType ${providerType}`, () => {
      const model = buildModel(anthropicProvider({ providerType }), SONNET_55)
      expect(model.id).toBe(SONNET_55)
      expect(model.name).toBe('Claude Sonnet 5.5')
      expect(model.reasoning).toBe(true)
      expect(model.contextWindow).toBe(1_000_000)
      expect(model.maxTokens).toBe(128_000)
      expect(model.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.50 })
    })

    it(`maps thinking levels so an "off" request omits thinking on providerType ${providerType}`, () => {
      const model = buildModel(anthropicProvider({ providerType }), SONNET_55)
      // Upstream rejects `thinking.type: "disabled"` for this model, so `off`
      // and `minimal` must map to null (no thinking field at all).
      expect(model.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      })
    })

    it(`passes the wire compat flags through on providerType ${providerType}`, () => {
      const model = buildModel(anthropicProvider({ providerType }), SONNET_55)
      expect(model.compat).toMatchObject({
        forceAdaptiveThinking: true,
        supportsTemperature: false,
        supportsStrictTools: true,
      })
    })
  }

  it('lets a per-provider models[] entry win over the local override on the api-key path', () => {
    const model = buildModel(anthropicProvider({
      providerType: 'anthropic',
      models: [{ id: SONNET_55, name: 'Pinned Sonnet', cost: { input: 1, output: 2 } }],
    }), SONNET_55)
    expect(model.name).toBe('Pinned Sonnet')
    expect(model.cost.input).toBe(1)
    expect(model.compat).toBeUndefined()
  })

  it('resolves the subscription model from the pi-ai catalog with our wire override on top', () => {
    // OAuth presets take the catalog path in buildModel(); since pi-ai 0.99.0
    // the catalog has Sonnet 5.5, so a per-provider models[] entry no longer
    // applies there, exactly as for every other catalog model (Opus 5.5).
    const model = buildModel(anthropicProvider({
      providerType: 'anthropic-oauth',
      models: [{ id: SONNET_55, name: 'Pinned Sonnet', cost: { input: 1, output: 2 } }],
    }), SONNET_55)
    expect(model.name).toBe('Claude Sonnet 5.5')
    expect(model.cost).toMatchObject({ input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.50 })
    // The catalog marks Sonnet 5.5 as managed-effort (adaptive thinking at
    // effort "high" even for off); the override keeps it off that path.
    expect(model.compat).toEqual({ forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true })
    expect(model.headers?.['user-agent']).toMatch(/^claude-cli\//)
  })
})

describe('Sonnet 5.5 in the model catalog', () => {
  for (const providerType of ['anthropic', 'anthropic-oauth'] as const) {
    it(`getAvailableModels lists it for ${providerType}`, () => {
      const ids = getAvailableModels(providerType).map(m => m.id)
      expect(ids).toContain(SONNET_55)
      expect(ids).toContain('claude-sonnet-5')
    })
  }

  describe('startup catalog sync', () => {
    let tmpDir: string
    const originalDataDir = process.env.DATA_DIR

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
      else delete process.env.DATA_DIR
    })

    it('appends Sonnet 5.5 to an oauth provider without touching the default model', () => {
      tmpDir = path.join(os.tmpdir(), `axiom-sonnet55-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
      const known = getAvailableModels('anthropic-oauth').map(m => m.id).filter(id => id !== SONNET_55)
      fs.writeFileSync(
        path.join(tmpDir, 'config', 'providers.json'),
        JSON.stringify({
          providers: [{
            id: 'anth-oauth',
            name: 'Anthropic',
            type: 'anthropic-messages',
            providerType: 'anthropic-oauth',
            provider: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: '',
            enabledModels: ['claude-opus-5', 'claude-sonnet-5'],
            knownModels: known,
          }],
        }, null, 2),
        'utf-8',
      )
      process.env.DATA_DIR = tmpDir

      const results = syncNewCatalogModels()
      expect(results).toEqual([{ providerId: 'anth-oauth', providerName: 'Anthropic', added: [SONNET_55] }])
      const saved = loadProviders().providers[0]
      expect(saved.enabledModels).toEqual(['claude-opus-5', 'claude-sonnet-5', SONNET_55])
    })
  })
})

/**
 * Request-level contract: what actually goes over the wire. Both failures we
 * saw against the live API are invisible in the model object alone — they only
 * show up in the request body pi-ai builds from it.
 */
describe('Sonnet 5.5 request body', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function captureRequestBody(
    options: Record<string, unknown>,
    modelId: string = SONNET_55,
    provider: ProviderConfig = anthropicProvider({ providerType: 'anthropic-oauth' }),
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      captured = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
      return new Response('{"type":"error","error":{"message":"captured"}}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const model = buildModel(provider, modelId)
    await completeSimple(model, { messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }] }, {
      apiKey: 'sk-test',
      ...options,
    } as never)
    expect(captured).toBeDefined()
    return captured!
  }

  it('never sends temperature, not even when the caller passes one', async () => {
    const body = await captureRequestBody({ temperature: 0 })
    expect(body).not.toHaveProperty('temperature')
  })

  it('omits thinking entirely when the caller asks for no reasoning (api-key override path)', async () => {
    // `thinkingLevelMap.off === null` is what keeps pi-ai from sending
    // `thinking: { type: "disabled" }`, which this model rejects with a 400.
    const body = await captureRequestBody({}, SONNET_55, anthropicProvider({ providerType: 'anthropic' }))
    expect(body.thinking).toBeUndefined()
  })

  it('omits thinking entirely when the caller asks for no reasoning (subscription catalog path)', async () => {
    const body = await captureRequestBody({})
    expect(body.thinking).toBeUndefined()
  })

  it('would send the rejected disabled thinking without the off mapping', async () => {
    const body = await captureRequestBody({}, 'sonnet-like-without-map', anthropicProvider({
      providerType: 'anthropic-oauth',
      models: [{ id: 'sonnet-like-without-map', reasoning: true }],
    }))
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  it('asks for adaptive thinking with an effort when reasoning is on', async () => {
    const body = await captureRequestBody({ reasoning: 'high' })
    expect(body.thinking).toMatchObject({ type: 'adaptive' })
    expect(body.output_config).toMatchObject({ effort: 'high' })
  })
})
