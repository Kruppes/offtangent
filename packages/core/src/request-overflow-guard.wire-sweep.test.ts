/**
 * Permanent wire-level sweep (final review B): for every admitted request with
 * a learned window, the payload the REAL pi-ai serializer emits (captured via
 * onPayload, never sent) differs from the unguarded one ONLY in
 * max_tokens/max_completion_tokens. Covers budget thinking, adaptive thinking,
 * chat-template kwargs, the SDK level remap (thinkingLevelMap minimal:null →
 * low = 2048 budget; high/xhigh:null), `off`, and Anthropic cache_control
 * markers (system/history/tools bytes, <= 4 markers). No network.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { streamSimple } from './pi-models.js'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { sdkRequestShape, decideRequest, learnContextLimit, resetObservedContextLimits } from './request-overflow-guard.js'

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const base = { input: ['text'], cost, baseUrl: 'http://127.0.0.1:9/v1' }
const models: Record<string, Model<Api>> = {
  anthBudget: { ...base, id: 'claude-b', name: 'x', api: 'anthropic-messages', provider: 'anthropic', reasoning: true, contextWindow: 200000, maxTokens: 64000 } as never,
  anthAdaptive: { ...base, id: 'claude-a', name: 'x', api: 'anthropic-messages', provider: 'anthropic', reasoning: true, contextWindow: 200000, maxTokens: 64000, compat: { forceAdaptiveThinking: true } } as never,
  anthMidConvo: { ...base, id: 'claude-m', name: 'x', api: 'anthropic-messages', provider: 'anthropic', reasoning: true, contextWindow: 200000, maxTokens: 64000, compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true } } as never,
  oaBudgetField: { ...base, id: 'oa1', name: 'x', api: 'openai-completions', provider: 'openai', reasoning: true, contextWindow: 65536, maxTokens: 65536, compat: { supportsThinkingTokenBudget: true } } as never,
  oaChatTemplate: { ...base, id: 'oa2', name: 'x', api: 'openai-completions', provider: 'openai', reasoning: true, contextWindow: 65536, maxTokens: 65536, compat: { thinkingFormat: 'chat-template', chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' }, thinking_budget: { $var: 'thinking.budget' } } } } as never,
  // level remap: minimal unsupported -> clampThinkingLevel remaps to low inside the SDK
  oaRemap: { ...base, id: 'oa3', name: 'x', api: 'openai-completions', provider: 'openai', reasoning: true, contextWindow: 65536, maxTokens: 65536, thinkingLevelMap: { minimal: null }, compat: { supportsThinkingTokenBudget: true } } as never,
  oaRemapHigh: { ...base, id: 'oa4', name: 'x', api: 'openai-completions', provider: 'openai', reasoning: true, contextWindow: 65536, maxTokens: 65536, thinkingLevelMap: { high: null, xhigh: null }, compat: { supportsThinkingTokenBudget: true } } as never,
}
async function wire(model: Model<Api>, ctx: Context, opts: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  let captured: Record<string, unknown> | undefined
  const ac = new AbortController()
  const s = streamSimple(model as never, ctx, { apiKey: 'synthetic', maxRetries: 0, signal: ac.signal, onPayload: (p: unknown) => { captured = JSON.parse(JSON.stringify(p)); ac.abort(); return p }, ...opts } as never)
  try { for await (const _ of s) { /* drain */ } } catch { /* abort */ }
  return captured
}
const strip = (b: Record<string, unknown> | undefined): string | undefined => { if (!b) return undefined; const rest: Record<string, unknown> = { ...b }; delete rest.max_tokens; delete rest.max_completion_tokens; return JSON.stringify(rest) }
const ctxOf = (n: number): Context => ({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'x'.repeat(n), timestamp: 1 }], tools: [] } as never)

beforeEach(() => resetObservedContextLimits())

