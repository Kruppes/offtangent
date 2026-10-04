/**
 * B1 (review ac775c50): the Eco request carries exactly the output limit its
 * budget reserved, against the same effective window. Unit level: the
 * per-agent handoff, the stream-limit application (fail closed, normal path
 * untouched), the SDK steps that may only LOWER the value, and the vLLM
 * overflow wording. Synthetic data only.
 */
import { describe, expect, it } from 'vitest'
import type { Api, Context, Model } from '@earendil-works/pi-ai'
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { applyEcoStreamLimits, ECO_METRICS_KEEP_PER_SESSION, EcoRequestGate, ecoTelemetry, lastEcoViewForStrand } from './eco-mode-store.js'
import { initDatabase } from './database.js'
import { EcoBudgetError, parseContextOverflow, resolveEcoBudget } from './eco-policy.js'
import { buildStreamFn } from './provider-config.js'

const on = () => 'on' as const
const off = () => 'off' as const
const unknown = () => 'unknown' as const

function model(contextWindow: number, maxTokens: number): Model<Api> {
  return {
    id: 'syn', name: 'syn', api: 'openai-completions', provider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1',
    reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow, maxTokens,
  } as Model<Api>
}

function ctxOfChars(chars: number): Context {
  return { messages: [{ role: 'user', content: 'x'.repeat(chars), timestamp: 0 }] } as Context
}
type Transcript = Parameters<typeof clampMaxTokensToContext>[1]
const transcriptOf = (chars: number) => ctxOfChars(chars) as unknown as Transcript

describe('EcoRequestGate', () => {
  it('hands one staged decision to exactly one take', () => {
    const gate = new EcoRequestGate()
    gate.stage({ mode: 'off' })
    expect(gate.take()).toEqual({ mode: 'off' })
    expect(gate.take()).toBeUndefined()
  })
  it('clear drops a stale decision', () => {
    const gate = new EcoRequestGate()
    gate.stage({ mode: 'eco', limits: { sessionId: 's', contextWindow: 1000, outputReserve: 100 } })
    gate.clear()
    expect(gate.take()).toBeUndefined()
  })
})

describe('applyEcoStreamLimits', () => {
  const m = model(65536, 65536)
  const limits = { sessionId: 's1', contextWindow: 65536, outputReserve: 26214 }

  it('off decision: the same objects come back (normal path byte-identical, no shadow cap)', () => {
    const opts = { maxTokens: undefined, sessionId: 's1' }
    const r = applyEcoStreamLimits({ mode: 'off' }, 's1', on, m, opts)
    expect(r.model).toBe(m)
    expect(r.options).toBe(opts)
  })

  it('no decision but switch definitely off: same objects', () => {
    const opts = {}
    const r = applyEcoStreamLimits(undefined, 's1', off, m, opts)
    expect(r.model).toBe(m)
    expect(r.options).toBe(opts)
  })

  it('no decision while the switch is on or unreadable: fails closed', () => {
    expect(() => applyEcoStreamLimits(undefined, 's1', on, m, {})).toThrow(EcoBudgetError)
    expect(() => applyEcoStreamLimits(undefined, 's1', unknown, m, {})).toThrow(EcoBudgetError)
  })

  it('decision for another session or unreadable limits: fails closed', () => {
    expect(() => applyEcoStreamLimits({ mode: 'eco', limits }, 's2', on, m, {})).toThrow(EcoBudgetError)
    for (const bad of [
      { ...limits, contextWindow: 0 }, { ...limits, outputReserve: Number.NaN }, { ...limits, outputReserve: -1 },
      { ...limits, outputReserve: 1.5 }, { ...limits, outputReserve: 70000 },
    ]) {
      expect(() => applyEcoStreamLimits({ mode: 'eco', limits: bad }, 's1', on, m, {})).toThrow(EcoBudgetError)
    }
  })

  it('eco: options.maxTokens = reserve, model limits = effective window and reserve, input objects untouched', () => {
    const opts: { maxTokens?: number; sessionId: string } = { sessionId: 's1' }
    const r = applyEcoStreamLimits({ mode: 'eco', limits }, 's1', on, m, opts)
    expect(r.options.maxTokens).toBe(26214)
    expect(r.options.sessionId).toBe('s1')
    expect(r.model.maxTokens).toBe(26214)
    expect(r.model.contextWindow).toBe(65536)
    expect(m.maxTokens).toBe(65536)
    expect(opts.maxTokens).toBeUndefined()
  })

  it('eco with an observed limit: the SDK clamps against the observed window, not the declared one', () => {
    const declared = model(131072, 131072)
    const budget = resolveEcoBudget({ contextWindow: 131072, maxTokens: 131072, observedContextLimit: 40960 })
    const opts: { maxTokens?: number } | undefined = undefined as { maxTokens?: number } | undefined
    const r = applyEcoStreamLimits({ mode: 'eco', limits: { sessionId: 's1', contextWindow: budget.contextWindow, outputReserve: budget.outputReserve } }, 's1', on, declared, opts)
    expect(r.model.contextWindow).toBe(40960)
    expect(r.options?.maxTokens).toBe(budget.outputReserve)
  })

  it('an explicit smaller caller cap is kept (never raised)', () => {
    const r = applyEcoStreamLimits({ mode: 'eco', limits }, 's1', on, m, { maxTokens: 4000 })
    expect(r.options.maxTokens).toBe(4000)
  })
})

