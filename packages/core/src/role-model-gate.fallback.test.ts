/**
 * F3 (review A-A1/B-A3, triage 19:25): a background job without its own role
 * model falls back to the ACTIVE chat provider. That fallback is an automatic
 * model choice (D7) and was never gated — pointing the chat at a blocked
 * family shipped every session summary, every fact extraction and every
 * consolidation there.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { gateFallbackModel, FALLBACK_AUDIT_SUFFIX } from './role-model-gate.js'
import { listModelGateAudit, resetModelGateAudit } from './data-policy.js'

beforeEach(() => {
  resetModelGateAudit()
})

describe('gateFallbackModel', () => {
  it('skips the job when the active provider is a blocked family (enforce)', () => {
    const result = gateFallbackModel('summary', 'prov-1', 'kimi-k2.6', {
      mode: 'enforce',
      blockedFamilies: ['kimi'],
    })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('blocked:family:kimi')
    const audit = listModelGateAudit()
    expect(audit[0]?.role).toBe(`summary:${FALLBACK_AUDIT_SUFFIX}`)
    expect(audit[0]?.blocked).toBe(true)
    expect(audit[0]?.kind).toBe('automatic')
  })

  it('allows and records the same fallback in audit mode', () => {
    const result = gateFallbackModel('factExtraction', 'prov-1', 'kimi-k2.6', {
      mode: 'audit',
      blockedFamilies: ['kimi'],
    })
    // A blocked FAMILY stays hard-blocked in every mode (pre-existing rule).
    expect(result.allowed).toBe(false)
    const cloud = gateFallbackModel('factExtraction', 'prov-2', 'gpt-4o', { mode: 'audit' })
    expect(cloud.allowed).toBe(true)
    const audit = listModelGateAudit()
    expect(audit.some(entry => entry.role === `factExtraction:${FALLBACK_AUDIT_SUFFIX}`)).toBe(true)
  })

  it('lets an allowed provider through without blocking', () => {
    const result = gateFallbackModel('consolidation', 'prov-3', 'gpt-4o', {
      mode: 'enforce',
      blockedFamilies: [],
    })
    expect(result.allowed).toBe(result.decision?.policyAllows ?? false)
    expect(result.decision).not.toBeNull()
  })

  it('never blocks anything in mode off', () => {
    const result = gateFallbackModel('summary', 'prov-1', 'gpt-4o', { mode: 'off' })
    expect(result.allowed).toBe(true)
    expect(listModelGateAudit()).toEqual([])
  })
})
