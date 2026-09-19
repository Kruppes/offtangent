import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  loadProviders,
  loadProvidersDecrypted,
  loadProvidersMasked,
  getActiveProvider,
  getFallbackProvider,
  setFallbackProvider,
  clearFallbackProvider,
  getAvailableModels,
  syncNewCatalogModels,
  isDynamicCatalogProvider,
  buildModel,
  estimateCost,
  resolveModelTemperature,
  addProvider,
  updateProvider,
  updateProviderModel,
  deleteProvider,
  setActiveProvider,
  updateProviderStatus,
  PROVIDER_TYPE_PRESETS,
  PROVIDER_TYPE_MODEL_OVERRIDES,
  getConfiguredPriceTable,
  applyTextVerbosity,
  applyTransport,
  applyRequestTimeout,
  buildStreamFn,
  getDefaultRequestTimeoutMs,
  resolveRequestTimeoutMs,
  LOCAL_REQUEST_TIMEOUT_MS,
  presetSupportsTextVerbosity,
  presetSupportsTransport,
  refreshOAuthCredentialsLocked,
  resolvePromptProfileOptions,
} from './provider-config.js'
import { SYSTEM_PROMPT_CACHE_MARKER } from './prompt-cache.js'
import { encrypt, decrypt, maskApiKey } from './encryption.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('provider-config', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupTmpConfig(providersContent?: object): void {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-test-${Date.now()}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    if (providersContent) {
      fs.writeFileSync(
        path.join(configDir, 'providers.json'),
        JSON.stringify(providersContent, null, 2),
        'utf-8',
      )
    }
    process.env.DATA_DIR = tmpDir
  }

  it('loadProviders returns empty providers when file does not exist', () => {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-test-${Date.now()}`)
    process.env.DATA_DIR = tmpDir
    const result = loadProviders()
    expect(result.providers).toEqual([])
  })

  it('loadProviders reads providers.json correctly', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'test-id-1',
          name: 'my-openai',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          enabledModels: ['gpt-4o'],
        },
      ],
    })

    const result = loadProviders()
    expect(result.providers).toHaveLength(1)
    expect(result.providers[0].name).toBe('my-openai')
    expect(result.providers[0].apiKey).toBe('sk-test')
  })

  it('loadProviders migrates legacy defaultModel to the front of enabledModels', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'legacy-1',
          name: 'legacy',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          defaultModel: 'gpt-4o-mini',
          enabledModels: ['gpt-4o', 'gpt-4o-mini'],
        },
      ],
    })

    const provider = loadProviders().providers[0] as unknown as Record<string, unknown>
    expect(provider.enabledModels).toEqual(['gpt-4o-mini', 'gpt-4o'])
    expect(provider.defaultModel).toBeUndefined()
  })

  it('loadProviders migrates legacy defaultModel when enabledModels is missing', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'legacy-2',
          name: 'legacy',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          defaultModel: 'gpt-4o',
        },
      ],
    })

    const provider = loadProviders().providers[0] as unknown as Record<string, unknown>
    expect(provider.enabledModels).toEqual(['gpt-4o'])
    expect(provider.defaultModel).toBeUndefined()
  })

  it('getActiveProvider returns null when no providers configured', () => {
    setupTmpConfig({ providers: [] })
    expect(getActiveProvider()).toBeNull()
  })

  it('getActiveProvider returns first provider by default', () => {
    setupTmpConfig({
      providers: [
        { id: 'id-1', name: 'first', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', enabledModels: ['gpt-4o'] },
        { id: 'id-2', name: 'second', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] },
      ],
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('first')
  })

  it('getActiveProvider respects activeProvider field', () => {
    setupTmpConfig({
      providers: [
        { id: 'id-1', name: 'first', type: 'openai-completions', providerType: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1', enabledModels: ['gpt-4o'] },
        { id: 'id-2', name: 'second', type: 'anthropic-messages', providerType: 'anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] },
      ],
      activeProvider: 'id-2',
    })

    const active = getActiveProvider()
    expect(active?.name).toBe('second')
  })

  it('buildModel creates a valid Model object', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['gpt-4o'],
    }

    const model = buildModel(provider)
    expect(model.id).toBe('gpt-4o')
    expect(model.api).toBe('openai-completions')
    expect(model.provider).toBe('openai')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
    expect(model.cost.input).toBe(2.50)
    expect(model.cost.output).toBe(10.00)
  })

  it('buildModel routes GitHub Copilot to the account proxy endpoint from the token', () => {
    const model = buildModel({
      id: 'copilot-id',
      name: 'copilot',
      type: 'anthropic-messages',
      providerType: 'github-copilot' as const,
      provider: 'github-copilot',
      baseUrl: '',
      apiKey: '',
      authMethod: 'oauth' as const,
      enabledModels: ['claude-haiku-4.5'],
      oauthCredentials: {
        refresh: 'r',
        access: 'tid=abc;exp=1;proxy-ep=proxy.enterprise.githubcopilot.com;',
        expires: Date.now() + 60_000,
      },
    })
    expect(model.baseUrl).toBe('https://api.enterprise.githubcopilot.com')
  })

  it('buildModel uses configured settings price table as fallback', () => {
    setupTmpConfig()
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'settings.json'),
      JSON.stringify({ tokenPriceTable: { 'custom-priced-model': { input: 4.25, output: 12.5 } } }, null, 2),
      'utf-8',
    )

    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['custom-priced-model'],
    }

    const priceTable = getConfiguredPriceTable()
    const model = buildModel(provider)
    expect(priceTable['custom-priced-model'].input).toBe(4.25)
    expect(model.cost.input).toBe(4.25)
    expect(model.cost.output).toBe(12.5)
  })

  it('buildModel uses model config overrides', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['custom-model'],
      models: [
        {
          id: 'custom-model',
          name: 'Custom Model',
          contextWindow: 256000,
          maxTokens: 32768,
          reasoning: true,
          cost: { input: 5.0, output: 15.0, cacheRead: 1.0, cacheWrite: 2.0 },
        },
      ],
    }

    const model = buildModel(provider)
    expect(model.id).toBe('custom-model')
    expect(model.name).toBe('Custom Model')
    expect(model.contextWindow).toBe(256000)
    expect(model.maxTokens).toBe(32768)
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBe(5.0)
    expect(model.cost.cacheRead).toBe(1.0)
  })

  it('buildModel allows overriding model ID', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['gpt-4o'],
    }

    const model = buildModel(provider, 'gpt-4o-mini')
    expect(model.id).toBe('gpt-4o-mini')
    expect(model.cost.input).toBe(0.15)
  })

  it('estimateCost calculates correctly', () => {
    const model = buildModel({
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['gpt-4o'],
    })

    const cost = estimateCost(model, 1000, 500)
    expect(cost).toBeCloseTo(0.0075, 6)
  })

  it('estimateCost includes cache costs', () => {
    const provider = {
      id: 'test-id',
      name: 'test',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['custom'],
      models: [
        {
          id: 'custom',
          cost: { input: 10.0, output: 30.0, cacheRead: 2.5, cacheWrite: 5.0 },
        },
      ],
    }

    const model = buildModel(provider)
    const cost = estimateCost(model, 1000, 500, 2000, 1000)
    expect(cost).toBeCloseTo(0.035, 6)
  })

  it('updateProviderModel creates an entry with catalog defaults and applies description/cost patches', () => {
    setupTmpConfig({
      providers: [
        {
          id: 'kimi-id',
          name: 'Kimi',
          type: 'openai-completions',
          providerType: 'kimi',
          provider: 'moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          apiKey: 'sk-kimi',
          enabledModels: ['kimi-k2.6', 'kimi-latest'],
        },
      ],
    })

    // No models[] entry yet → created on the fly from PROVIDER_TYPE_MODEL_OVERRIDES.
    // Use a custom input price to ensure the shared catalog object is not mutated.
    const patched = updateProviderModel('kimi-id', 'kimi-k2.6', {
      description: 'Fast model for digests',
      cost: { input: 1.5, output: 2.5 },
    })
    // The module-level catalog default must stay untouched (no shared reference).
    const catalogDefault = PROVIDER_TYPE_MODEL_OVERRIDES.kimi?.find(m => m.id === 'kimi-k2.6')
    expect(catalogDefault?.cost?.input).toBe(0.95)
    const entry = patched.models?.find(m => m.id === 'kimi-k2.6')
    expect(entry).toBeDefined()
    expect(entry?.description).toBe('Fast model for digests')
    // Catalog defaults populated (contextWindow, reasoning) …
    expect(entry?.contextWindow).toBe(262_144)
    expect(entry?.reasoning).toBe(true)
    // … and the patched cost applied
    expect(entry?.cost?.input).toBe(1.5)
    expect(entry?.cost?.output).toBe(2.5)
    // Catalog cache cost preserved when not overridden
    expect(entry?.cost?.cacheRead).toBe(0.16)

    // Clearing the description removes it; cost stays
    const cleared = updateProviderModel('kimi-id', 'kimi-k2.6', { description: '   ' })
    const clearedEntry = cleared.models?.find(m => m.id === 'kimi-k2.6')
    expect(clearedEntry?.description).toBeUndefined()
    expect(clearedEntry?.cost?.input).toBe(1.5)

    // Unknown provider throws
    expect(() => updateProviderModel('no-such', 'kimi-k2.6', { description: 'x' })).toThrowError(
      'Provider not found: no-such',
    )
  })

  it('updateProviderModel persists name/contextWindow/cost for models outside the bundled catalog', () => {
    // Merge note (upstream 0.27.0 test on fork pi-ai 0.85.1): the original id
    // `qwen/qwen3.8-flash` is now PART of the pi-ai 0.85.1 openrouter catalog,
    // so updateProviderModel correctly enriches it (maxTokens/reasoning/cache
    // cost) via findPiAiCatalogModel. To keep the test's intent — a model NOT
    // in the bundled catalog — we use a synthetic id that is genuinely absent.
    setupTmpConfig({
      providers: [
        {
          id: 'or-id',
          name: 'OpenRouter',
          type: 'openai-completions',
          providerType: 'openrouter',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or',
          enabledModels: ['acme/custom-model-xyz'],
        },
      ],
    })

    const patched = updateProviderModel('or-id', 'acme/custom-model-xyz', {
      name: 'Acme Custom XYZ',
      contextWindow: 1_000_000,
      cost: { input: 0.15, output: 0.47 },
    })
    const entry = patched.models?.find(m => m.id === 'acme/custom-model-xyz')
    expect(entry).toEqual({
      id: 'acme/custom-model-xyz',
      name: 'Acme Custom XYZ',
      contextWindow: 1_000_000,
      cost: { input: 0.15, output: 0.47 },
    })

    const model = buildModel(patched, 'acme/custom-model-xyz')
    expect(model.name).toBe('Acme Custom XYZ')
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.cost.input).toBe(0.15)
    expect(model.cost.output).toBe(0.47)
  })
})

describe('streamFn injection', () => {
  it('applyTextVerbosity returns opts unchanged when textVerbosity is undefined', () => {
    const opts = { temperature: 0.7 }
    expect(applyTextVerbosity(undefined, opts)).toBe(opts)
  })

  it('applyTextVerbosity merges textVerbosity into opts when set', () => {
    const opts = { temperature: 0.7 }
    const merged = applyTextVerbosity('medium', opts)
    expect(merged).toEqual({ temperature: 0.7, textVerbosity: 'medium' })
    // does not mutate the input
    expect(opts).toEqual({ temperature: 0.7 })
  })

  it('buildStreamFn forwards textVerbosity into streamSimple options when configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ textVerbosity: 'medium' }, fakeStream as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    expect(fakeStream).toHaveBeenCalledTimes(1)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({ temperature: 0.5, textVerbosity: 'medium' })
  })

  it('buildStreamFn passes options through unchanged when no textVerbosity is set', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({}, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts) // identity — no spread when not needed
    expect(opts).not.toHaveProperty('textVerbosity')
  })

  describe('buildStreamFn prompt-cache wiring', () => {
    const anthropicModel = { id: 'claude-x', api: 'anthropic-messages' }
    const ollamaModel = { id: 'qwen', api: 'openai-completions' }
    const cc = { type: 'ephemeral', ttl: '1h' }
    const stableSettings = { retention: 'long' as const, systemBreakpoint: true, sessionAffinity: true }

    function marked(prefix: string, tail: string): string {
      return `${prefix}\n\n${SYSTEM_PROMPT_CACHE_MARKER}\n\n${tail}`
    }

    it('strips the cache marker for every provider, including non-Anthropic ones', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, { settings: stableSettings })
      const context = { systemPrompt: marked('STABLE', 'VOLATILE'), messages: [] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(ollamaModel as any, context as any, undefined as any)

      const [, ctx, opts] = fakeStream.mock.calls[0]!
      expect(ctx.systemPrompt).toBe('STABLE\n\nVOLATILE')
      expect(ctx.systemPrompt).not.toContain(SYSTEM_PROMPT_CACHE_MARKER)
      // Non-Anthropic providers get no cache options at all.
      expect(opts).toBeUndefined()
    })

    it('leaves the context identical when the prompt carries no marker', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, { settings: stableSettings })
      const context = { systemPrompt: 'plain task prompt', messages: [] }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(ollamaModel as any, context as any, undefined as any)
      expect(fakeStream.mock.calls[0]![1]).toBe(context)
    })

    it('sets cacheRetention and sessionId for Anthropic models', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, {
        getSessionId: () => 'strand-42',
        settings: stableSettings,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt: marked('STABLE', 'VOLATILE'), messages: [] } as any, undefined as any)

      const [, , opts] = fakeStream.mock.calls[0]!
      expect(opts.cacheRetention).toBe('long')
      expect(opts.sessionId).toBe('strand-42')
      expect(typeof opts.onPayload).toBe('function')
    })

    it('adds the second cache breakpoint through onPayload', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, { settings: stableSettings })
      const systemPrompt = marked('STABLE', 'VOLATILE')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt, messages: [] } as any, undefined as any)

      const [, ctx, opts] = fakeStream.mock.calls[0]!
      const payload = { system: [{ type: 'text', text: ctx.systemPrompt, cache_control: cc }] }
      const out = await opts.onPayload(payload, anthropicModel)

      expect(out.system).toHaveLength(2)
      expect(out.system[0].text).toBe('STABLE\n\n')
      expect(out.system[1].text).toBe('VOLATILE')
      expect(out.system[0].cache_control).toEqual(cc)
      expect(out.system[1].cache_control).toEqual(cc)
    })

    it('chains an existing onPayload instead of dropping it', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, { settings: stableSettings })
      const systemPrompt = marked('STABLE', 'VOLATILE')
      const caller = vi.fn((payload: Record<string, unknown>) => ({ ...payload, tagged: true }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt, messages: [] } as any, { onPayload: caller } as any)

      const [, ctx, opts] = fakeStream.mock.calls[0]!
      const out = await opts.onPayload(
        { system: [{ type: 'text', text: ctx.systemPrompt, cache_control: cc }] },
        anthropicModel,
      )
      expect(caller).toHaveBeenCalledTimes(1)
      expect(out.tagged).toBe(true)
      expect(out.system).toHaveLength(2)
    })

    it('keeps a caller-provided cacheRetention and sessionId', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, {
        getSessionId: () => 'strand-42',
        settings: stableSettings,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt: 'plain', messages: [] } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { cacheRetention: 'short', sessionId: 'explicit' } as any)
      const [, , opts] = fakeStream.mock.calls[0]!
      expect(opts.cacheRetention).toBe('short')
      expect(opts.sessionId).toBe('explicit')
    })

    it('respects settings: retention none disables the extra breakpoint', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, {
        settings: { retention: 'none', systemBreakpoint: true, sessionAffinity: true },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt: marked('STABLE', 'VOLATILE'), messages: [] } as any, undefined as any)
      const [, , opts] = fakeStream.mock.calls[0]!
      expect(opts.cacheRetention).toBe('none')
      expect(opts.onPayload).toBeUndefined()
    })

    it('respects settings: sessionAffinity off drops the session id', async () => {
      const fakeStream = vi.fn().mockResolvedValue({ ok: true })
      const fn = buildStreamFn({}, fakeStream as never, {
        getSessionId: () => 'strand-42',
        settings: { retention: 'long', systemBreakpoint: false, sessionAffinity: false },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await fn(anthropicModel as any, { systemPrompt: marked('STABLE', 'VOLATILE'), messages: [] } as any, undefined as any)
      const [, , opts] = fakeStream.mock.calls[0]!
      expect(opts.sessionId).toBeUndefined()
      expect(opts.onPayload).toBeUndefined()
    })
  })

  it('applyTransport returns opts unchanged when transport is undefined', () => {
    const opts = { temperature: 0.7 }
    expect(applyTransport(undefined, opts)).toBe(opts)
  })

  it('applyTransport returns opts unchanged when transport is the default "sse"', () => {
    const opts = { temperature: 0.7 }
    // "sse" matches pi-ai's default — the spread would be a no-op, so we keep
    // identity for the common case to make the call site free of churn.
    expect(applyTransport('sse', opts)).toBe(opts)
  })

  it('applyTransport merges non-default transports into opts', () => {
    const opts = { temperature: 0.7 }
    const merged = applyTransport('websocket-cached', opts)
    expect(merged).toEqual({ temperature: 0.7, transport: 'websocket-cached' })
    // does not mutate the input
    expect(opts).toEqual({ temperature: 0.7 })
  })

  it('buildStreamFn forwards transport into streamSimple options when configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ transport: 'websocket-cached' }, fakeStream as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    expect(fakeStream).toHaveBeenCalledTimes(1)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({ temperature: 0.5, transport: 'websocket-cached' })
  })

  it('buildStreamFn forwards both textVerbosity and transport when both configured', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn(
      { textVerbosity: 'medium', transport: 'websocket' },
      fakeStream as never,
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({
      temperature: 0.5,
      textVerbosity: 'medium',
      transport: 'websocket',
    })
  })

  it('buildStreamFn passes options through unchanged when transport is "sse" (default)', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ transport: 'sse' }, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts) // identity — no spread when not needed
    expect(opts).not.toHaveProperty('transport')
  })

  it('getDefaultRequestTimeoutMs returns 1h only for ollama-type presets', () => {
    expect(getDefaultRequestTimeoutMs('ollama')).toBe(LOCAL_REQUEST_TIMEOUT_MS)
    // legacy aliases resolve through the preset map to the same local default
    expect(getDefaultRequestTimeoutMs('ollama-local')).toBe(LOCAL_REQUEST_TIMEOUT_MS)
    expect(getDefaultRequestTimeoutMs('ollama-cloud')).toBe(LOCAL_REQUEST_TIMEOUT_MS)
    // cloud providers keep the SDK default (undefined → no override merged)
    expect(getDefaultRequestTimeoutMs('openai')).toBeUndefined()
    expect(getDefaultRequestTimeoutMs('anthropic')).toBeUndefined()
    expect(getDefaultRequestTimeoutMs('openai-codex')).toBeUndefined()
    expect(getDefaultRequestTimeoutMs(undefined)).toBeUndefined()
  })

  it('applyRequestTimeout returns opts unchanged when timeout is undefined', () => {
    const opts = { temperature: 0.7 }
    expect(applyRequestTimeout(undefined, opts)).toBe(opts)
  })

  it('applyRequestTimeout merges timeoutMs into opts without mutating the input', () => {
    const opts = { temperature: 0.7 }
    const merged = applyRequestTimeout(3_600_000, opts)
    expect(merged).toEqual({ temperature: 0.7, timeoutMs: 3_600_000 })
    expect(opts).toEqual({ temperature: 0.7 })
  })

  it('applyRequestTimeout never overrides a caller-provided timeoutMs', () => {
    const opts = { timeoutMs: 5_000 }
    expect(applyRequestTimeout(3_600_000, opts)).toBe(opts)
  })

  it('resolveRequestTimeoutMs prefers the env override when set to a positive integer', () => {
    const original = process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS
    try {
      process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS = '7200000'
      expect(resolveRequestTimeoutMs('ollama')).toBe(7_200_000)
      // env override applies globally, even to cloud providers
      expect(resolveRequestTimeoutMs('openai')).toBe(7_200_000)
      // garbage env values fall back to the provider-type default
      process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS = 'not-a-number'
      expect(resolveRequestTimeoutMs('ollama')).toBe(LOCAL_REQUEST_TIMEOUT_MS)
      process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS = '-500'
      expect(resolveRequestTimeoutMs('ollama')).toBe(LOCAL_REQUEST_TIMEOUT_MS)
    } finally {
      if (original !== undefined) process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS = original
      else delete process.env.AXIOM_LLM_REQUEST_TIMEOUT_MS
    }
  })

  it('buildStreamFn forwards the ollama request timeout into streamSimple options', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ providerType: 'ollama' }, fakeStream as never)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, { temperature: 0.5 } as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toEqual({ temperature: 0.5, timeoutMs: LOCAL_REQUEST_TIMEOUT_MS })
  })

  it('buildStreamFn adds no timeout for cloud providers (SDK default preserved)', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({ providerType: 'anthropic' }, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts) // identity — nothing merged
    expect(opts).not.toHaveProperty('timeoutMs')
  })

  it('buildStreamFn keeps working when providerType is absent (legacy call sites)', async () => {
    const fakeStream = vi.fn().mockResolvedValue({ ok: true })
    const fn = buildStreamFn({}, fakeStream as never)
    const inputOpts = { temperature: 0.5 }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fn({ id: 'm' } as any, { messages: [] } as any, inputOpts as any)
    const [, , opts] = fakeStream.mock.calls[0]!
    expect(opts).toBe(inputOpts)
    expect(opts).not.toHaveProperty('timeoutMs')
  })

  it('presetSupportsTransport is true only for openai-codex-responses presets', () => {
    // Only the OpenAI Codex / Responses apiType currently honours `transport`
    // in pi-ai. Keeping this list explicit so a future provider gaining WS
    // support fails this assertion and forces a deliberate update.
    expect(presetSupportsTransport('openai-codex')).toBe(true)
    expect(presetSupportsTransport('openai')).toBe(false)
    expect(presetSupportsTransport('anthropic')).toBe(false)
    expect(presetSupportsTransport('github-copilot')).toBe(false)
    expect(presetSupportsTransport('ollama')).toBe(false)
  })
})

describe('textVerbosity persistence guard', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-tv-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider drops textVerbosity when preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'openai-noop',
      providerType: 'openai',
      apiKey: 'sk-1',
      enabledModels: ['gpt-4o'],
      textVerbosity: 'medium',
    })
    expect(provider.textVerbosity).toBeUndefined()
  })

  it('updateProvider strips textVerbosity when switching to a non-supporting providerType', () => {
    setupEmpty()
    // Need a non-active provider so we can mutate freely without re-pointing active
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      textVerbosity: 'high',
    })
    // codex preset is OAuth + openai-codex-responses — textVerbosity is honoured
    expect(codex.textVerbosity).toBe('high')

    // Flip to a providerType that does not consume textVerbosity
    const updated = updateProvider(codex.id, { providerType: 'openai' })
    expect(updated.textVerbosity).toBeUndefined()
  })

  it('updateProvider clears textVerbosity when explicitly set to null', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      textVerbosity: 'low',
    })
    expect(codex.textVerbosity).toBe('low')
    const updated = updateProvider(codex.id, { textVerbosity: null })
    expect(updated.textVerbosity).toBeUndefined()
  })

  it('updateProvider ignores textVerbosity on providers whose preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const updated = updateProvider(provider.id, { textVerbosity: 'high' })
    expect(updated.textVerbosity).toBeUndefined()
  })
})

describe('transport persistence guard', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-tr-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider persists transport on supported providerType (openai-codex)', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-ws',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')
  })

  it('addProvider drops transport when preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'openai-noop',
      providerType: 'openai',
      apiKey: 'sk-1',
      enabledModels: ['gpt-4o'],
      transport: 'websocket-cached',
    })
    expect(provider.transport).toBeUndefined()
  })

  it('addProvider drops transport when value is the default "sse"', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-sse',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      transport: 'sse',
    })
    // We never persist the no-op default — absence == "sse".
    expect(codex.transport).toBeUndefined()
  })

  it('addProvider defaults transport to undefined (== sse) when not provided', () => {
    setupEmpty()
    const codex = addProvider({
      name: 'codex-default',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
    })
    expect(codex.transport).toBeUndefined()
  })

  it('updateProvider persists transport on supported provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
    })
    const updated = updateProvider(codex.id, { transport: 'websocket-cached' })
    expect(updated.transport).toBe('websocket-cached')
  })

  it('updateProvider strips transport when switching to a non-supporting providerType', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')

    // Flip to a providerType that does not consume transport
    const updated = updateProvider(codex.id, { providerType: 'openai' })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider clears transport when explicitly set to null', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      transport: 'websocket-cached',
    })
    expect(codex.transport).toBe('websocket-cached')
    const updated = updateProvider(codex.id, { transport: null })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider clears transport when explicitly set to "sse" (the default)', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const codex = addProvider({
      name: 'codex',
      providerType: 'openai-codex',
      enabledModels: ['gpt-5-codex'],
      transport: 'websocket-cached',
    })
    const updated = updateProvider(codex.id, { transport: 'sse' })
    expect(updated.transport).toBeUndefined()
  })

  it('updateProvider ignores transport on providers whose preset does not support it', () => {
    setupEmpty()
    const provider = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-a', enabledModels: ['gpt-4o'] })
    const updated = updateProvider(provider.id, { transport: 'websocket-cached' })
    expect(updated.transport).toBeUndefined()
  })
})

describe('promptProfile persistence + resolution', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-pp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider persists promptProfile "slim"', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      enabledModels: ['llama3'],
      promptProfile: 'slim',
    })
    expect(provider.promptProfile).toBe('slim')
    const reloaded = loadProviders().providers.find(p => p.id === provider.id)
    expect(reloaded?.promptProfile).toBe('slim')
  })

  it('addProvider does NOT persist the default "full" profile', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      enabledModels: ['llama3'],
      promptProfile: 'full',
    })
    expect(provider.promptProfile).toBeUndefined()
  })

  it('addProvider leaves promptProfile absent when not configured', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'cloud',
      providerType: 'openai',
      apiKey: 'sk-a',
      enabledModels: ['gpt-4o'],
    })
    expect(provider.promptProfile).toBeUndefined()
    expect('promptProfile' in provider).toBe(false)
  })

  it('updateProvider sets and clears promptProfile', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      enabledModels: ['llama3'],
    })
    const slim = updateProvider(provider.id, { promptProfile: 'slim' })
    expect(slim.promptProfile).toBe('slim')

    // Explicit null clears the field
    const cleared = updateProvider(provider.id, { promptProfile: null })
    expect(cleared.promptProfile).toBeUndefined()

    // 'full' is the default and is dropped rather than persisted
    updateProvider(provider.id, { promptProfile: 'slim' })
    const full = updateProvider(provider.id, { promptProfile: 'full' })
    expect(full.promptProfile).toBeUndefined()
  })

  it('updateProvider leaves promptProfile untouched when omitted', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      enabledModels: ['llama3'],
      promptProfile: 'slim',
    })
    const updated = updateProvider(provider.id, { name: 'renamed' })
    expect(updated.promptProfile).toBe('slim')
  })

  it('resolvePromptProfileOptions maps profiles to prompt options', () => {
    // Absent field and explicit 'full' both resolve to the historical defaults
    expect(resolvePromptProfileOptions(undefined)).toEqual({
      recentDays: 3,
      includeWikiPages: true,
      includeAxiomDocs: true,
    })
    expect(resolvePromptProfileOptions('full')).toEqual({
      recentDays: 3,
      includeWikiPages: true,
      includeAxiomDocs: true,
    })
    expect(resolvePromptProfileOptions('slim')).toEqual({
      recentDays: 1,
      includeWikiPages: false,
      includeAxiomDocs: false,
    })
  })
})

describe('healthCheckTimeoutMs persistence', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-hct-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider defaults local Ollama providers to the 60 s cold-start timeout', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      baseUrl: 'http://mac-studio:11434/v1',
      enabledModels: ['qwen3:32b'],
    })
    expect(provider.healthCheckTimeoutMs).toBe(60000)
  })

  it('addProvider defaults remote providers to the regular 15 s timeout', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'remote-openai',
      providerType: 'openai',
      apiKey: 'sk-a',
      enabledModels: ['gpt-4o'],
    })
    expect(provider.healthCheckTimeoutMs).toBe(15000)
  })

  it('addProvider honours an explicit healthCheckTimeoutMs over the type default', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'local-ollama',
      providerType: 'ollama',
      enabledModels: ['qwen3:32b'],
      healthCheckTimeoutMs: 120000,
    })
    expect(provider.healthCheckTimeoutMs).toBe(120000)
  })

  it('updateProvider persists healthCheckTimeoutMs and leaves it untouched when omitted', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'remote-openai',
      providerType: 'openai',
      apiKey: 'sk-a',
      enabledModels: ['gpt-4o'],
    })
    const updated = updateProvider(provider.id, { healthCheckTimeoutMs: 30000 })
    expect(updated.healthCheckTimeoutMs).toBe(30000)

    const untouched = updateProvider(provider.id, { name: 'renamed' })
    expect(untouched.healthCheckTimeoutMs).toBe(30000)
  })

  it('existing provider entries without the field stay without it (no silent rewrite)', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'remote-openai',
      providerType: 'openai',
      apiKey: 'sk-a',
      enabledModels: ['gpt-4o'],
    })
    // Simulate a pre-existing config entry created before the field existed
    const file = loadProviders()
    delete file.providers.find(p => p.id === provider.id)!.healthCheckTimeoutMs
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'providers.json'),
      JSON.stringify(file, null, 2),
      'utf-8',
    )

    const updated = updateProvider(provider.id, { name: 'renamed' })
    expect(updated.healthCheckTimeoutMs).toBeUndefined()
  })
})

describe('encryption', () => {
  it('encrypt/decrypt roundtrip works', () => {
    const plaintext = 'sk-test-api-key-12345'
    const encrypted = encrypt(plaintext)
    expect(encrypted).not.toBe(plaintext)
    const decrypted = decrypt(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  it('maskApiKey masks correctly', () => {
    expect(maskApiKey('sk-1234567890abcdef')).toBe('sk-1••••••••cdef')
    expect(maskApiKey('short')).toBe('••••••••')
    expect(maskApiKey('12345678')).toBe('••••••••')
    expect(maskApiKey('123456789')).toBe('1234••••••••6789')
  })
})

describe('provider CRUD', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupEmpty(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-provider-crud-${Date.now()}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers: [] }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  it('addProvider creates a provider with encrypted API key', () => {
    setupEmpty()

    const provider = addProvider({
      name: 'My OpenAI',
      providerType: 'openai',
      apiKey: 'sk-test123',
      enabledModels: ['gpt-4o'],
    })

    expect(provider.id).toBeDefined()
    expect(provider.name).toBe('My OpenAI')
    expect(provider.type).toBe('openai-completions')
    expect(provider.provider).toBe('openai')
    expect(provider.baseUrl).toBe('https://api.openai.com/v1')
    expect(provider.status).toBe('untested')

    // API key should be encrypted in the stored file
    const file = loadProviders()
    expect(file.providers[0].apiKey).not.toBe('sk-test123')

    // But loadProvidersDecrypted should decrypt it
    const decrypted = loadProvidersDecrypted()
    expect(decrypted.providers[0].apiKey).toBe('sk-test123')

    // First provider should be auto-activated
    expect(file.activeProvider).toBe(provider.id)
  })

  it('addProvider uses type preset base URL', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'Kimi',
      providerType: 'kimi',
      apiKey: 'sk-kimi',
      enabledModels: ['moonshot-v1-8k'],
    })
    expect(provider.baseUrl).toBe('https://api.moonshot.ai/v1')
  })

  it('addProvider sets xai base URL and OpenAI-compatible api type', () => {
    setupEmpty()
    const provider = addProvider({
      name: 'Grok',
      providerType: 'xai',
      apiKey: 'xai-key',
      enabledModels: ['grok-4.3'],
    })
    expect(provider.baseUrl).toBe('https://api.x.ai/v1')
    expect(provider.type).toBe('openai-completions')
    expect(provider.provider).toBe('xai')
  })

  it('addProvider rejects duplicate name', () => {
    setupEmpty()
    addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    expect(() => addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-2', enabledModels: ['gpt-4o'] }))
      .toThrow('already exists')
  })

  it('addProvider rejects invalid provider type', () => {
    setupEmpty()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => addProvider({ name: 'test', providerType: 'invalid' as any, apiKey: 'sk-1', enabledModels: ['gpt-4o'] }))
      .toThrow('Unknown provider type')
  })

  it('updateProvider updates fields', () => {
    setupEmpty()
    const provider = addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })

    const updated = updateProvider(provider.id, { name: 'Updated Name', enabledModels: ['gpt-4o-mini'] })
    expect(updated.name).toBe('Updated Name')
    expect(updated.enabledModels?.[0]).toBe('gpt-4o-mini')
    expect(updated.status).toBe('untested') // reset on update
  })

  it('updateProvider throws on not found', () => {
    setupEmpty()
    expect(() => updateProvider('nonexistent', { name: 'test' })).toThrow('not found')
  })

  it('deleteProvider removes provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    const p2 = addProvider({ name: 'second', providerType: 'anthropic', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] })

    // p1 is active (first added), delete p2
    deleteProvider(p2.id)
    const file = loadProviders()
    expect(file.providers).toHaveLength(1)
    expect(file.providers[0].id).toBe(p1.id)
  })

  it('deleteProvider cannot delete active provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    expect(() => deleteProvider(p1.id)).toThrow('Cannot delete the active provider')
  })

  it('setActiveProvider changes active provider', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'first', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    const p2 = addProvider({ name: 'second', providerType: 'anthropic', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] })

    expect(loadProviders().activeProvider).toBe(p1.id)

    setActiveProvider(p2.id)
    expect(loadProviders().activeProvider).toBe(p2.id)
  })

  it('updateProviderStatus updates status', () => {
    setupEmpty()
    const provider = addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })

    updateProviderStatus(provider.id, 'connected')
    const file = loadProviders()
    expect(file.providers[0].status).toBe('connected')
  })

  it('loadProvidersMasked returns masked keys and empty apiKey', () => {
    setupEmpty()
    addProvider({ name: 'test', providerType: 'openai', apiKey: 'sk-test1234567890', enabledModels: ['gpt-4o'] }) // gitleaks:allow -- synthetic test fixture

    const masked = loadProvidersMasked()
    expect(masked.providers[0].apiKey).toBe('')
    expect(masked.providers[0].apiKeyMasked).toContain('••••••••')
    expect(masked.providers[0].apiKeyMasked).not.toContain('sk-test1234567890')
  })

  it('stores provider extra fields generically and masks secret entries', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      enabledModels: ['glm-5.1'],
      extraFields: {
        workspaceId: ' workspace-1 ',
        authCookie: ' auth-cookie-1 ',
        unknown: 'ignored',
      },
    })

    const stored = loadProviders().providers.find(p => p.id === created.id)!
    expect(stored.extraFields).toEqual({
      workspaceId: 'workspace-1',
      authCookie: expect.any(String),
    })
    expect(stored.extraFields!.authCookie).not.toBe('auth-cookie-1')
    expect(decrypt(stored.extraFields!.authCookie)).toBe('auth-cookie-1')

    const decrypted = loadProvidersDecrypted().providers.find(p => p.id === created.id)!
    expect(decrypted.extraFields).toEqual({ workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' })

    const masked = loadProvidersMasked().providers.find(p => p.id === created.id)!
    expect(masked.extraFields).toEqual({ workspaceId: 'workspace-1' })
    expect(masked.extraFieldsSet).toEqual({ authCookie: true })
  })

  it('keeps secret extra fields on blank update and clears blank non-secret fields', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      enabledModels: ['glm-5.1'],
      extraFields: { workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' },
    })

    updateProvider(created.id, { extraFields: { workspaceId: '', authCookie: '' } })
    expect(loadProvidersDecrypted().providers[0]!.extraFields).toEqual({ authCookie: 'auth-cookie-1' })

    updateProvider(created.id, { extraFields: { authCookie: 'auth-cookie-2' } })
    expect(loadProvidersDecrypted().providers[0]!.extraFields).toEqual({ authCookie: 'auth-cookie-2' })
  })

  it('clears provider extra fields when provider type changes', () => {
    setupEmpty()
    const created = addProvider({
      name: 'OpenCode Go',
      providerType: 'opencode-go',
      apiKey: 'oc-key',
      enabledModels: ['glm-5.1'],
      extraFields: { workspaceId: 'workspace-1', authCookie: 'auth-cookie-1' },
    })

    updateProvider(created.id, { providerType: 'openai', enabledModels: ['gpt-4o'] })

    const stored = loadProviders().providers.find(p => p.id === created.id)!
    expect(stored.extraFields).toBeUndefined()

    const masked = loadProvidersMasked().providers.find(p => p.id === created.id)!
    expect(masked.extraFields).toEqual({})
    expect(masked.extraFieldsSet).toEqual({})
  })

  it('omits stale unknown extra fields from masked providers', () => {
    setupEmpty()
    fs.writeFileSync(
      path.join(tmpDir, 'config', 'providers.json'),
      JSON.stringify({
        providers: [{
          id: 'stale-openai',
          name: 'Stale OpenAI',
          type: 'openai-completions',
          providerType: 'openai',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: encrypt('sk-test'),
          enabledModels: ['gpt-4o'],
          extraFields: { workspaceId: 'workspace-1', authCookie: encrypt('auth-cookie-1') },
          status: 'untested',
          authMethod: 'api-key',
        }],
      }, null, 2),
      'utf-8',
    )

    const masked = loadProvidersMasked().providers[0]!
    expect(masked.extraFields).toEqual({})
    expect(masked.extraFieldsSet).toEqual({})
  })

  it('setFallbackProvider sets the fallback provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] })

    setFallbackProvider(p2.id)
    const file = loadProviders()
    expect(file.fallbackProvider).toBe(p2.id)
  })

  it('getFallbackProvider returns the decrypted fallback provider config', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-fb-key', enabledModels: ['claude-3-5-sonnet-20241022'] })

    setFallbackProvider(p2.id)
    const fb = getFallbackProvider()
    expect(fb).not.toBeNull()
    expect(fb!.id).toBe(p2.id)
    expect(fb!.name).toBe('fallback')
    expect(fb!.apiKey).toBe('sk-fb-key') // decrypted
  })

  it('getFallbackProvider returns null when no fallback set', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    expect(getFallbackProvider()).toBeNull()
  })

  it('setFallbackProvider rejects non-existent provider', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    expect(() => setFallbackProvider('nonexistent')).toThrow('not found')
  })

  it('setFallbackProvider rejects active provider with same model', () => {
    setupEmpty()
    const p1 = addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    expect(() => setFallbackProvider(p1.id)).toThrow('Fallback cannot be the same provider and model as the active selection')
  })

  it('clearFallbackProvider removes the fallback provider setting', () => {
    setupEmpty()
    addProvider({ name: 'primary', providerType: 'openai', apiKey: 'sk-1', enabledModels: ['gpt-4o'] })
    const p2 = addProvider({ name: 'fallback', providerType: 'anthropic', apiKey: 'sk-2', enabledModels: ['claude-3-5-sonnet-20241022'] })

    setFallbackProvider(p2.id)
    expect(loadProviders().fallbackProvider).toBe(p2.id)

    clearFallbackProvider()
    expect(loadProviders().fallbackProvider).toBeUndefined()
    expect(getFallbackProvider()).toBeNull()
  })

  it('PROVIDER_TYPE_PRESETS has all required types', () => {
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openai')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('anthropic')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama')
    // Legacy aliases still exist for migration
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama-local')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('ollama-cloud')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openrouter')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('deepseek')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('kimi')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('minimax')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('zai')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('zai-coding')
    expect(PROVIDER_TYPE_PRESETS).toHaveProperty('openai-compatible')
  })

  it('zai is the pay-per-token General API, zai-coding the GLM Coding Plan subscription', () => {
    expect(PROVIDER_TYPE_PRESETS['zai'].baseUrl).toBe('https://api.z.ai/api/paas/v4')
    expect(PROVIDER_TYPE_PRESETS['zai'].subscription).toBeUndefined()
    expect(PROVIDER_TYPE_PRESETS['zai-coding'].baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(PROVIDER_TYPE_PRESETS['zai-coding'].subscription).toBe(true)
    // Both reuse the pi-ai `zai` catalog for their model list.
    expect(PROVIDER_TYPE_PRESETS['zai-coding'].piAiProvider).toBe('zai')
  })

})

describe('openai-compatible provider type', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  function setupTmp(): void {
    tmpDir = path.join(os.tmpdir(), `axiom-openai-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    process.env.DATA_DIR = tmpDir
  }

  it('preset is configured as a generic, BYO-URL, optional-key endpoint', () => {
    const preset = PROVIDER_TYPE_PRESETS['openai-compatible']
    expect(preset).toBeDefined()
    // Must use the OpenAI completions wire format so streaming/tool-calling
    // is identical to the regular `openai` provider type.
    expect(preset.apiType).toBe('openai-completions')
    expect(preset.authMethod).toBe('api-key')
    // Generic by design: URL is user-supplied, key is optional, and there is
    // no upstream catalog to fetch a model list from.
    expect(preset.urlEditable).toBe(true)
    expect(preset.requiresApiKey).toBe(false)
    expect(preset.piAiProvider).toBeNull()
    expect(preset.baseUrl).toBe('')
    // Label is used for the dropdown entry; the (custom) suffix is the
    // contract that distinguishes it from the regular `openai` preset.
    expect(preset.label.toLowerCase()).toContain('custom')
  })

  it('returns no catalog models (free-text input is expected)', () => {
    expect(getAvailableModels('openai-compatible')).toEqual([])
  })

  it('does not advertise textVerbosity support', () => {
    expect(presetSupportsTextVerbosity('openai-compatible')).toBe(false)
  })

  it('addProvider persists a user-supplied baseUrl, encrypts the key, and round-trips via decrypted load', () => {
    setupTmp()
    const created = addProvider({
      name: 'NVIDIA NIM',
      providerType: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-secret-token',
      enabledModels: ['meta/llama-3.1-405b-instruct'],
    })

    // Stored config should track exactly what the user typed (not a preset URL)
    expect(created.providerType).toBe('openai-compatible')
    expect(created.type).toBe('openai-completions')
    expect(created.provider).toBe('openai-compatible')
    expect(created.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(created.enabledModels?.[0]).toBe('meta/llama-3.1-405b-instruct')

    // On disk the API key must be encrypted, never plaintext
    const onDisk = loadProviders().providers[0]!
    expect(onDisk.apiKey).not.toBe('nvapi-secret-token')
    expect(onDisk.apiKey.length).toBeGreaterThan(0)
    expect(decrypt(onDisk.apiKey)).toBe('nvapi-secret-token')

    // The decrypted view (used by the runtime) must give the plaintext back
    const decryptedView = loadProvidersDecrypted().providers[0]!
    expect(decryptedView.apiKey).toBe('nvapi-secret-token')
    // baseUrl is treated as user-editable, so it must NOT be overridden by the empty preset value
    expect(decryptedView.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
  })

  it('addProvider works without an API key (e.g. local LM Studio / vLLM)', () => {
    setupTmp()
    const created = addProvider({
      name: 'Local LM Studio',
      providerType: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      enabledModels: ['qwen2.5-coder-32b'],
    })

    expect(created.apiKey).toBe('')
    const onDisk = loadProviders().providers[0]!
    expect(onDisk.apiKey).toBe('')
  })

  it('buildModel returns a Model whose api/baseUrl come from the user-supplied config', () => {
    setupTmp()
    const provider = addProvider({
      name: 'NIM',
      providerType: 'openai-compatible',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'nvapi-key',
      enabledModels: ['meta/llama-3.1-70b-instruct'],
    })
    // Use the decrypted record so buildModel sees the user's plaintext key
    const decrypted = loadProvidersDecrypted().providers.find(p => p.id === provider.id)!
    const model = buildModel(decrypted)

    expect(model.id).toBe('meta/llama-3.1-70b-instruct')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(model.provider).toBe('openai-compatible')
  })
})

describe('getAvailableModels', () => {
  it('returns models for openai provider type', () => {
    const models = getAvailableModels('openai')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('id')
    expect(models[0]).toHaveProperty('name')
    const gpt4o = models.find(m => m.id === 'gpt-4o')
    expect(gpt4o).toBeDefined()
    expect(gpt4o!.name).toBe('GPT-4o')
  })

  it('returns models for anthropic provider type', () => {
    const models = getAvailableModels('anthropic')
    expect(models.length).toBeGreaterThan(0)
    const sonnet = models.find(m => m.id.includes('sonnet'))
    expect(sonnet).toBeDefined()
  })

  it('returns models for zai provider type', () => {
    const models = getAvailableModels('zai')
    expect(models.length).toBeGreaterThan(0)
    const glm = models.find(m => m.id.startsWith('glm-'))
    expect(glm).toBeDefined()
  })

  it('returns empty array for ollama (no pi-ai mapping)', () => {
    const models = getAvailableModels('ollama')
    expect(models).toEqual([])
  })

  it('returns models for openrouter provider type', () => {
    const models = getAvailableModels('openrouter')
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('id')
    expect(models[0]).toHaveProperty('name')
  })

  it('marks openrouter as a dynamic-catalog provider and others as static', () => {
    expect(isDynamicCatalogProvider('openrouter')).toBe(true)
    expect(isDynamicCatalogProvider('openai')).toBe(false)
    expect(isDynamicCatalogProvider('ollama')).toBe(false)
  })

  it('returns models for deepseek provider type', () => {
    const models = getAvailableModels('deepseek')
    expect(models.length).toBeGreaterThan(0)
    expect(models.map(m => m.id)).toContain('deepseek-v4-pro')
  })

  it('returns models for minimax provider type', () => {
    const models = getAvailableModels('minimax')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some(m => m.id.startsWith('MiniMax-M2.'))).toBe(true)
  })

  it('returns Grok models for xai provider type', () => {
    const models = getAvailableModels('xai')
    expect(models.length).toBeGreaterThan(0)
    // The catalog is sourced from pi-ai's maintained `xai` provider, so we
    // assert on stable family ids rather than a frozen list.
    expect(models.every(m => m.id.startsWith('grok-'))).toBe(true)
    const ids = models.map(m => m.id)
    // pi-ai 0.80.8 trimmed the xAI catalog (grok-3 family removed, default
    // grok-4.5) — assert on the current stable ids.
    expect(ids).toContain('grok-4.3')
    expect(ids).toContain('grok-4.5')
  })

  it('returns the pi-ai maintained Moonshot Platform catalog for kimi (pay-as-you-go)', () => {
    const models = getAvailableModels('kimi')
    const ids = models.map(m => m.id)
    // Sourced from pi-ai's `moonshotai` catalog (resolveModelsFromCatalog).
    expect(ids).toContain('kimi-k3')
    expect(ids).toContain('kimi-k2.6')
    expect(ids).toContain('kimi-k2.5')
    expect(ids).toContain('kimi-k2-thinking')
    // Coding-plan-only ids must NOT leak into the platform catalog
    expect(ids).not.toContain('kimi-for-coding')
    expect(ids).not.toContain('k3')
  })

  it('forces temperature=1 for Kimi K3 (reasoning model, all endpoints)', () => {
    // K3 rejects any temperature other than 1 (confirmed 400 from Moonshot).
    // The rule is model-based, so it must hold for the dedicated preset AND for
    // a hand-rolled openai-compatible Moonshot provider (the user's setup) AND
    // the coding-plan short id.
    expect(resolveModelTemperature({ providerType: 'kimi' }, 'kimi-k3', 0.3)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'openai-compatible' }, 'kimi-k3', 0.3)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'kimi-coding' }, 'k3', 0.7)).toBe(1)
    // A per-provider fixedTemperature override still wins over the constraint.
    expect(resolveModelTemperature(
      { providerType: 'kimi', models: [{ id: 'kimi-k3', name: 'K3', fixedTemperature: 0.5 }] },
      'kimi-k3', 0.3,
    )).toBe(0.5)
  })

  it('exposes the kimi-coding subscription preset backed by the pi-ai catalog', () => {
    // Distinct api-key provider (Anthropic-messages endpoint), NOT OAuth —
    // Moonshot has no OAuth flow. Models resolve from pi-ai's kimi-coding catalog.
    const models = getAvailableModels('kimi-coding')
    const ids = models.map(m => m.id)
    expect(ids).toContain('k3')
    expect(models.length).toBeGreaterThan(0)
  })

  it('coalesces concurrent OAuth refreshes into one call (no rotating-token reuse)', async () => {
    // Two turns hitting an expired token concurrently must NOT both call
    // refresh() with the same rotated refresh token — that revokes the whole
    // family on Anthropic (incident 2026-07-22).
    // Point DATA_DIR at an empty dir so the re-read finds no stored provider
    // and falls back to the passed creds.
    process.env.DATA_DIR = path.join(os.tmpdir(), `axiom-oauth-coalesce-${Date.now()}`)
    const expired = { type: 'oauth' as const, access: 'old', refresh: 'old-r', expires: Date.now() - 1000 }
    const refresh = vi.fn(async (c: { expires: number }) => {
      await new Promise(r => setTimeout(r, 20))
      return { ...c, type: 'oauth' as const, access: 'new', refresh: 'new-r', expires: Date.now() + 3_600_000 }
    })
    const mockAuth = { name: 'test', refresh, toAuth: async () => ({ apiKey: 'x' }), login: async () => expired } as never

    const [a, b] = await Promise.all([
      refreshOAuthCredentialsLocked('missing-id', mockAuth, expired),
      refreshOAuthCredentialsLocked('missing-id', mockAuth, expired),
    ])

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(a.access).toBe('new')
    expect(b.access).toBe('new')

    // A later refresh (map cleared) triggers a fresh call.
    await refreshOAuthCredentialsLocked('missing-id', mockAuth, expired)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('resolveModelTemperature forces temperature=1 for Kimi K2 thinking models', () => {
    const provider = {
      providerType: 'kimi' as const,
    }
    // Reasoning-constrained models must override requested temperature
    expect(resolveModelTemperature(provider, 'kimi-k2.6', 0)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2.5', 0.3)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2-thinking', 0)).toBe(1)
    expect(resolveModelTemperature(provider, 'kimi-k2-thinking-turbo', 0)).toBe(1)
    // Non-reasoning previews keep the caller's temperature
    expect(resolveModelTemperature(provider, 'kimi-k2-0905-preview', 0)).toBe(0)
    expect(resolveModelTemperature(provider, 'kimi-k2-turbo-preview', 0.5)).toBe(0.5)
    // Unknown model id passes through unchanged
    expect(resolveModelTemperature(provider, 'some-other-model', 0.7)).toBe(0.7)
  })

  it('resolveModelTemperature applies pi-ai catalog Kimi K2 constraints for OpenCode presets', () => {
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'kimi-k2.7-code', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'kimi-k2.6', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-zen' as const }, 'kimi-k2.5', 0)).toBe(1)
    expect(resolveModelTemperature({ providerType: 'opencode-go' as const }, 'glm-5.1', 0)).toBe(0)
  })

  it('presetSupportsTextVerbosity is true only for openai-codex-responses presets', () => {
    expect(presetSupportsTextVerbosity('openai-codex')).toBe(true)
    expect(presetSupportsTextVerbosity('openai')).toBe(false)
    expect(presetSupportsTextVerbosity('anthropic')).toBe(false)
    expect(presetSupportsTextVerbosity('github-copilot')).toBe(false)
  })

  it('resolveModelTemperature respects per-provider models[].fixedTemperature override', () => {
    const provider = {
      providerType: 'openai' as const,
      models: [{ id: 'gpt-custom', fixedTemperature: 0.42 }],
    }
    expect(resolveModelTemperature(provider, 'gpt-custom', 0)).toBe(0.42)
    expect(resolveModelTemperature(provider, 'gpt-4o', 0.8)).toBe(0.8)
  })

  it('buildModel picks up metadata from override catalog for kimi', () => {
    const provider = {
      id: 'test-id',
      name: 'kimi',
      type: 'openai-completions',
      providerType: 'kimi' as const,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKey: 'sk-test',
      enabledModels: ['kimi-k2-thinking'],
    }
    const model = buildModel(provider)
    expect(model.id).toBe('kimi-k2-thinking')
    expect(model.name).toBe('Kimi K2 Thinking')
    expect(model.contextWindow).toBe(262_144)
    expect(model.reasoning).toBe(true)
    expect(model.cost.input).toBe(0.6)
    expect(model.cost.output).toBe(2.5)
    expect(model.cost.cacheRead).toBe(0.15)
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.moonshot.ai/v1')
  })
})

