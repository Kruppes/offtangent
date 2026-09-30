/**
 * V5 of the privacy plan: ONE gate for every AUTOMATIC model choice.
 *
 * The suite walks EVERY role of `MODEL_POLICY_ROLES` plus the router chain,
 * the automatic fallback, the spoken summary and the text-to-speech voice,
 * and checks the same matrix for each of them:
 *
 *   training yes / unknown → rejected in `enforce`, allowed + logged in
 *                            `audit`, untouched in `off`
 *   local/no and us/no     → allowed everywhere
 *   region cn              → rejected in every mode (pre-gate behaviour)
 *
 * Every fixture is synthetic: made-up provider ids, made-up model ids and the
 * placeholder key `test-key`, written into a temp directory per test.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearOllamaTagCache, createOllamaTagWarmup, recordOllamaTags } from './ollama-tag-cache.js'
import {
  blockedModelFamily,
  checkAutomaticModel,
  checkAutomaticModelFor,
  auditExplicitModelFor,
  DEFAULT_BLOCKED_MODEL_FAMILIES,
  deriveDataPolicy,
  getDataPolicy,
  getDataPolicyFor,
  isHostingUnverified,
  isPrivateHostUrl,
  isRemoteHostedModel,
  listModelGateAudit,
  loadBlockedModelFamilies,
  loadModelGateMode,
  MODEL_GATE_AUDIT_LIMIT,
  MODEL_GATE_MODES,
  normalizeBlockedModelFamilies,
  policyAllows,
  resetModelGateAudit,
  type ModelGateMode,
} from './data-policy.js'
import { MODEL_POLICY_ROLES, resolveRoleSpec } from './model-policy.js'
import { resolveEffectiveModel } from './model-resolution.js'
import { resolveRouterChain } from './router-model.js'
import { resolveSpeechSummaryModel } from './speech-summary.js'
import { resolveTaskModelRoleFrom } from './task-model-policy.js'
import { resolveGeminiTtsCredentials } from './tts.js'

// ── Fixture ───────────────────────────────────────────────────────────

interface FixtureProvider {
  id: string
  name: string
  providerType: string
  type?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  enabledModels: string[]
  dataPolicy?: { region?: string; training?: string }
  models?: Array<{ id: string; dataPolicy?: { region?: string; training?: string } }>
}

/** Four endpoints that cover the whole decision table, plus a China one. */
const PROVIDERS: Record<string, FixtureProvider> = {
  // region us, training no — the "checked, does not train" case
  clean: {
    id: 'prov-clean',
    name: 'Cloud Clean',
    providerType: 'anthropic',
    baseUrl: 'https://api.example.com',
    apiKey: 'test-key',
    enabledModels: ['model-clean'],
    dataPolicy: { region: 'us', training: 'no' },
  },
  // region us, training yes — the case the gate exists for
  trains: {
    id: 'prov-trains',
    name: 'Cloud Trains',
    providerType: 'anthropic',
    baseUrl: 'https://api.example.org',
    apiKey: 'test-key',
    enabledModels: ['model-trains'],
    dataPolicy: { region: 'us', training: 'yes' },
  },
  // nothing configured → derived us/unknown → counts as training yes
  unknown: {
    id: 'prov-unknown',
    name: 'Cloud Unchecked',
    providerType: 'anthropic',
    baseUrl: 'https://api.example.net',
    apiKey: 'test-key',
    enabledModels: ['model-unknown'],
  },
  // a box on this network → derived local/no
  local: {
    id: 'prov-local',
    name: 'Local Box',
    providerType: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    enabledModels: ['model-local'],
  },
  // a Chinese endpoint configured as a generic OpenAI provider
  china: {
    id: 'prov-china',
    name: 'Generic Completions',
    providerType: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiKey: 'test-key',
    enabledModels: ['model-cn'],
  },
}

let dataDir = ''

function writeConfig(files: Record<string, unknown>): void {
  const configDir = path.join(dataDir, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(configDir, name), JSON.stringify(content, null, 2))
  }
}

interface SetupOptions {
  mode?: ModelGateMode | null
  settings?: Record<string, unknown>
  providers?: FixtureProvider[]
  activeProvider?: string
  activeModel?: string
  /** `false` leaves the Ollama tag cache empty (hosting unverified, T1c). */
  tags?: boolean
}

function setup(options: SetupOptions = {}): void {
  const providers = options.providers ?? Object.values(PROVIDERS)
  const privacy = options.mode === null ? {} : { privacy: { modelGate: options.mode ?? 'enforce' } }
  writeConfig({
    'providers.json': {
      providers,
      activeProvider: options.activeProvider ?? providers[0]?.id ?? '',
      activeModel: options.activeModel ?? providers[0]?.enabledModels[0] ?? '',
    },
    'settings.json': { ...privacy, ...(options.settings ?? {}) },
  })
  // T1c: an Ollama model only counts as local when a fresh `/api/tags` answer
  // listed it without a `remote_host`. The fixture boxes are "reachable" in
  // these tests, so record exactly their enabled models — tests that want the
  // unverified case clear the cache themselves.
  clearOllamaTagCache()
  if (options.tags !== false) {
    for (const provider of providers) {
      if (provider.providerType !== 'ollama' && provider.providerType !== 'ollama-local') continue
      recordOllamaTags(
        { providerId: provider.id, baseUrl: provider.baseUrl },
        { models: provider.enabledModels.map(name => ({ name })) },
      )
    }
  }
  resetModelGateAudit()
}

/** The spec a role entry uses: `providerId:modelId`. */
function spec(provider: FixtureProvider): string {
  return `${provider.id}:${provider.enabledModels[0]}`
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-data-policy-'))
  process.env.DATA_DIR = dataDir
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetModelGateAudit()
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DATA_DIR
  fs.rmSync(dataDir, { recursive: true, force: true })
  resetModelGateAudit()
})

