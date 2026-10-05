/**
 * M4 runner evidence: the concrete numbers the guard computes for a fixed,
 * synthetic matrix (no network). The values come from pi-ai's own exported
 * option functions (clampMaxTokensToContext / adjustMaxTokensForThinking /
 * thinking budget clamps) — the same functions the SDK uses to build the wire
 * request — so the "reserve" is the SDK's real upper bound, not model.maxTokens.
 * The table is printed (EVIDENCE lines) and the invariants are asserted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { decideRequest, estimateRequest, learnContextLimit, resetObservedContextLimits, sdkRequestShape } from './request-overflow-guard.js'

const base = { name: 'synthetic', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
const oa = (over: Partial<Model<Api>> = {}) => ({ ...base, id: 'ev-local', api: 'openai-completions', provider: 'openai', baseUrl: 'http://ev.invalid/v1', reasoning: false, contextWindow: 65536, maxTokens: 65536, ...over }) as Model<Api>
const an = (over: Partial<Model<Api>> = {}) => ({ ...base, id: 'ev-claude', api: 'anthropic-messages', provider: 'anthropic', baseUrl: 'http://ev-a.invalid', reasoning: true, contextWindow: 200000, maxTokens: 64000, ...over }) as Model<Api>
const ctx = (chars: number): Context => ({ systemPrompt: 'S'.repeat(3000), messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }], tools: [{ name: 't', description: 'd'.repeat(600), parameters: { type: 'object', properties: {} } as never }] }) as Context

beforeEach(() => resetObservedContextLimits())
afterEach(() => resetObservedContextLimits())

interface Row { case: string; window: number | null; src: string; estOpt: number; estCons: number; sdkMaxBefore: number; thinkBefore?: number; sdkMaxSent: number | null; thinkSent?: number; decision: string; overridden?: boolean }
function row(name: string, model: Model<Api>, context: Context, options: Record<string, unknown> = {}): Row {
  const d = decideRequest(model, context, options as never)
  const before = sdkRequestShape(model, context, options as never)
  const sent = d.kind === 'send' ? sdkRequestShape(d.model, context, options as never) : null
  const e = estimateRequest(context)
  const r: Row = { case: name, window: d.window, src: d.kind === 'refuse' ? d.windowSource : (d.window !== null && d.window !== model.contextWindow ? 'observed' : 'declared'), estOpt: e.optimistic, estCons: e.conservative,
    sdkMaxBefore: before.maxTokens, thinkBefore: before.thinkingBudget, sdkMaxSent: sent?.maxTokens ?? null, thinkSent: sent?.thinkingBudget,
    decision: d.kind === 'send' ? 'send' : `refuse:${d.reason}`, overridden: d.kind === 'send' ? d.overridden : undefined }
  console.log('EVIDENCE ' + JSON.stringify(r))
  return r
}

describe('M4 evidence matrix (computed upper bounds actually used)', () => {
  it('M=W=65536, nothing learned: sent unchanged; SDK itself lowers max_tokens to W - input (no blanket refusal)', () => {
    const r = row('oa M=W=65536 no-obs 30k chars', oa(), ctx(30000))
    expect(r.decision).toBe('send'); expect(r.overridden).toBe(false)
    expect(r.sdkMaxBefore).toBeLessThan(65536)          // pi-ai clamp, not model.maxTokens
    expect(r.sdkMaxSent).toBe(r.sdkMaxBefore)
  })
  it('M=W=65536, observed 40960: one budget — SDK clamp runs against 40960; sent and not refused', () => {
    learnContextLimit(oa(), 40960, 'synthetic')
    const r = row('oa M=W=65536 obs=40960 30k chars', oa(), ctx(30000))
    expect(r.decision).toBe('send'); expect(r.overridden).toBe(true)
    expect(r.sdkMaxSent! + r.estOpt).toBeLessThanOrEqual(40960)
  })
  it('explicit options.maxTokens dominates the catalog value', () => {
    learnContextLimit(oa(), 40960, 'synthetic')
    const r = row('oa obs=40960 explicit maxTokens=4096', oa(), ctx(30000), { maxTokens: 4096 })
    expect(r.decision).toBe('send'); expect(r.sdkMaxSent).toBe(4096); expect(r.overridden).toBe(false)
  })
  it('pure input over learned window: typed refusal (both estimates over)', () => {
    learnContextLimit(oa(), 8192, 'synthetic')
    const r = row('oa obs=8192 60k chars', oa(), ctx(60000))
    expect(r.decision).toBe('refuse:input_exceeds_window')
    expect(r.estOpt).toBeGreaterThan(8192); expect(r.estCons).toBeGreaterThan(8192)
  })
  // Documented limitation: in the gray zone the SDK's own clamp can leave
  // almost no answer room (here max_tokens=1). The guard does not invent a
  // second minimum-answer budget; the provider decides / the reply stops on length.
  it('gray zone (chars/3 over, chars/4 under) is sent', () => {
    learnContextLimit(oa(), 9500, 'synthetic')
    const r = row('oa obs=9500 33k chars (gray)', oa(), ctx(33000))
    expect(r.estCons).toBeGreaterThan(9500); expect(r.estOpt).toBeLessThanOrEqual(9500)
    expect(r.decision).toBe('send')
  })
  it('Anthropic thinking high, nothing learned: thinking/max values exactly as SDK computes; untouched', () => {
    const r = row('anthropic 200k/64k reasoning=high no-obs', an(), ctx(30000), { reasoning: 'high' })
    expect(r.decision).toBe('send'); expect(r.overridden).toBe(false); expect(r.thinkSent).toBe(r.thinkBefore)
  })
  it('Anthropic thinking high, observed 40960: would need a thinking change -> sent unchanged if it fits, else typed refusal; never a changed thinking budget', () => {
    learnContextLimit(an(), 40960, 'synthetic')
    const r = row('anthropic reasoning=high obs=40960 30k chars', an(), ctx(30000), { reasoning: 'high' })
    if (r.decision === 'send') expect(r.thinkSent).toBe(r.thinkBefore)
    else expect(r.decision).toBe('refuse:reserve_needs_reasoning_change')
  })
  it('openai-compat reasoning model, observed 40960', () => {
    learnContextLimit(oa({ id: 'ev-r', reasoning: true }), 40960, 'synthetic')
    const r = row('oa reasoning=medium obs=40960 30k chars', oa({ id: 'ev-r', reasoning: true }), ctx(30000), { reasoning: 'medium' })
    if (r.decision === 'send') expect(r.thinkSent).toBe(r.thinkBefore)
  })
  it('unknown/malformed window (contextWindow 0): no window, sent unchanged (provider decides)', () => {
    const r = row('oa contextWindow=0 no-obs', oa({ id: 'ev-u', contextWindow: 0 }), ctx(30000))
    expect(r.decision).toBe('send'); expect(r.window).toBeNull()
  })
})