describe('guard override changes only max_tokens on the real wire payload', () => {
  it('sweep', async () => {
    const violations: string[] = []
    let overrides = 0, total = 0, refusedN = 0, nocapture = 0
    for (const [name, m] of Object.entries(models)) {
      for (const reasoning of [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
        for (const maxTokens of [undefined, 512, 2000, 4096, 20000]) {
          for (const win of [3000, 6000, 9000, 12000, 20000, 30000, 40960]) {
            for (const chars of [1000, 9000, 30000]) {
              resetObservedContextLimits()
              learnContextLimit(m, win, 'syn')
              const opts = { reasoning, maxTokens }
              const c = ctxOf(chars)
              const d = decideRequest(m, c, opts as never)
              total++
              if (d.kind === 'refuse') { refusedN++; continue }
              if (!d.overridden) continue
              overrides++
              const orig = await wire(m, c, opts)
              const mod = await wire(d.model, c, opts)
              if (!orig || !mod) { nocapture++; continue }
              if (strip(orig) !== strip(mod)) violations.push(`${name} r=${reasoning} mt=${maxTokens} win=${win} chars=${chars}: ORIG ${strip(orig)} MAXTOK ${orig.max_tokens ?? orig.max_completion_tokens} | GUARD ${strip(mod)} MAXTOK ${mod.max_tokens ?? mod.max_completion_tokens}`)
            }
          }
        }
      }
    }
    console.log(JSON.stringify({ total, overrides, refusedN, nocapture, violations: violations.length, sample: violations.slice(0, 8) }, null, 1))
    expect(violations).toEqual([])
    expect(nocapture).toBe(0)
    expect(overrides).toBeGreaterThan(100)
  }, 300000)
})

describe('FULL payload incl messages/system/tools/cache_control identical except max_tokens', () => {
  it('sweep', async () => {
    let n = 0, over = 0; const bad: string[] = []
    const tools = [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }]
    for (const [name, m] of Object.entries(models)) for (const reasoning of [undefined, 'minimal', 'low', 'high', 'xhigh']) for (const win of [6000, 9000, 20000]) for (const chars of [1000, 9000]) {
      resetObservedContextLimits(); learnContextLimit(m, win, 'syn')
      const c = { systemPrompt: 'sys prompt', tools, messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 1 }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: m.api, provider: m.provider, model: m.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 2 }, { role: 'user', content: 'again', timestamp: 3 }] } as never
      const opts = { reasoning, cacheRetention: 'long', sessionId: 's1' }
      const d = decideRequest(m, c, opts as never); n++
      if (d.kind === 'refuse' || !d.overridden) continue
      over++
      const a = await wire(m, c, opts), b = await wire(d.model, c, opts)
      if (!a || !b) continue
      if (strip(a) !== strip(b)) bad.push(`${name} r=${reasoning} win=${win} chars=${chars}`)
      if (name.startsWith('anth')) {
        const markers = (s: string) => (s.match(/"cache_control"/g) ?? []).length
        if (markers(JSON.stringify(a)) === 0) bad.push('NO cache_control in anth payload ' + name)
        if (markers(JSON.stringify(b)) !== markers(JSON.stringify(a)) || markers(JSON.stringify(b)) > 4) bad.push('marker count ' + name)
        for (const k of ['system', 'messages', 'tools'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) bad.push(`anth ${k} bytes ${name}`)
      }
    }
    console.log('FULLSWEEP', JSON.stringify({ n, over, bad }))
    expect(bad).toEqual([])
    expect(over).toBeGreaterThan(20)
  }, 300000)
})

describe('sdkRequestShape mirrors the SDK level clamp', () => {
  it('minimal mapped to null is remapped to low (2048) before budget derivation; off has no budget', () => {
    const m = models.oaRemap
    const c = ctxOf(1000)
    expect(sdkRequestShape(m, c, { reasoning: 'minimal' } as never).thinkingBudget).toBe(2048)
    expect(sdkRequestShape(m, c, { reasoning: 'low' } as never).thinkingBudget).toBe(2048)
    expect(sdkRequestShape(m, c, { reasoning: 'off' } as never).thinkingBudget).toBeUndefined()
    expect(sdkRequestShape(models.oaBudgetField, c, { reasoning: 'minimal' } as never).thinkingBudget).toBe(1024)
  })
  it('a learned window that would shrink the remapped budget refuses instead of silently changing thinking', () => {
    resetObservedContextLimits()
    learnContextLimit(models.oaRemap, 3000, 'manual')
    const d = decideRequest(models.oaRemap, ctxOf(6000), { reasoning: 'minimal' } as never)
    if (d.kind === 'send' && d.overridden) {
      const before = sdkRequestShape(models.oaRemap, ctxOf(6000), { reasoning: 'minimal' } as never).thinkingBudget
      const after = sdkRequestShape(d.model, ctxOf(6000), { reasoning: 'minimal' } as never).thinkingBudget
      expect(after).toBe(before)
    } else {
      expect(d.kind).toBe('refuse')
    }
  })
})