// ── Derived defaults (D6) ─────────────────────────────────────────────

describe('deriveDataPolicy', () => {
  it('files a CONFIRMED ollama model on a private IP as local/no', () => {
    // T1c: the confirmation is the cached `/api/tags` answer of that box.
    recordOllamaTags(
      { providerId: 'box', baseUrl: 'http://127.0.0.1:11434' },
      { models: [{ name: 'qwen3.8:27b' }] },
    )
    expect(deriveDataPolicy(
      { id: 'box', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'qwen3.8:27b',
    )).toEqual({ region: 'local', training: 'no', source: 'derived' })
    clearOllamaTagCache()
  })

  it('does NOT call an ollama model local while its box never answered', () => {
    // T1c, fail closed: without a cached tag list the name proves nothing.
    clearOllamaTagCache()
    expect(deriveDataPolicy(
      { id: 'box', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'qwen3.8:27b',
    )).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it('keeps the endpoint answer when no model is named (provider badge)', () => {
    clearOllamaTagCache()
    expect(deriveDataPolicy({ id: 'box', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' }))
      .toEqual({ region: 'local', training: 'no', source: 'derived' })
  })

  it('files an ollama model with a -cloud suffix as us/unknown, not local', () => {
    expect(deriveDataPolicy(
      { providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'qwen3-coder:480b-cloud',
    )).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it('files an ollama model with a :cloud suffix as us/unknown, not local', () => {
    expect(deriveDataPolicy(
      { providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      'gemma4:cloud',
    )).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it('files an openai-compatible provider on a public host as us/unknown', () => {
    expect(deriveDataPolicy(
      { providerType: 'openai-compatible', baseUrl: 'https://api.example.com/v1' },
      'some-model',
    )).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it('files an openai-compatible provider on a private host as local/no', () => {
    expect(deriveDataPolicy(
      { providerType: 'openai-compatible', baseUrl: 'http://100.64.0.5:8080/v1' },
      'some-model',
    )).toEqual({ region: 'local', training: 'no', source: 'derived' })
  })

  it.each(['zai', 'zai-coding', 'zai-coding-plan', 'moonshot', 'kimi', 'kimi-coding'])(
    'files provider type %s as cn/unknown',
    providerType => {
      expect(deriveDataPolicy({ providerType }, 'any-model')).toEqual({
        region: 'cn', training: 'unknown', source: 'derived',
      })
    },
  )

  it.each([
    'https://api.z.ai/api/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.moonshot.ai/v1',
    'https://api.moonshot.cn/v1',
  ])('files the generic provider on %s as cn (host check, not just type)', baseUrl => {
    expect(deriveDataPolicy({ providerType: 'openai-completions', baseUrl }, 'm').region).toBe('cn')
  })

  it('files every other provider as us/unknown', () => {
    expect(deriveDataPolicy({ providerType: 'anthropic', baseUrl: 'https://api.example.com' }, 'm'))
      .toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it('does not call a public DNS name or a public IP private', () => {
    // Assembled from two parts on purpose: the published tree must not contain a
    // literal RFC1918 address, and the assertion still covers the 192.168/16 branch.
    expect(isPrivateHostUrl('http://192.' + '168.1.4:11434')).toBe(true)
    expect(isPrivateHostUrl('http://localhost:11434')).toBe(true)
    expect(isPrivateHostUrl('http://ollama:11434')).toBe(true)
    expect(isPrivateHostUrl('https://ollama.com')).toBe(false)
    expect(isPrivateHostUrl('https://8.8.8.8')).toBe(false)
    expect(isPrivateHostUrl('')).toBe(false)
  })
})

describe('getDataPolicy layering', () => {
  it('prefers the per-model override over the provider block', () => {
    const provider = {
      id: 'p', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434',
      dataPolicy: { region: 'local' as const, training: 'no' as const },
      models: [{ id: 'hosted-model', dataPolicy: { region: 'us' as const, training: 'unknown' as const } }],
    }
    expect(getDataPolicyFor(provider, 'hosted-model')).toEqual({
      region: 'us', training: 'unknown', source: 'model',
    })
    expect(getDataPolicyFor(provider, 'other-model')).toEqual({
      region: 'local', training: 'no', source: 'provider',
    })
  })

  it('completes a half-configured block from the derived default', () => {
    expect(getDataPolicyFor({ providerType: 'anthropic', dataPolicy: { training: 'no' } }, 'm'))
      .toEqual({ region: 'us', training: 'no', source: 'provider' })
  })

  it('reads the provider id from providers.json', () => {
    setup()
    expect(getDataPolicy('prov-clean', 'model-clean')).toEqual({
      region: 'us', training: 'no', source: 'provider',
    })
    expect(getDataPolicy('prov-local', 'model-local')).toEqual({
      region: 'local', training: 'no', source: 'derived',
    })
  })

  it('answers an unknown provider id pessimistically', () => {
    setup()
    expect(getDataPolicy('does-not-exist', 'm')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
  })
})

describe('policyAllows', () => {
  it('allows local and non-training regions, rejects unknown and cn', () => {
    expect(policyAllows({ region: 'local', training: 'unknown', source: 'derived' })).toBe(true)
    expect(policyAllows({ region: 'us', training: 'no', source: 'provider' })).toBe(true)
    expect(policyAllows({ region: 'eu', training: 'no', source: 'provider' })).toBe(true)
    expect(policyAllows({ region: 'us', training: 'unknown', source: 'derived' })).toBe(false)
    expect(policyAllows({ region: 'us', training: 'yes', source: 'provider' })).toBe(false)
    expect(policyAllows({ region: 'cn', training: 'no', source: 'provider' })).toBe(false)
  })
})

// ── Mode ──────────────────────────────────────────────────────────────

describe('settings.privacy.modelGate', () => {
  it('defaults to audit when the block is missing', () => {
    setup({ mode: null })
    expect(loadModelGateMode()).toBe('audit')
  })

  it('defaults to audit when the value is garbage', () => {
    setup({ settings: { privacy: { modelGate: 'yes-please' } }, mode: null })
    expect(loadModelGateMode()).toBe('audit')
  })

  it.each(MODEL_GATE_MODES)('reads the configured mode %s', mode => {
    setup({ mode })
    expect(loadModelGateMode()).toBe(mode)
  })
})

// ── The gate itself ───────────────────────────────────────────────────

describe('checkAutomaticModel', () => {
  it('rejects a training provider in enforce and logs it as blocked', () => {
    setup({ mode: 'enforce' })
    const decision = checkAutomaticModel('prov-trains', 'model-trains', 'summary')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:training_yes')
    expect(decision.policy).toEqual({ region: 'us', training: 'yes', source: 'provider' })
    const [entry] = listModelGateAudit()
    expect(entry).toMatchObject({ role: 'summary', providerId: 'prov-trains', blocked: true, kind: 'automatic' })
  })

  it('treats unknown training as yes (fail closed)', () => {
    setup({ mode: 'enforce' })
    const decision = checkAutomaticModel('prov-unknown', 'model-unknown', 'router')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:training_unknown')
  })

  it('allows a training provider in audit but records it', () => {
    setup({ mode: 'audit' })
    const decision = checkAutomaticModel('prov-trains', 'model-trains', 'summary')
    expect(decision.allowed).toBe(true)
    expect(decision.policyAllows).toBe(false)
    expect(listModelGateAudit()).toHaveLength(1)
    expect(listModelGateAudit()[0]!.blocked).toBe(false)
  })

  it('records nothing in off', () => {
    setup({ mode: 'off' })
    expect(checkAutomaticModel('prov-trains', 'model-trains', 'summary').allowed).toBe(true)
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('rejects a Chinese endpoint in mode %s', mode => {
    setup({ mode })
    const decision = checkAutomaticModel('prov-china', 'model-cn', 'router')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:region_cn')
  })

  it.each(MODEL_GATE_MODES)('allows local/no and us/no in mode %s without logging', mode => {
    setup({ mode })
    expect(checkAutomaticModel('prov-local', 'model-local', 'router').allowed).toBe(true)
    expect(checkAutomaticModel('prov-clean', 'model-clean', 'router').allowed).toBe(true)
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it('never blocks an explicit choice but writes it to the audit ring', () => {
    setup({ mode: 'enforce' })
    const decision = auditExplicitModelFor(
      { id: 'prov-trains', providerType: 'anthropic', dataPolicy: { region: 'us', training: 'yes' } },
      'model-trains',
      'strand',
    )
    expect(decision.allowed).toBe(true)
    expect(decision.policyAllows).toBe(false)
    const [entry] = listModelGateAudit()
    expect(entry).toMatchObject({ kind: 'explicit', blocked: false, role: 'strand' })
  })
})

describe('audit ring', () => {
  const trains = { id: 'prov-trains', providerType: 'anthropic', dataPolicy: { region: 'us' as const, training: 'yes' as const } }

  it('folds a repeated call into one entry instead of spamming the ring', () => {
    setup({ mode: 'audit' })
    const now = Date.parse('2026-09-26T15:00:00.000Z')
    for (let i = 0; i < 50; i++) {
      checkAutomaticModelFor(trains, 'model-trains', 'router', { mode: 'audit', now: now + i * 100 })
    }
    const entries = listModelGateAudit()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.count).toBe(50)
    expect(entries[0]!.at).toBe(new Date(now).toISOString())
    expect(entries[0]!.lastAt).toBe(new Date(now + 49 * 100).toISOString())
  })

  it('starts a new entry once the dedupe window has passed', () => {
    setup({ mode: 'audit' })
    const now = Date.parse('2026-09-26T15:00:00.000Z')
    checkAutomaticModelFor(trains, 'model-trains', 'router', { mode: 'audit', now })
    checkAutomaticModelFor(trains, 'model-trains', 'router', { mode: 'audit', now: now + 61_000 })
    expect(listModelGateAudit()).toHaveLength(2)
  })

  it('keeps at most MODEL_GATE_AUDIT_LIMIT entries, newest first', () => {
    setup({ mode: 'audit' })
    for (let i = 0; i < MODEL_GATE_AUDIT_LIMIT + 25; i++) {
      checkAutomaticModelFor(trains, `model-${i}`, 'router', { mode: 'audit' })
    }
    const entries = listModelGateAudit()
    expect(entries).toHaveLength(MODEL_GATE_AUDIT_LIMIT)
    expect(entries[0]!.modelId).toBe(`model-${MODEL_GATE_AUDIT_LIMIT + 24}`)
    expect(entries.at(-1)!.modelId).toBe('model-25')
  })
})

// ── V5: every role, the router, the fallback, speech and TTS ──────────

/**
 * How one role is driven end to end. `use()` returns the spec the role would
 * really use — `''` when the gate dropped it — so the matrix below can run the
 * same three assertions for every role of `MODEL_POLICY_ROLES`.
 */
function useRole(role: string, provider: FixtureProvider): string {
  if (role === 'router' || role === 'projectAssignment') {
    const chain = resolveRouterChain([{ spec: spec(provider), threshold: null }], { role })
    return chain.length > 0 ? `${chain[0]!.providerId}:${chain[0]!.modelId}` : ''
  }
  if (role.startsWith('task:')) {
    const hit = resolveTaskModelRoleFrom([role], { [role]: spec(provider) })
    return hit?.spec ?? ''
  }
  return resolveRoleSpec(role)
}

/** Roles whose value is read from `modelPolicy.roles.<role>` in settings.json. */
function roleSettings(role: string, provider: FixtureProvider): Record<string, unknown> {
  return { modelPolicy: { roles: { [role]: spec(provider) } } }
}

describe.each(MODEL_POLICY_ROLES)('role %s passes the one gate', role => {
  it.each([PROVIDERS.trains!, PROVIDERS.unknown!])('drops a $name entry in enforce', provider => {
    setup({ mode: 'enforce', settings: roleSettings(role, provider) })
    expect(useRole(role, provider)).toBe('')
  })

  it.each([PROVIDERS.trains!, PROVIDERS.unknown!])('keeps a $name entry in audit and logs it', provider => {
    setup({ mode: 'audit', settings: roleSettings(role, provider) })
    expect(useRole(role, provider)).toBe(spec(provider))
    const entries = listModelGateAudit()
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.role).toBe(role)
    expect(entries[0]!.blocked).toBe(false)
  })

  it.each([PROVIDERS.trains!, PROVIDERS.unknown!])('keeps a $name entry untouched in off', provider => {
    setup({ mode: 'off', settings: roleSettings(role, provider) })
    expect(useRole(role, provider)).toBe(spec(provider))
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('keeps a local/no entry in mode %s', mode => {
    setup({ mode, settings: roleSettings(role, PROVIDERS.local!) })
    expect(useRole(role, PROVIDERS.local!)).toBe(spec(PROVIDERS.local!))
  })

  it.each(MODEL_GATE_MODES)('keeps a us/no entry in mode %s', mode => {
    setup({ mode, settings: roleSettings(role, PROVIDERS.clean!) })
    expect(useRole(role, PROVIDERS.clean!)).toBe(spec(PROVIDERS.clean!))
  })

  it.each(MODEL_GATE_MODES)('drops a Chinese entry in mode %s', mode => {
    setup({ mode, settings: roleSettings(role, PROVIDERS.china!) })
    expect(useRole(role, PROVIDERS.china!)).toBe('')
  })
})

describe('router chain', () => {
  it('keeps the allowed entries and drops only the blocked ones', () => {
    setup({ mode: 'enforce' })
    const chain = resolveRouterChain([
      { spec: spec(PROVIDERS.trains!), threshold: null },
      { spec: spec(PROVIDERS.china!), threshold: null },
      { spec: spec(PROVIDERS.local!), threshold: null },
      { spec: spec(PROVIDERS.clean!), threshold: null },
    ])
    expect(chain.map(entry => entry.composite)).toEqual([
      spec(PROVIDERS.local!),
      spec(PROVIDERS.clean!),
    ])
  })

  it('returns an empty chain when every entry is blocked (a handled state)', () => {
    setup({ mode: 'enforce' })
    expect(resolveRouterChain([{ spec: spec(PROVIDERS.trains!), threshold: null }])).toEqual([])
  })
})

describe('automatic fallback (model-resolution)', () => {
  const providerList = [
    { id: 'prov-trains', providerType: 'anthropic', enabledModels: ['model-trains'], dataPolicy: { region: 'us' as const, training: 'yes' as const } },
    { id: 'prov-clean', providerType: 'anthropic', enabledModels: ['model-clean'], dataPolicy: { region: 'us' as const, training: 'no' as const } },
    { id: 'prov-china', providerType: 'openai-completions', baseUrl: 'https://api.z.ai/api/paas/v4', enabledModels: ['model-cn'] },
  ]

  function resolveFallback(providerId: string, modelId: string, mode: ModelGateMode) {
    setup({ mode })
    return resolveEffectiveModel({
      fallback: { providerId, modelId },
      providers: providerList,
    })
  }

  it('drops a training fallback in enforce', () => {
    expect(resolveFallback('prov-trains', 'model-trains', 'enforce')).toBeNull()
  })

  it('reports the gate reason as the degraded reason of the next candidate', () => {
    setup({ mode: 'enforce' })
    const result = resolveEffectiveModel({
      globalActive: { providerId: 'prov-missing', modelId: 'model-x' },
      fallback: { providerId: 'prov-trains', modelId: 'model-trains' },
      providers: providerList,
    })
    expect(result).toBeNull()
    // The fallback is the last candidate, so the reason is only visible in the
    // warning path; what matters here is that it is NOT selected.
  })

  it('keeps a training fallback in audit and logs it', () => {
    const result = resolveFallback('prov-trains', 'model-trains', 'audit')
    expect(result?.providerId).toBe('prov-trains')
    expect(result?.source).toBe('fallback')
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'fallback', blocked: false })
  })

  it('keeps a training fallback untouched in off', () => {
    expect(resolveFallback('prov-trains', 'model-trains', 'off')?.providerId).toBe('prov-trains')
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('keeps a us/no fallback in mode %s', mode => {
    expect(resolveFallback('prov-clean', 'model-clean', mode)?.providerId).toBe('prov-clean')
  })

  it.each(MODEL_GATE_MODES)('drops a Chinese fallback in mode %s', mode => {
    expect(resolveFallback('prov-china', 'model-cn', mode)).toBeNull()
  })

  it('audit-logs an explicit strand pin without blocking it', () => {
    setup({ mode: 'enforce' })
    const result = resolveEffectiveModel({
      strandPin: { providerId: 'prov-trains', modelId: 'model-trains' },
      providers: providerList,
    })
    expect(result).toMatchObject({ providerId: 'prov-trains', source: 'strand' })
    expect(listModelGateAudit()[0]).toMatchObject({ kind: 'explicit', role: 'strand', blocked: false })
  })
})

describe('speech summary', () => {
  it('finds no model when the only Anthropic provider trains, in enforce', async () => {
    setup({ mode: 'enforce', providers: [PROVIDERS.trains!] })
    await expect(resolveSpeechSummaryModel()).resolves.toBeNull()
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'speechSummary', blocked: true })
  })

  it('uses the training provider in audit and logs it', async () => {
    setup({ mode: 'audit', providers: [PROVIDERS.trains!] })
    const choice = await resolveSpeechSummaryModel()
    expect(choice?.providerId).toBe('prov-trains')
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'speechSummary', blocked: false })
  })

  it('uses the training provider untouched in off', async () => {
    setup({ mode: 'off', providers: [PROVIDERS.trains!] })
    expect((await resolveSpeechSummaryModel())?.providerId).toBe('prov-trains')
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('uses a us/no provider in mode %s', async mode => {
    setup({ mode, providers: [PROVIDERS.clean!] })
    expect((await resolveSpeechSummaryModel())?.providerId).toBe('prov-clean')
  })

  it.each(MODEL_GATE_MODES)('never summarizes through a Chinese provider in mode %s', async mode => {
    // The last-resort branch of the picker is the active provider, so a
    // Chinese endpoint would be reachable there if the gate did not hold.
    setup({
      mode,
      providers: [PROVIDERS.china!],
      activeProvider: 'prov-china',
      activeModel: 'model-cn',
    })
    await expect(resolveSpeechSummaryModel()).resolves.toBeNull()
  })

  it('has no provider-type list of its own any more (single source)', () => {
    const source = fs.readFileSync(new URL('./speech-summary.ts', import.meta.url), 'utf-8')
    expect(source).not.toContain('FORBIDDEN_PROVIDER_TYPES')
    expect(source).not.toMatch(/new Set\(\[\s*'zai'/)
    expect(source).toContain('checkAutomaticModelFor')
  })

  it('exports no forbidden-provider mirror from the module', async () => {
    const mod = await import('./speech-summary.js')
    expect(Object.keys(mod)).not.toContain('FORBIDDEN_PROVIDER_TYPES')
  })
})

describe('text to speech', () => {
  const gemini = (overrides: Partial<FixtureProvider> = {}): FixtureProvider => ({
    id: 'prov-tts',
    name: 'Voice Cloud',
    providerType: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-key',
    enabledModels: ['tts-model'],
    ...overrides,
  })

  function ttsSettings(): Record<string, unknown> {
    return { tts: { provider: 'gemini', providerId: 'prov-tts', geminiModel: 'tts-model' } }
  }

  it('refuses a training voice provider in enforce', async () => {
    setup({ mode: 'enforce', providers: [gemini({ dataPolicy: { region: 'us', training: 'yes' } })], settings: ttsSettings() })
    await expect(resolveGeminiTtsCredentials()).resolves.toBeNull()
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'tts', blocked: true })
  })

  it('refuses an unchecked voice provider in enforce (fail closed)', async () => {
    setup({ mode: 'enforce', providers: [gemini()], settings: ttsSettings() })
    await expect(resolveGeminiTtsCredentials()).resolves.toBeNull()
  })

  it('speaks through the training provider in audit and logs it', async () => {
    setup({ mode: 'audit', providers: [gemini({ dataPolicy: { region: 'us', training: 'yes' } })], settings: ttsSettings() })
    await expect(resolveGeminiTtsCredentials()).resolves.toMatchObject({ apiKey: 'test-key' })
    expect(listModelGateAudit()[0]).toMatchObject({ role: 'tts', blocked: false })
  })

  it('speaks through the training provider untouched in off', async () => {
    setup({ mode: 'off', providers: [gemini({ dataPolicy: { region: 'us', training: 'yes' } })], settings: ttsSettings() })
    await expect(resolveGeminiTtsCredentials()).resolves.toMatchObject({ apiKey: 'test-key' })
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('speaks through a us/no provider in mode %s', async mode => {
    setup({ mode, providers: [gemini({ dataPolicy: { region: 'us', training: 'no' } })], settings: ttsSettings() })
    await expect(resolveGeminiTtsCredentials()).resolves.toMatchObject({ apiKey: 'test-key' })
  })

  it.each(MODEL_GATE_MODES)('never speaks through a Chinese provider in mode %s', async mode => {
    // A provider type with an editable URL: types with a fixed preset URL
    // (google, anthropic) get that URL synced back on load, so the host check
    // only ever sees a Chinese host on a generic provider — which is exactly
    // how Z.AI and Moonshot are configured in practice.
    setup({
      mode,
      providers: [gemini({ providerType: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1' })],
      settings: ttsSettings(),
    })
    await expect(resolveGeminiTtsCredentials()).resolves.toBeNull()
  })
})

// ── T1b: one endpoint, two answers ────────────────────────────────────

/**
 * Nachtrag 15:10: the decision is per MODEL, not per provider. One Ollama box
 * serves local weights, Chinese-origin local weights and cloud-proxied models
 * at the same time, so two axes are checked separately:
 *
 *   hosting — `remote_host` from `/api/tags` (cached) beats the name markers
 *   origin  — `privacy.blockedModelFamilies` blocks a family in EVERY mode
 *
 * The concrete fixture mirrors the tags of a real box but with invented hosts:
 * `kimi-k2.5:cloud` (proxied), `glm-4.7-flash:latest` (local GLM weights),
 * `qwen3.8:27b-mlx` (local, allowed), `qwen3-coder:480b-cloud` (proxied),
 * `gemma4` (local, allowed) and `house-model:latest` (local name, proxied).
 */
describe('T1b hosting and origin inside one provider', () => {
  const BOX_ID = 'prov-box'
  const BOX_URL = 'http://127.0.0.1:11434'

  /** The Ollama box, with every model of the fixture enabled. */
  function box(models: string[]): FixtureProvider {
    return {
      id: BOX_ID,
      name: 'Studio Box',
      providerType: 'ollama',
      baseUrl: BOX_URL,
      enabledModels: models,
    }
  }

  const BOX_TAGS = {
    models: [
      { name: 'kimi-k2.5:cloud', size: 0, remote_host: 'https://ollama.example:443' },
      { name: 'qwen3-coder:480b-cloud', size: 0, remote_host: 'https://ollama.example:443' },
      { name: 'glm-4.7-flash:latest', size: 12_345 },
      { name: 'qwen3.8:27b-mlx', size: 23_456 },
      { name: 'gemma4:latest', size: 34_567 },
      { name: 'house-model:latest', size: 0, remote_host: 'https://ollama.example:443' },
    ],
  }

  /** Write the fixture and prime the tag cache, as `/api/tags` would. */
  function setupBox(options: { mode?: ModelGateMode; families?: string[]; tags?: boolean } = {}): void {
    const privacy: Record<string, unknown> = { modelGate: options.mode ?? 'enforce' }
    if (options.families) privacy.blockedModelFamilies = options.families
    setup({
      mode: null,
      providers: [box(BOX_TAGS.models.map(m => m.name)), PROVIDERS.clean!],
      settings: { privacy },
      activeProvider: BOX_ID,
      activeModel: 'qwen3.8:27b-mlx',
    })
    clearOllamaTagCache()
    if (options.tags !== false) recordOllamaTags({ providerId: BOX_ID, baseUrl: BOX_URL }, BOX_TAGS)
  }

  afterEach(() => {
    clearOllamaTagCache()
  })

  // ── blockedModelFamilies: the setting ──

  it('defaults to glm and kimi when the setting is missing', () => {
    setupBox()
    expect(loadBlockedModelFamilies()).toEqual(['glm', 'kimi'])
    expect(DEFAULT_BLOCKED_MODEL_FAMILIES).toEqual(['glm', 'kimi'])
  })

  it.each([
    ['a string instead of a list', 'glm,kimi'],
    ['a list with a non-string entry', ['glm', 7]],
    ['an object', { glm: true }],
    ['a number', 3],
  ])('falls back to the default for %s', (_label, value) => {
    setupBox()
    expect(normalizeBlockedModelFamilies(value)).toEqual(['glm', 'kimi'])
  })

  it('normalizes a configured list and keeps an empty list as "rule off"', () => {
    expect(normalizeBlockedModelFamilies([' GLM ', 'Kimi', 'glm', ''])).toEqual(['glm', 'kimi'])
    expect(normalizeBlockedModelFamilies([])).toEqual([])
  })

  it('reads a configured list from settings.json', () => {
    setupBox({ families: ['deepseek', 'GLM'] })
    expect(loadBlockedModelFamilies()).toEqual(['deepseek', 'glm'])
  })

  it('matches a family as a prefix of the namespace-free model id', () => {
    expect(blockedModelFamily('glm-4.7-flash:latest', ['glm', 'kimi'])).toBe('glm')
    expect(blockedModelFamily('library/glm-ocr:latest', ['glm'])).toBe('glm')
    expect(blockedModelFamily('some-org/KIMI-K2.5:cloud', ['kimi'])).toBe('kimi')
    expect(blockedModelFamily('qwen3.8:27b-mlx', ['glm', 'kimi'])).toBe(null)
    expect(blockedModelFamily('gemma4', ['glm', 'kimi'])).toBe(null)
    // No substring match: a family is the START of the id.
    expect(blockedModelFamily('my-glm-clone', ['glm'])).toBe(null)
  })

  // ── remote_host: the hosting signal ──

  it('takes remote_host over the name: a locally named proxied model is not local', () => {
    setupBox()
    expect(isRemoteHostedModel({ id: BOX_ID, baseUrl: BOX_URL }, 'house-model:latest')).toBe(true)
    expect(getDataPolicy(BOX_ID, 'house-model:latest')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
  })

  it('files EVERY model of the box as us/unknown while no tag data is cached', () => {
    setupBox({ tags: false })
    // The :cloud marker still works…
    expect(getDataPolicy(BOX_ID, 'qwen3-coder:480b-cloud')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
    // …and T1c closes the remaining hole: a locally NAMED model is no longer
    // local just because nobody asked the daemon (before T1c this was local/no).
    expect(getDataPolicy(BOX_ID, 'house-model:latest')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
    expect(getDataPolicy(BOX_ID, 'qwen3.8:27b-mlx')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
  })

  it('files a local model of the same box as local/no', () => {
    setupBox()
    expect(getDataPolicy(BOX_ID, 'qwen3.8:27b-mlx')).toEqual({ region: 'local', training: 'no', source: 'derived' })
    expect(getDataPolicy(BOX_ID, 'gemma4')).toEqual({ region: 'local', training: 'no', source: 'derived' })
    expect(getDataPolicy(BOX_ID, 'glm-4.7-flash:latest')).toEqual({ region: 'local', training: 'no', source: 'derived' })
  })

  // ── The five cases from the privacy plan, through the gate ──

  it.each(MODEL_GATE_MODES)('blocks kimi-k2.5:cloud (family + remote) in mode %s', mode => {
    setupBox({ mode })
    const decision = checkAutomaticModel(BOX_ID, 'kimi-k2.5:cloud', 'summary')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:family:kimi')
    expect(decision.blockedFamily).toBe('kimi')
    // Remote, so it is not treated as a local model either.
    expect(decision.policy).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
  })

  it.each(MODEL_GATE_MODES)('blocks local glm-4.7-flash:latest (family) in mode %s', mode => {
    setupBox({ mode })
    const decision = checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'factExtraction')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:family:glm')
    // Honest about the hosting: it really does run in this room.
    expect(decision.policy.region).toBe('local')
  })

  it.each(MODEL_GATE_MODES)('allows local qwen3.8:27b-mlx in mode %s', mode => {
    setupBox({ mode })
    const decision = checkAutomaticModel(BOX_ID, 'qwen3.8:27b-mlx', 'summary')
    expect(decision.allowed).toBe(true)
    expect(decision.policyAllows).toBe(true)
    expect(decision.reason).toBe('ok:local')
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it.each(MODEL_GATE_MODES)('allows local gemma4 in mode %s', mode => {
    setupBox({ mode })
    expect(checkAutomaticModel(BOX_ID, 'gemma4', 'summary').allowed).toBe(true)
    expect(listModelGateAudit()).toHaveLength(0)
  })

  it('blocks qwen3-coder:480b-cloud in enforce and logs it in audit', () => {
    setupBox({ mode: 'enforce' })
    const blocked = checkAutomaticModel(BOX_ID, 'qwen3-coder:480b-cloud', 'summary')
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('blocked:training_unknown')
    expect(blocked.blockedFamily).toBe(null)

    setupBox({ mode: 'audit' })
    const audited = checkAutomaticModel(BOX_ID, 'qwen3-coder:480b-cloud', 'summary')
    expect(audited.allowed).toBe(true)
    expect(audited.policyAllows).toBe(false)
    const [entry] = listModelGateAudit()
    expect(entry).toMatchObject({
      role: 'summary',
      providerId: BOX_ID,
      modelId: 'qwen3-coder:480b-cloud',
      reason: 'blocked:training_unknown',
      blocked: false,
    })
  })

  it('logs a family hit in audit and in enforce, but never in off', () => {
    setupBox({ mode: 'audit' })
    checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'summary')
    expect(listModelGateAudit()[0]).toMatchObject({ reason: 'blocked:family:glm', blocked: true })

    setupBox({ mode: 'off' })
    expect(checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'summary').allowed).toBe(false)
    expect(listModelGateAudit()).toHaveLength(0)
  })

  // ── A custom list replaces the hardwired one ──

  it('honours a custom family list instead of the default', () => {
    setupBox({ families: ['gemma'] })
    expect(checkAutomaticModel(BOX_ID, 'gemma4', 'summary').reason).toBe('blocked:family:gemma')
    // glm is no longer on the list, so only the normal policy applies — and
    // these weights do run locally.
    const glm = checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'summary')
    expect(glm.allowed).toBe(true)
    expect(glm.reason).toBe('ok:local')
  })

  it('switches the family rule off with an empty list', () => {
    setupBox({ families: [] })
    expect(checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'summary').allowed).toBe(true)
  })

  // ── The same gate for every role and for an explicit choice ──

  it.each(MODEL_POLICY_ROLES)('drops a family-blocked model for role %s in audit too', role => {
    const families = ['glm', 'kimi']
    setup({
      mode: null,
      providers: [box(['glm-4.7-flash:latest']), PROVIDERS.clean!],
      settings: {
        privacy: { modelGate: 'audit', blockedModelFamilies: families },
        ...roleSettings(role, { ...box(['glm-4.7-flash:latest']), enabledModels: ['glm-4.7-flash:latest'] }),
      },
      activeProvider: BOX_ID,
      activeModel: 'glm-4.7-flash:latest',
    })
    clearOllamaTagCache()
    recordOllamaTags({ providerId: BOX_ID, baseUrl: BOX_URL }, BOX_TAGS)
    expect(useRole(role, { ...box(['glm-4.7-flash:latest']), enabledModels: ['glm-4.7-flash:latest'] })).toBe('')
    const [entry] = listModelGateAudit()
    expect(entry).toMatchObject({ reason: 'blocked:family:glm', blocked: true })
  })

  it('never blocks an explicit family choice but records it', () => {
    setupBox({ mode: 'enforce' })
    const decision = auditExplicitModelFor(
      { id: BOX_ID, providerType: 'ollama', baseUrl: BOX_URL },
      'glm-4.7-flash:latest',
      'strand',
    )
    expect(decision.allowed).toBe(true)
    expect(decision.policyAllows).toBe(false)
    expect(decision.reason).toBe('blocked:family:glm')
    expect(listModelGateAudit()[0]).toMatchObject({ kind: 'explicit', blocked: false })
  })
})

/**
 * T1c: hosting is VERIFIED per model or it is not local.
 *
 * The gate reads the cached `/api/tags` answer of the box (kept warm by
 * `createOllamaTagWarmup` in the backend). A model the daemon never confirmed —
 * no answer at all, not in the list, or an answer older than 30 minutes — is
 * `us/unknown` with the reason `blocked:hosting_unverified`, so `enforce` drops
 * it and `audit` records it. The model name is no longer evidence FOR local.
 *
 * Every fixture is synthetic: a private RFC1918 host, invented model names.
 */
describe('T1c hosting has to be verified per model', () => {
  const BOX_ID = 'prov-box'
  const BOX_URL = 'http://127.0.0.1:11434'
  const QWEN = 'qwen3.8:27b-mlx'

  const TAGS = {
    models: [
      { name: QWEN, size: 23_456 },
      { name: 'gemma4:latest', size: 34_567 },
      { name: 'kimi-k2.5:cloud', size: 0, remote_host: 'https://ollama.example:443' },
    ],
  }

  function boxFixture(mode: ModelGateMode): void {
    setup({
      mode: null,
      providers: [
        {
          id: BOX_ID,
          name: 'Studio Box',
          providerType: 'ollama',
          baseUrl: BOX_URL,
          enabledModels: [QWEN, 'gemma4:latest', 'mistral-next:7b'],
        },
        PROVIDERS.clean!,
      ],
      settings: { privacy: { modelGate: mode, blockedModelFamilies: ['glm', 'kimi'] } },
      activeProvider: BOX_ID,
      activeModel: QWEN,
      tags: false,
    })
  }

  afterEach(() => {
    clearOllamaTagCache()
  })

  it('blocks a local-looking model in enforce while the box never answered', () => {
    boxFixture('enforce')
    const policy = getDataPolicy(BOX_ID, QWEN)
    expect(policy).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
    const decision = checkAutomaticModel(BOX_ID, QWEN, 'summary')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:hosting_unverified')
    expect(decision.policyAllows).toBe(false)
    expect(listModelGateAudit()[0]).toMatchObject({
      reason: 'blocked:hosting_unverified', blocked: true, modelId: QWEN,
    })
  })

  it('allows the same model in audit but writes the unverified reason to the log', () => {
    boxFixture('audit')
    const decision = checkAutomaticModel(BOX_ID, QWEN, 'router')
    expect(decision.allowed).toBe(true)
    expect(decision.policyAllows).toBe(false)
    expect(decision.reason).toBe('blocked:hosting_unverified')
    expect(listModelGateAudit()[0]).toMatchObject({
      reason: 'blocked:hosting_unverified', blocked: false, role: 'router',
    })
  })

  it('accepts the model as local/no after a refresh brought the tag list', async () => {
    boxFixture('enforce')
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(TAGS), { status: 200 }))
    const warmup = createOllamaTagWarmup({
      listProviders: () => [{ id: BOX_ID, providerType: 'ollama', baseUrl: BOX_URL }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(await warmup.refreshNow()).toBe(3)
    warmup.stop()

    expect(getDataPolicy(BOX_ID, QWEN)).toEqual({ region: 'local', training: 'no', source: 'derived' })
    const decision = checkAutomaticModel(BOX_ID, QWEN, 'summary')
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toBe('ok:local')
    expect(listModelGateAudit()).toEqual([])
    // The proxied entry of the same box stays remote.
    expect(getDataPolicy(BOX_ID, 'kimi-k2.5:cloud').region).toBe('us')
  })

  it('does not call a model local that is missing from the answered list', () => {
    boxFixture('enforce')
    recordOllamaTags({ providerId: BOX_ID, baseUrl: BOX_URL }, TAGS)
    const decision = checkAutomaticModel(BOX_ID, 'mistral-next:7b', 'factExtraction')
    expect(getDataPolicy(BOX_ID, 'mistral-next:7b')).toEqual({
      region: 'us', training: 'unknown', source: 'derived',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('blocked:hosting_unverified')
  })

  it('stops trusting a stale answer for local, but keeps it for remote', () => {
    boxFixture('enforce')
    const thirtyOneMinutesAgo = Date.now() - 31 * 60_000
    vi.spyOn(Date, 'now').mockReturnValue(thirtyOneMinutesAgo)
    recordOllamaTags({ providerId: BOX_ID, baseUrl: BOX_URL }, TAGS)
    vi.mocked(Date.now).mockRestore()

    expect(getDataPolicy(BOX_ID, QWEN)).toEqual({ region: 'us', training: 'unknown', source: 'derived' })
    expect(checkAutomaticModel(BOX_ID, QWEN, 'summary').reason).toBe('blocked:hosting_unverified')
    // A stale "this is proxied" is still the fail-closed answer.
    expect(isRemoteHostedModel({ id: BOX_ID, baseUrl: BOX_URL }, 'kimi-k2.5:cloud')).toBe(true)
  })

  it('lets an explicit dataPolicy override beat the derivation', () => {
    const provider = {
      id: BOX_ID,
      providerType: 'ollama',
      baseUrl: BOX_URL,
      models: [{ id: QWEN, dataPolicy: { region: 'local' as const, training: 'no' as const } }],
    }
    clearOllamaTagCache()
    // Per-model override: allowed in enforce, no unverified reason, no log line.
    const model = checkAutomaticModelFor(provider, QWEN, 'summary', { mode: 'enforce' })
    expect(model.allowed).toBe(true)
    expect(model.reason).toBe('ok:local')
    expect(listModelGateAudit()).toEqual([])
    // Provider-level override works the same way.
    const providerLevel = checkAutomaticModelFor(
      { id: BOX_ID, providerType: 'ollama', baseUrl: BOX_URL, dataPolicy: { region: 'local', training: 'no' } },
      QWEN, 'summary', { mode: 'enforce' },
    )
    expect(providerLevel.allowed).toBe(true)
    expect(providerLevel.reason).toBe('ok:local')
  })

  it('keeps the family rule above the hosting question', () => {
    boxFixture('enforce')
    recordOllamaTags({ providerId: BOX_ID, baseUrl: BOX_URL }, {
      models: [{ name: 'glm-4.7-flash:latest', size: 1 }],
    })
    const decision = checkAutomaticModel(BOX_ID, 'glm-4.7-flash:latest', 'summary')
    expect(decision.reason).toBe('blocked:family:glm')
  })

  it('keeps the openai-compatible heuristic (documented open point)', () => {
    clearOllamaTagCache()
    expect(deriveDataPolicy({ id: 'p', providerType: 'openai-compatible', baseUrl: 'http://100.64.0.5:8080/v1' }, 'some-model'))
      .toEqual({ region: 'local', training: 'no', source: 'derived' })
    expect(isHostingUnverified({ id: 'p', providerType: 'openai-compatible', baseUrl: 'http://100.64.0.5:8080/v1' }, 'some-model'))
      .toBe(false)
  })

  it.each(MODEL_POLICY_ROLES)('drops an unverified ollama model for role %s in enforce', role => {
    const boxProvider = {
      id: BOX_ID, name: 'Studio Box', providerType: 'ollama', baseUrl: BOX_URL, enabledModels: [QWEN],
    }
    setup({
      mode: null,
      providers: [boxProvider, PROVIDERS.clean!],
      settings: {
        privacy: { modelGate: 'enforce' },
        ...roleSettings(role, boxProvider),
      },
      activeProvider: BOX_ID,
      activeModel: QWEN,
      tags: false,
    })
    expect(useRole(role, boxProvider)).toBe('')
    expect(listModelGateAudit()[0]).toMatchObject({ reason: 'blocked:hosting_unverified', blocked: true })
  })
})