describe('OpenCode Zen/Go catalog presets (sourced from pi-ai)', () => {
  const makeProvider = (providerType: 'opencode-go' | 'opencode-zen', defaultModel: string) => ({
    id: 'test-id',
    name: providerType,
    type: 'openai-completions',
    providerType,
    provider: providerType === 'opencode-zen' ? 'opencode' : 'opencode-go',
    baseUrl: PROVIDER_TYPE_PRESETS[providerType].baseUrl,
    apiKey: 'sk-test',
    enabledModels: [defaultModel],
  })

  it('groups OpenCode Go under Subscription (api-key auth, subscription flag) but not Zen', () => {
    expect(PROVIDER_TYPE_PRESETS['opencode-go'].subscription).toBe(true)
    expect(PROVIDER_TYPE_PRESETS['opencode-go'].authMethod).toBe('api-key')
    expect(PROVIDER_TYPE_PRESETS['opencode-zen'].subscription).toBeUndefined()
  })

  it('getAvailableModels resolves the OpenCode Go catalog from pi-ai', () => {
    const ids = getAvailableModels('opencode-go').map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('glm-5.1')
    expect(ids).toContain('kimi-k2.6')
  })

  it('getAvailableModels resolves the OpenCode Zen catalog from pi-ai', () => {
    const ids = getAvailableModels('opencode-zen').map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toContain('claude-opus-4-5')
    expect(ids).toContain('gemini-3.5-flash')
    expect(ids).toContain('gpt-5.5')
  })

  it('buildModel uses real per-token costs for OpenCode Go (not the old zeroed override)', () => {
    const model = buildModel(makeProvider('opencode-go', 'glm-5.1'))
    expect(model.id).toBe('glm-5.1')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://opencode.ai/zen/go/v1')
    expect(model.cost.input).toBeGreaterThan(0)
    expect(model.cost.output).toBeGreaterThan(0)
  })

  it('buildModel resolves per-model api + baseUrl for OpenCode Zen models across wire APIs', () => {
    const claude = buildModel(makeProvider('opencode-zen', 'claude-opus-4-5'))
    expect(claude.api).toBe('anthropic-messages')
    expect(claude.baseUrl).toContain('opencode.ai/zen')
    expect(claude.cost.input).toBeGreaterThan(0)

    const gemini = buildModel(makeProvider('opencode-zen', 'gemini-3.5-flash'))
    expect(gemini.api).toBe('google-generative-ai')

    const gpt = buildModel(makeProvider('opencode-zen', 'gpt-5.5'))
    expect(gpt.api).toBe('openai-responses')

    const glm = buildModel(makeProvider('opencode-zen', 'glm-5.1'))
    expect(glm.api).toBe('openai-completions')
  })

  it('does not change api-key providers without resolveModelsFromCatalog (openai stays single-api)', () => {
    const provider = {
      id: 'test-id',
      name: 'openai',
      type: 'openai-completions',
      providerType: 'openai' as const,
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      enabledModels: ['gpt-4o'],
    }
    const model = buildModel(provider)
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://api.openai.com/v1')
  })
})

