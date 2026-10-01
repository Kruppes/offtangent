/**
 * Unit tests for the deterministic task policy (task-policy.ts).
 * Synthetic providers only; no providers.json, no network.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from './provider-config.js'
import {
  TASK_POLICY_DIFFICULTIES,
  TASK_POLICY_FAMILY_MODELS,
  TASK_POLICY_KINDS,
  TASK_POLICY_MATRIX,
  formatTaskRouting,
  isTaskPolicyExceptionModel,
  parseExplicitThinking,
  parseTaskProfile,
  parseTaskRouting,
  resolveTaskPolicy,
  serializeTaskRouting,
  taskModelFamily,
} from './task-policy.js'
import type { ResolveTaskPolicyInput, TaskProfile } from './task-policy.js'

function provider(id: string, providerType: string, enabledModels: string[]): ProviderConfig {
  return {
    id,
    name: `name-${id}`,
    type: providerType.startsWith('anthropic') ? 'anthropic-messages' : 'openai-completions',
    providerType,
    provider: providerType,
    baseUrl: 'http://localhost:1',
    apiKey: 'k',
    enabledModels,
  } as unknown as ProviderConfig
}

const ANTH = provider('anth', 'anthropic-oauth', ['claude-opus-5-5', 'claude-sonnet-5-5'])
const OAI = provider('oai', 'openai-codex', ['gpt-6-sol', 'gpt-6-luna'])
const LOCAL = provider('local', 'ollama', ['local-model'])
const ALL = [ANTH, OAI, LOCAL]

function base(overrides: Partial<ResolveTaskPolicyInput> = {}): ResolveTaskPolicyInput {
  return {
    profile: null,
    resolveProvider: (id) => ALL.find((p) => p.id === id || p.name === id) ?? null,
    resolveExplicit: ({ provider: p, model }) => {
      const hit = p ? ALL.find((x) => x.id === p || x.name === p) : ALL.find((x) => x.enabledModels?.includes(model ?? ''))
      if (!hit) return { ok: false, error: `unknown provider/model ${p ?? ''} ${model ?? ''}` }
      const modelId = model ?? hit.enabledModels![0]
      if (!hit.enabledModels!.includes(modelId)) return { ok: false, error: `model ${modelId} is not enabled` }
      return { ok: true, providerId: hit.id, providerName: hit.name, modelId }
    },
    // Default chain: a system default pinned to Opus (the "safety net").
    getDefaultProvider: () => ({ ...ANTH, enabledModels: ['claude-opus-5-5'] }),
    checkAutomatic: () => ({ allowed: true, reason: 'allowed' }),
    ...overrides,
  }
}

const profile = (kind: TaskProfile['kind'], difficulty: TaskProfile['difficulty']): TaskProfile => ({ kind, difficulty })

describe('task policy matrix', () => {
  it('defines every kind × difficulty cell and never chooses xhigh automatically', () => {
    for (const kind of TASK_POLICY_KINDS) {
      for (const difficulty of TASK_POLICY_DIFFICULTIES) {
        const cell = TASK_POLICY_MATRIX[kind][difficulty]
        expect(cell, `${kind}/${difficulty}`).toBeDefined()
        expect(['off', 'minimal', 'low', 'medium', 'high']).toContain(cell.thinking)
      }
    }
  })

  it('never lists an exception model as an automatic tier model', () => {
    for (const tiers of Object.values(TASK_POLICY_FAMILY_MODELS)) {
      for (const ids of Object.values(tiers)) {
        for (const id of ids) expect(isTaskPolicyExceptionModel(id), id).toBe(false)
      }
    }
  })

  it('scales thinking monotonically with difficulty per kind', () => {
    const order = ['off', 'minimal', 'low', 'medium', 'high']
    for (const kind of TASK_POLICY_KINDS) {
      const levels = TASK_POLICY_DIFFICULTIES.map((d) => order.indexOf(TASK_POLICY_MATRIX[kind][d].thinking))
      expect([...levels].sort((a, b) => a - b), kind).toEqual(levels)
    }
  })

  it('maps provider types to families and leaves others without matrix', () => {
    expect(taskModelFamily(ANTH)).toBe('anthropic')
    expect(taskModelFamily(provider('a', 'anthropic', []))).toBe('anthropic')
    expect(taskModelFamily(OAI)).toBe('openai')
    expect(taskModelFamily(provider('o', 'openai', []))).toBe('openai')
    expect(taskModelFamily(LOCAL)).toBeNull()
  })

  it('detects exception models on whole id segments only', () => {
    expect(isTaskPolicyExceptionModel('gpt-6-astra')).toBe(true)
    expect(isTaskPolicyExceptionModel('claude-fable-5-1')).toBe(true)
    expect(isTaskPolicyExceptionModel('gpt-6-sol')).toBe(false)
    expect(isTaskPolicyExceptionModel('castrality-1')).toBe(false)
    expect(isTaskPolicyExceptionModel('fabled-model')).toBe(false)
  })
})

describe('parsing', () => {
  it('returns null without any profile field', () => {
    expect(parseTaskProfile({})).toEqual({ ok: true, value: null })
    expect(parseTaskProfile({ task_kind: ' ', difficulty: '' })).toEqual({ ok: true, value: null })
  })

  it('fills the missing half with the fallback and normalizes case', () => {
    expect(parseTaskProfile({ task_kind: 'Coding' })).toEqual({ ok: true, value: { kind: 'coding', difficulty: 'medium' } })
    expect(parseTaskProfile({ difficulty: 'HIGH' })).toEqual({ ok: true, value: { kind: 'general', difficulty: 'high' } })
  })

  it('rejects unknown values instead of guessing', () => {
    expect(parseTaskProfile({ task_kind: 'architecture' }).ok).toBe(false)
    expect(parseTaskProfile({ difficulty: 'extreme' }).ok).toBe(false)
    expect(parseTaskProfile({ task_kind: 42 }).ok).toBe(false)
    expect(parseExplicitThinking('ultra').ok).toBe(false)
    expect(parseExplicitThinking('xhigh')).toEqual({ ok: true, value: 'xhigh' })
    expect(parseExplicitThinking(undefined)).toEqual({ ok: true, value: null })
  })

  it('round-trips the routing record and tolerates broken JSON', () => {
    const res = resolveTaskPolicy(base({ strandPin: { providerId: 'oai', modelId: 'gpt-6-sol' }, profile: profile('research', 'low') }))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(parseTaskRouting(serializeTaskRouting(res.routing))).toEqual(res.routing)
    expect(parseTaskRouting('{broken')).toBeNull()
    expect(parseTaskRouting(null)).toBeNull()
    expect(formatTaskRouting(res.routing)).toContain('gpt-6-sol')
  })
})

describe('resolveTaskPolicy', () => {
  it('explicit model wins over strand pin and profile; profile still sets thinking', () => {
    const res = resolveTaskPolicy(base({
      explicitModel: 'gpt-6-luna',
      strandPin: { providerId: 'anth', modelId: 'claude-opus-5-5' },
      profile: profile('coding', 'high'),
    }))
    expect(res).toMatchObject({ ok: true, modelId: 'gpt-6-luna', thinking: 'high' })
    if (res.ok) {
      expect(res.provider.id).toBe('oai')
      expect(res.provider.enabledModels?.[0]).toBe('gpt-6-luna')
      expect(res.routing.source).toBe('explicit')
    }
  })

  it('explicit model without profile keeps the background thinking (null)', () => {
    const res = resolveTaskPolicy(base({ explicitProvider: 'anth', explicitModel: 'claude-sonnet-5-5' }))
    expect(res).toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5', thinking: null })
    if (res.ok) expect(res.routing.thinkingSource).toBe('background')
  })

  it('explicit thinking overrides the matrix', () => {
    const res = resolveTaskPolicy(base({ strandPin: { providerId: 'anth', modelId: 'x' }, profile: profile('extraction', 'low'), explicitThinking: 'medium' }))
    expect(res).toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5', thinking: 'medium' })
  })

  it('rejects xhigh without a reason and accepts it with one', () => {
    expect(resolveTaskPolicy(base({ explicitThinking: 'xhigh' }))).toMatchObject({ ok: false })
    const ok = resolveTaskPolicy(base({ explicitThinking: 'xhigh', modelReason: 'proof needs maximal depth' }))
    expect(ok).toMatchObject({ ok: true, thinking: 'xhigh' })
    if (ok.ok) expect(ok.routing.modelReason).toBe('proof needs maximal depth')
  })

  it('rejects an exception model pin without reason, accepts it with reason', () => {
    const withExc = [...ALL, provider('exc', 'openai-codex', ['gpt-6-astra'])]
    const opts = {
      resolveProvider: (id: string) => withExc.find((p) => p.id === id) ?? null,
      resolveExplicit: () => ({ ok: true as const, providerId: 'exc', modelId: 'gpt-6-astra' }),
    }
    const denied = resolveTaskPolicy(base({ ...opts, explicitModel: 'gpt-6-astra' }))
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error).toContain('model_reason')
    expect(resolveTaskPolicy(base({ ...opts, explicitModel: 'gpt-6-astra', modelReason: 'user asked for it' })))
      .toMatchObject({ ok: true, modelId: 'gpt-6-astra' })
  })

  it('passes resolver errors for an unknown/disabled explicit model through', () => {
    const res = resolveTaskPolicy(base({ explicitProvider: 'oai', explicitModel: 'gpt-unknown' }))
    expect(res).toMatchObject({ ok: false })
  })

  it('explicit provider + profile picks the tier model inside that provider', () => {
    const res = resolveTaskPolicy(base({ explicitProvider: 'oai', profile: profile('extraction', 'low'), strandPin: { providerId: 'anth', modelId: 'claude-opus-5-5' } }))
    expect(res).toMatchObject({ ok: true, modelId: 'gpt-6-luna', thinking: 'off' })
    if (res.ok) expect(res.routing.source).toBe('explicit_provider')
  })

  it('explicit provider whose default is an exception model needs a reason unless a tier model is picked', () => {
    const fableFirst = provider('fab', 'anthropic-oauth', ['claude-fable-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
    const local = provider('loc2', 'ollama', ['astra-local'])
    const withFable = (o: Partial<ResolveTaskPolicyInput>) => base({
      resolveProvider: (id) => [fableFirst, local, ...ALL].find((p) => p.id === id || p.name === id) ?? null,
      resolveExplicit: ({ provider: p }) => {
        const hit = [fableFirst, local].find((x) => x.id === p)!
        return { ok: true, providerId: hit.id, providerName: hit.name, modelId: hit.enabledModels![0] }
      },
      ...o,
    })
    const bare = resolveTaskPolicy(withFable({ explicitProvider: 'fab' }))
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.error).toContain('model_reason')
    // No matrix for the provider → default model kept → same rule.
    expect(resolveTaskPolicy(withFable({ explicitProvider: 'loc2', profile: profile('general', 'low') })).ok).toBe(false)
    // A profile picks a regular tier model: no exception model runs.
    expect(resolveTaskPolicy(withFable({ explicitProvider: 'fab', profile: profile('review', 'low') })))
      .toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5' })
    // With a reason the provider default is allowed.
    expect(resolveTaskPolicy(withFable({ explicitProvider: 'fab', modelReason: 'synthetic: needs the top line' })))
      .toMatchObject({ ok: true, modelId: 'claude-fable-5' })
  })

  it('a default chain that lands on an exception model needs a reason (no silent top-line use)', () => {
    const fableDefault = () => provider('fd', 'anthropic-oauth', ['claude-fable-5', 'claude-sonnet-5-5'])
    const res = resolveTaskPolicy(base({ getDefaultProvider: fableDefault }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('model_reason')
    // With a profile the tier model of that provider runs instead.
    expect(resolveTaskPolicy(base({ getDefaultProvider: fableDefault, profile: profile('review', 'low') })))
      .toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5' })
    expect(resolveTaskPolicy(base({ getDefaultProvider: fableDefault, modelReason: 'synthetic reason' })))
      .toMatchObject({ ok: true, modelId: 'claude-fable-5' })
  })

  it('parent case: profile picks the tier inside the parent provider; strand pin is ignored', () => {
    const parent = { ...OAI, enabledModels: ['gpt-6-luna'] }
    const res = resolveTaskPolicy(base({
      parentProvider: parent,
      getDefaultProvider: () => parent, // the chain returns the parent first
      strandPin: { providerId: 'anth', modelId: 'claude-opus-5-5' },
      profile: profile('coding', 'high'),
    }))
    expect(res).toMatchObject({ ok: true, modelId: 'gpt-6-sol', thinking: 'high' })
    if (res.ok) {
      expect(res.provider.id).toBe('oai')
      expect(res.routing.source).toBe('parent')
    }
  })

  it('parent case without profile keeps the parent model and background thinking', () => {
    const parent = { ...OAI, enabledModels: ['gpt-6-luna'] }
    const res = resolveTaskPolicy(base({ parentProvider: parent, getDefaultProvider: () => parent }))
    expect(res).toMatchObject({ ok: true, modelId: 'gpt-6-luna', thinking: null })
  })

  it('strand pin is the tie-breaker: anthropic strand → sonnet/opus by profile', () => {
    const pin = { providerId: 'anth', modelId: 'claude-opus-5-5' }
    expect(resolveTaskPolicy(base({ strandPin: pin, profile: profile('research', 'medium') })))
      .toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5', thinking: 'medium' })
    expect(resolveTaskPolicy(base({ strandPin: pin, profile: profile('coding', 'high') })))
      .toMatchObject({ ok: true, modelId: 'claude-opus-5-5', thinking: 'high' })
  })

  it('strand pin openai: luna for light work, sol for strong', () => {
    const pin = { providerId: 'oai', modelId: 'gpt-6-sol' }
    expect(resolveTaskPolicy(base({ strandPin: pin, profile: profile('extraction', 'medium') })))
      .toMatchObject({ ok: true, modelId: 'gpt-6-luna', thinking: 'minimal' })
    expect(resolveTaskPolicy(base({ strandPin: pin, profile: profile('ops', 'high') })))
      .toMatchObject({ ok: true, modelId: 'gpt-6-sol', thinking: 'high' })
  })

  it('no profile in a pinned strand → thrifty but capable fallback (standard tier, low)', () => {
    const res = resolveTaskPolicy(base({ strandPin: { providerId: 'anth', modelId: 'claude-opus-5-5' } }))
    expect(res).toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5', thinking: 'low' })
    if (res.ok) {
      expect(res.routing.thinkingSource).toBe('fallback')
      expect(res.routing.source).toBe('strand')
    }
  })

  it('fails clearly when the tier model of an explicit profile is not enabled', () => {
    const opusOnly = provider('opus-only', 'anthropic', ['claude-opus-5-5'])
    const res = resolveTaskPolicy(base({
      resolveProvider: (id) => (id === 'opus-only' ? opusOnly : null),
      strandPin: { providerId: 'opus-only', modelId: 'claude-opus-5-5' },
      profile: profile('research', 'low'),
    }))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('claude-sonnet-5-5')
  })

  it('without a profile an unservable strand fallback keeps the legacy default chain, visibly', () => {
    const opusOnly = provider('opus-only', 'anthropic', ['claude-opus-5-5'])
    const res = resolveTaskPolicy(base({
      resolveProvider: (id) => (id === 'opus-only' ? opusOnly : null),
      strandPin: { providerId: 'opus-only', modelId: 'claude-opus-5-5' },
    }))
    expect(res).toMatchObject({ ok: true, modelId: 'claude-opus-5-5', thinking: null })
    if (res.ok) {
      expect(res.routing.source).toBe('default')
      expect(res.routing.reason).toContain('strand fallback unavailable')
    }
  })

  it('a data-policy block of the automatic choice fails without switching provider', () => {
    let gateCalls = 0
    const res = resolveTaskPolicy(base({
      strandPin: { providerId: 'oai', modelId: 'gpt-6-sol' },
      profile: profile('research', 'high'),
      checkAutomatic: () => { gateCalls++; return { allowed: false, reason: 'blocked:trains_on_input' } },
    }))
    expect(gateCalls).toBe(1)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('blocked:trains_on_input')
  })

  it('explicit pins are not run through the automatic gate', () => {
    let gateCalls = 0
    const res = resolveTaskPolicy(base({
      explicitModel: 'gpt-6-sol',
      checkAutomatic: () => { gateCalls++; return { allowed: false, reason: 'blocked' } },
    }))
    expect(res.ok).toBe(true)
    expect(gateCalls).toBe(0)
  })

  it('strand without matrix (local provider) falls back to the default chain', () => {
    const res = resolveTaskPolicy(base({ strandPin: { providerId: 'local', modelId: 'local-model' }, profile: profile('coding', 'medium') }))
    expect(res).toMatchObject({ ok: true, modelId: 'claude-opus-5-5', thinking: 'medium' })
    if (res.ok) {
      expect(res.routing.source).toBe('default')
      expect(res.routing.reason).toContain('no policy matrix')
    }
  })

  it('no strand pin, no parent: profile applies to the default provider; no profile = legacy', () => {
    expect(resolveTaskPolicy(base({ profile: profile('review', 'low') })))
      .toMatchObject({ ok: true, modelId: 'claude-sonnet-5-5', thinking: 'low' })
    const legacy = resolveTaskPolicy(base())
    expect(legacy).toMatchObject({ ok: true, modelId: 'claude-opus-5-5', thinking: null })
    if (legacy.ok) expect(legacy.routing.source).toBe('default')
  })

  it('fails clearly without any default provider', () => {
    expect(resolveTaskPolicy(base({ getDefaultProvider: () => null }))).toMatchObject({ ok: false })
  })

  it('is deterministic for equal inputs', () => {
    const input = base({ strandPin: { providerId: 'oai', modelId: 'gpt-6-sol' }, profile: profile('general', 'low') })
    expect(resolveTaskPolicy(input)).toEqual(resolveTaskPolicy(input))
  })

  it('never mutates the shared provider config when pinning a model', () => {
    const before = JSON.stringify(ANTH)
    resolveTaskPolicy(base({ strandPin: { providerId: 'anth', modelId: 'x' }, profile: profile('extraction', 'low') }))
    expect(JSON.stringify(ANTH)).toBe(before)
  })
})