describe('pi-ai steps after the Eco cap can only lower it', () => {
  for (const W of [65536, 262144]) {
    for (const chars of [0, 10_000, 3 * resolveEcoBudget({ contextWindow: W, maxTokens: W }).inputBudget]) {
      it(`W = M = ${W}, ${chars} chars: base/clamp/thinking never exceed the reserve`, () => {
        const budget = resolveEcoBudget({ contextWindow: W, maxTokens: W })
        const opts: { maxTokens?: number } = {}
        const r = applyEcoStreamLimits({ mode: 'eco', limits: { sessionId: 's', contextWindow: budget.contextWindow, outputReserve: budget.outputReserve } }, 's', on, model(W, W), opts)
        const context = transcriptOf(chars)
        expect(clampMaxTokensToContext(r.model, context, r.options.maxTokens!)).toBeLessThanOrEqual(budget.outputReserve)
        const base = buildBaseOptions(r.model, context, r.options)
        expect(base.maxTokens!).toBeLessThanOrEqual(budget.outputReserve)
        for (const level of ['minimal', 'low', 'medium', 'high'] as const) {
          const adjusted = adjustMaxTokensForThinking(base.maxTokens, r.model.maxTokens, level)
          expect(adjusted.maxTokens).toBeLessThanOrEqual(budget.outputReserve)
          expect(adjusted.thinkingBudget).toBeLessThanOrEqual(adjusted.maxTokens)
        }
      })
    }
  }
})

