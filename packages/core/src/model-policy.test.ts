import { describe, expect, it } from 'vitest'
import {
  isBlockedProviderType,
  isChainRole,
  loadModelPolicyRoles,
  MODEL_POLICY_LEGACY_FIELDS,
  MODEL_POLICY_ROLES,
  resolveRoleProvider,
  resolveRoleSpec,
} from './model-policy.js'

const settings = (overrides: Record<string, unknown>) => overrides as Parameters<typeof resolveRoleProvider>[1]

describe('loadModelPolicyRoles', () => {
  it('keeps trimmed string roles and drops empty or non-string ones', () => {
    const roles = loadModelPolicyRoles(settings({
      modelPolicy: { roles: { router: '  a, b  ', summary: '', broken: 42, ok: 'p:m' } },
    }))
    expect(roles).toEqual({ router: 'a, b', ok: 'p:m' })
  })

  it('returns an empty map when the block is missing', () => {
    expect(loadModelPolicyRoles(settings({}))).toEqual({})
  })
})

describe('resolveRoleProvider (legacy read-through)', () => {
  const legacyCases: Array<[string, Record<string, unknown>, string]> = [
    ['summary', { sessionSummaryProviderId: 'p1:m1' }, 'p1:m1'],
    ['factExtraction', { factExtraction: { providerId: 'p2:m2' } }, 'p2:m2'],
    ['consolidation', { memoryConsolidation: { providerId: 'p3:m3' } }, 'p3:m3'],
    ['sttRewrite', { stt: { rewrite: { providerId: 'p4:m4' } } }, 'p4:m4'],
    ['loopDetection', { tasks: { loopDetection: { smartProvider: 'p5:m5' } } }, 'p5:m5'],
  ]

  it.each(legacyCases)('role %s falls back to its legacy field', (role, legacy, expected) => {
    const hit = resolveRoleProvider(role, settings(legacy))
    expect(hit).toEqual({
      role,
      spec: expected,
      source: 'legacy',
      legacyField: MODEL_POLICY_LEGACY_FIELDS[role],
    })
  })

  it.each(legacyCases)('role %s beats its legacy field when set', (role, legacy) => {
    const hit = resolveRoleProvider(role, settings({
      ...legacy,
      modelPolicy: { roles: { [role]: 'role-provider:role-model' } },
    }))
    expect(hit).toEqual({ role, spec: 'role-provider:role-model', source: 'role' })
  })

  it.each(legacyCases.map(([role]) => role))('role %s resolves to null when both are empty', role => {
    expect(resolveRoleProvider(role, settings({}))).toBeNull()
    expect(resolveRoleProvider(role, settings({
      modelPolicy: { roles: { [role]: '   ' } },
      sessionSummaryProviderId: '',
      factExtraction: { providerId: '' },
      memoryConsolidation: { providerId: '' },
      stt: { rewrite: { providerId: '' } },
      tasks: { loopDetection: { smartProvider: '' } },
    }))).toBeNull()
  })

  it('has no legacy field for roles that never had one', () => {
    expect(resolveRoleProvider('speechSummary', settings({ speechSummary: 'x' }))).toBeNull()
    expect(resolveRoleProvider('speechSummary', settings({
      modelPolicy: { roles: { speechSummary: 'p:m' } },
    }))).toEqual({ role: 'speechSummary', spec: 'p:m', source: 'role' })
  })
})

describe('role catalog', () => {
  it('knows the chain roles and the single-entry roles', () => {
    expect(isChainRole('router')).toBe(true)
    expect(isChainRole('projectAssignment')).toBe(true)
    expect(isChainRole('task:cronjob')).toBe(false)
    expect(MODEL_POLICY_ROLES).toContain('task:consolidation')
    expect(MODEL_POLICY_ROLES).toContain('speechSummary')
    expect(MODEL_POLICY_ROLES).not.toContain('default')
  })

  it('blocks the provider types that must never be chosen automatically', () => {
    for (const type of ['zai', 'zai-coding', 'kimi', 'kimi-coding', 'moonshot']) {
      expect(isBlockedProviderType(type)).toBe(true)
    }
    expect(isBlockedProviderType('anthropic-oauth')).toBe(false)
    expect(isBlockedProviderType('ollama')).toBe(false)
  })
})

describe('resolveRoleSpec', () => {
  it('prefers the role, then the caller value, and never re-reads disk when a value is given', () => {
    // No settings on disk in this unit context: the caller value decides.
    expect(resolveRoleSpec('summary', 'caller:model')).toBe('caller:model')
    expect(resolveRoleSpec('summary', '')).toBe('')
    expect(resolveRoleSpec('summary', '  spaced:model  ')).toBe('spaced:model')
  })
})
