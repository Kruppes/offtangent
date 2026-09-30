import { describe, expect, it } from 'vitest'
import { resolveAgentReadScope } from './agent-read-scope.js'

const personas = () => ['coder', 'advisor', 'analyst']

describe('resolveAgentReadScope', () => {
  it('default: non-main persona is locked to its own bucket', () => {
    const r = resolveAgentReadScope({ requested: undefined, callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: 'coder', explicit: false })
  })

  it('default: main is unscoped', () => {
    const r = resolveAgentReadScope({ requested: undefined, callerAgentId: 'main', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: undefined, explicit: false })
  })

  it('default: legacy caller without agentId is unscoped', () => {
    const r = resolveAgentReadScope({ requested: undefined, callerAgentId: undefined, listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: undefined, explicit: false })
  })

  it('blank/whitespace request is treated as omitted', () => {
    const r = resolveAgentReadScope({ requested: '   ', callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: 'coder', explicit: false })
  })

  it('"all" is unscoped and explicit', () => {
    const r = resolveAgentReadScope({ requested: 'all', callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: undefined, explicit: true })
  })

  it('a concrete persona id scopes to that bucket (explicit)', () => {
    const r = resolveAgentReadScope({ requested: 'analyst', callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: 'analyst', explicit: true })
  })

  it('"main" is always valid even though it has no persona dir', () => {
    const r = resolveAgentReadScope({ requested: 'main', callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: 'main', explicit: true })
  })

  it('"shared" is a valid explicit target', () => {
    const r = resolveAgentReadScope({ requested: 'shared', callerAgentId: 'coder', listAgentIds: personas })
    expect(r).toEqual({ ok: true, agentId: 'shared', explicit: true })
  })

  it('unknown id yields an error listing the valid options', () => {
    const r = resolveAgentReadScope({ requested: 'researcher', callerAgentId: 'coder', listAgentIds: personas })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('unknown agent "researcher"')
      expect(r.error).toContain('all')
      expect(r.error).toContain('main')
      expect(r.error).toContain('coder')
    }
  })
})