describe('syncNewCatalogModels', () => {
  let tmpDir: string
  const originalDataDir = process.env.DATA_DIR

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir
    else delete process.env.DATA_DIR
  })

  function setup(providers: object[]): void {
    tmpDir = path.join(os.tmpdir(), `axiom-catalog-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const configDir = path.join(tmpDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      path.join(configDir, 'providers.json'),
      JSON.stringify({ providers }, null, 2),
      'utf-8',
    )
    process.env.DATA_DIR = tmpDir
  }

  function anthropicProvider(overrides: object = {}): object {
    return {
      id: 'anth-1',
      name: 'Anthropic',
      type: 'anthropic-messages',
      providerType: 'anthropic',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      enabledModels: ['claude-opus-4-8'],
      ...overrides,
    }
  }

  it('first run records the catalog baseline without enabling anything', () => {
    setup([anthropicProvider()])
    const results = syncNewCatalogModels()
    expect(results).toEqual([])

    const saved = loadProviders().providers[0]
    expect(saved.enabledModels).toEqual(['claude-opus-4-8'])
    const catalogIds = getAvailableModels('anthropic').map(m => m.id)
    expect(saved.knownModels).toEqual(catalogIds)
    expect(catalogIds.length).toBeGreaterThan(0)
  })

  it('appends catalog models missing from knownModels to the end of enabledModels', () => {
    const catalogIds = getAvailableModels('anthropic').map(m => m.id)
    const newModel = catalogIds[catalogIds.length - 1]
    setup([anthropicProvider({ knownModels: catalogIds.filter(id => id !== newModel) })])

    const results = syncNewCatalogModels()
    expect(results).toEqual([
      { providerId: 'anth-1', providerName: 'Anthropic', added: [newModel] },
    ])

    const saved = loadProviders().providers[0]
    expect(saved.enabledModels).toEqual(['claude-opus-4-8', newModel])
    expect(saved.enabledModels?.[0]).toBe('claude-opus-4-8')
    expect(saved.knownModels).toContain(newModel)
  })

  it('leaves user-unchecked models alone once they are known', () => {
    const catalogIds = getAvailableModels('anthropic').map(m => m.id)
    setup([anthropicProvider({ knownModels: catalogIds })])

    const results = syncNewCatalogModels()
    expect(results).toEqual([])
    expect(loadProviders().providers[0].enabledModels).toEqual(['claude-opus-4-8'])
  })

  it('does not re-add a new model the user already enabled manually', () => {
    const catalogIds = getAvailableModels('anthropic').map(m => m.id)
    const newModel = catalogIds[catalogIds.length - 1]
    setup([anthropicProvider({
      enabledModels: ['claude-opus-4-8', newModel],
      knownModels: catalogIds.filter(id => id !== newModel),
    })])

    const results = syncNewCatalogModels()
    expect(results).toEqual([])
    expect(loadProviders().providers[0].enabledModels).toEqual(['claude-opus-4-8', newModel])
    expect(loadProviders().providers[0].knownModels).toContain(newModel)
  })

  it('keeps vanished catalog models in knownModels (grow-only union)', () => {
    const catalogIds = getAvailableModels('anthropic').map(m => m.id)
    setup([anthropicProvider({ knownModels: [...catalogIds, 'claude-legacy-gone'] })])

    syncNewCatalogModels()
    expect(loadProviders().providers[0].knownModels).toContain('claude-legacy-gone')
  })

  it('skips providers without a pi-ai catalog', () => {
    setup([{
      id: 'oll-1',
      name: 'ollama',
      type: 'openai-completions',
      providerType: 'ollama',
      provider: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      enabledModels: ['qwen3:30b'],
    }])

    const results = syncNewCatalogModels()
    expect(results).toEqual([])
    const saved = loadProviders().providers[0]
    expect(saved.knownModels).toBeUndefined()
    expect(saved.enabledModels).toEqual(['qwen3:30b'])
  })
})