describe('buildStreamFn with an Eco gate', () => {
  const provider = { textVerbosity: undefined, transport: undefined } as never

  function capture() {
    const calls: { model: Model<Api>; options: unknown }[] = []
    const impl = ((model: Model<Api>, _ctx: Context, options: unknown) => { calls.push({ model, options }); return {} as never }) as never
    return { calls, impl }
  }

  it('without a gate the call is exactly the legacy one', () => {
    const { calls, impl } = capture()
    const m = model(65536, 65536)
    buildStreamFn(provider, impl, { getSessionId: () => 's1' })(m, ctxOfChars(10), {})
    expect(calls[0]!.model).toBe(m)
    expect((calls[0]!.options as { maxTokens?: number }).maxTokens).toBeUndefined()
  })

  it('off decision: model object untouched, options carry no maxTokens', () => {
    const { calls, impl } = capture()
    const gate = new EcoRequestGate()
    const m = model(65536, 65536)
    gate.stage({ mode: 'off' })
    buildStreamFn(provider, impl, { getSessionId: () => 's1', ecoGate: gate, readEcoMode: on })(m, ctxOfChars(10), {})
    expect(calls[0]!.model).toBe(m)
    expect((calls[0]!.options as { maxTokens?: number }).maxTokens).toBeUndefined()
  })

  it('eco decision is applied once; a second call without a new staging fails closed while eco is on', () => {
    const { calls, impl } = capture()
    const gate = new EcoRequestGate()
    const fn = buildStreamFn(provider, impl, { getSessionId: () => 's1', ecoGate: gate, readEcoMode: on })
    gate.stage({ mode: 'eco', limits: { sessionId: 's1', contextWindow: 40960, outputReserve: 8192 } })
    fn(model(131072, 131072), ctxOfChars(10), {})
    expect(calls[0]!.model.contextWindow).toBe(40960)
    expect((calls[0]!.options as { maxTokens?: number }).maxTokens).toBe(8192)
    expect(() => fn(model(131072, 131072), ctxOfChars(10), {})).toThrow(EcoBudgetError)
    expect(calls).toHaveLength(1)
  })

  it('a decision staged for another session (session switched) fails closed', () => {
    const { calls, impl } = capture()
    const gate = new EcoRequestGate()
    let sid = 's1'
    const fn = buildStreamFn(provider, impl, { getSessionId: () => sid, ecoGate: gate, readEcoMode: on })
    gate.stage({ mode: 'eco', limits: { sessionId: 's1', contextWindow: 40960, outputReserve: 8192 } })
    sid = 's2'
    expect(() => fn(model(131072, 131072), ctxOfChars(10), {})).toThrow(EcoBudgetError)
    expect(calls).toHaveLength(0)
  })
})

describe('overflow parser: vLLM wording yields the stated maximum, never a requested total', () => {
  it.each([
    ["This model's maximum context length is 65536 tokens and your request has 24632 input tokens (43148 > 65536 - 24632).", 65536, 24632],
    ["This model's maximum context length is 40960 tokens. However, you requested 45000 tokens (41000 in the messages, 4000 in the completion). Please reduce the length of the messages or completion.", 40960, 45000],
    ["'max_tokens' or 'max_completion_tokens' is too large: 121210. This model's maximum context length is 40960 tokens and your request has 9000 input tokens (121210 > 40960 - 9000).", 40960, 9000],
  ])('%s', (message, limit, requested) => {
    expect(parseContextOverflow(message)).toEqual({ limit, requested })
  })

  it('the "a > b - c" arithmetic alone is not taken as a limit', () => {
    expect(parseContextOverflow('context length exceeded: 43148 > 65536 - 24632')).toEqual({ requested: null, limit: null })
  })
})

describe('eco_metrics bounded per-session retention', () => {
  it('keeps the newest ECO_METRICS_KEEP_PER_SESSION rows per session and leaves other sessions alone', () => {
    const db = initDatabase(':memory:')
    const row = (sessionId: string, tokensAfter: number) => ({
      sessionId, contextWindow: 40960, outputReserve: 8192, inputBudget: 28000, observedLimit: null,
      tokensBefore: 30000, tokensAfter, compacted: 0, dropped: 0, unrecallable: 0, refusalReason: null,
    })
    ecoTelemetry.record(db, row('other', 1))
    for (let i = 1; i <= ECO_METRICS_KEEP_PER_SESSION + 25; i++) ecoTelemetry.record(db, row('s', i))
    const count = (sid: string) => (db.prepare('SELECT COUNT(*) AS c FROM eco_metrics WHERE session_id = ?').get(sid) as { c: number }).c
    expect(count('s')).toBe(ECO_METRICS_KEEP_PER_SESSION)
    expect(count('other')).toBe(1)
    const min = (db.prepare("SELECT MIN(tokens_after) AS m FROM eco_metrics WHERE session_id = 's'").get() as { m: number }).m
    expect(min).toBe(26)
    expect(lastEcoViewForStrand(db, 's')?.estimatedTokensAfter).toBe(ECO_METRICS_KEEP_PER_SESSION + 25)
  })
})
