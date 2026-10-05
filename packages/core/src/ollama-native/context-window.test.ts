import { describe, expect, it } from 'vitest'
import {
  ECO_CONTEXT_PRESETS,
  decideNumCtx,
  parseContextWindowChoice,
  parseOllamaShow,
  resolveBaseline,
} from './context-window.js'

/* Synthetic /api/show shapes only. */
const show = (numCtx?: number, ctxLen?: number) => ({
  parameters: [numCtx ? `num_ctx                        ${numCtx}` : '', 'stop                           "<|im_end|>"'].filter(Boolean).join('\n'),
  model_info: ctxLen ? { 'general.architecture': 'qwen3', 'qwen3.context_length': ctxLen } : { 'general.architecture': 'qwen3' },
})

describe('parseContextWindowChoice', () => {
  it('accepts null (Unverändert) and the presets only', () => {
    expect(parseContextWindowChoice(null)).toEqual({ ok: true, value: null })
    for (const p of ECO_CONTEXT_PRESETS) expect(parseContextWindowChoice(p)).toEqual({ ok: true, value: p })
    expect(ECO_CONTEXT_PRESETS).toEqual([32768, 49152, 65536, 131072])
  })
  it('rejects non-integers, negatives, absurd and unlisted values', () => {
    for (const bad of [0, -32768, 1.5, '32768', 800_000_000, Number.MAX_SAFE_INTEGER + 2, 40000, true, {}, undefined]) {
      expect(parseContextWindowChoice(bad).ok).toBe(false)
    }
  })
})

describe('parseOllamaShow / resolveBaseline', () => {
  it('reads modelfile num_ctx and architecture context_length separately', () => {
    expect(parseOllamaShow(show(16384, 262144))).toEqual({ modelfileNumCtx: 16384, supportedMax: 262144 })
  })
  it('ignores garbage values instead of guessing', () => {
    expect(parseOllamaShow({ parameters: 'num_ctx abc', model_info: { 'x.context_length': -5 } })).toEqual({})
    expect(parseOllamaShow(null)).toEqual({})
  })
  it('explicit provider setting wins over modelfile; nothing known → unknown (no guessed floor)', () => {
    expect(resolveBaseline({ providerNumCtx: 40960, modelfileNumCtx: 8192 })).toEqual({ known: true, value: 40960, source: 'provider_setting' })
    expect(resolveBaseline({ modelfileNumCtx: 8192 })).toEqual({ known: true, value: 8192, source: 'modelfile' })
    expect(resolveBaseline({ supportedMax: 262144 })).toEqual({ known: false })
  })
})

describe('decideNumCtx', () => {
  const facts = { modelfileNumCtx: 40960, supportedMax: 262144 }
  it('no choice → no override, even on native', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: null, facts })).toEqual({ numCtx: undefined, state: 'unchanged', guardWindow: 40960 })
  })
  it('non-native provider → unavailable, never an override', () => {
    expect(decideNumCtx({ nativeProvider: false, choice: 65536, facts })).toMatchObject({ numCtx: undefined, state: 'provider_unsupported' })
  })
  it('greater choice → exact num_ctx and guard window equal to it', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: 65536, facts })).toEqual({ numCtx: 65536, state: 'applied', guardWindow: 65536 })
  })
  it('smaller choice never decreases the baseline (no override sent)', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: 32768, facts })).toEqual({ numCtx: undefined, state: 'baseline_kept', guardWindow: 40960 })
  })
  it('choice above the supported maximum → rejected, no override', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: 131072, facts: { modelfileNumCtx: 8192, supportedMax: 65536 } }))
      .toEqual({ numCtx: undefined, state: 'exceeds_supported', guardWindow: 8192 })
  })
  it('unknown baseline or unknown supported max → no override', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: 65536, facts: { supportedMax: 262144 } })).toEqual({ numCtx: undefined, state: 'baseline_unknown', guardWindow: undefined })
    expect(decideNumCtx({ nativeProvider: true, choice: 65536, facts: { modelfileNumCtx: 8192 } })).toEqual({ numCtx: undefined, state: 'supported_unknown', guardWindow: 8192 })
  })
  it('an invalid persisted choice (e.g. 800000000) is never sent', () => {
    expect(decideNumCtx({ nativeProvider: true, choice: 800_000_000, facts })).toMatchObject({ numCtx: undefined, state: 'invalid_choice' })
  })
  it('is pure: the same facts object is not mutated across strands', () => {
    const shared = { modelfileNumCtx: 40960, supportedMax: 262144 }
    const a = decideNumCtx({ nativeProvider: true, choice: 131072, facts: shared })
    const b = decideNumCtx({ nativeProvider: true, choice: null, facts: shared })
    expect(a.numCtx).toBe(131072)
    expect(b.numCtx).toBeUndefined()
    expect(shared).toEqual({ modelfileNumCtx: 40960, supportedMax: 262144 })
  })
})
