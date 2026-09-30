import { describe, it, expect } from 'vitest'
import { detectSecrets, passesLuhn, STRONG_RULE_IDS, CONTEXT_RULE_IDS } from './secret-detect.js'
import { CORPUS_POSITIVES, CORPUS_NEGATIVES, CORPUS_TOKENS } from './secret-corpus.fixture.js'

function values(text: string, tier: 'strong' | 'user'): string[] {
  return detectSecrets(text, { tier }).map(span => text.slice(span.start, span.end))
}

describe('detectSecrets — corpus gate V1', () => {
  it('has a corpus of at least 40 positives and 60 negatives', () => {
    expect(CORPUS_POSITIVES.length).toBeGreaterThanOrEqual(40)
    expect(CORPUS_NEGATIVES.length).toBeGreaterThanOrEqual(60)
  })

  it('finds every positive with the exact value and kind', () => {
    const missed: string[] = []
    for (const sample of CORPUS_POSITIVES) {
      const spans = detectSecrets(sample.text, { tier: sample.tier })
      const found = spans.map(s => ({ kind: s.kind, value: sample.text.slice(s.start, s.end) }))
      const expected = sample.expect
      const ok = found.length === expected.length
        && expected.every((e, i) => found[i]?.kind === e.kind && found[i]?.value === e.value)
      if (!ok) missed.push(`${sample.id}: expected ${JSON.stringify(expected)} got ${JSON.stringify(found)}`)
    }
    expect(missed).toEqual([])
  })

  it('finds every strong positive in the user tier too (user ⊇ strong)', () => {
    const missed: string[] = []
    for (const sample of CORPUS_POSITIVES.filter(s => s.tier === 'strong')) {
      const found = values(sample.text, 'user')
      for (const e of sample.expect) {
        if (!found.includes(e.value)) missed.push(`${sample.id}: ${e.kind}`)
      }
    }
    expect(missed).toEqual([])
  })

  it('does not apply context rules in the strong tier', () => {
    const leaked: string[] = []
    for (const sample of CORPUS_POSITIVES.filter(s => s.tier === 'user')) {
      const found = detectSecrets(sample.text, { tier: 'strong' })
      if (found.length > 0) leaked.push(`${sample.id}: ${JSON.stringify(found)}`)
    }
    expect(leaked).toEqual([])
  })

  it('reports nothing on the negative corpus (both tiers)', () => {
    const falsePositives: string[] = []
    for (const sample of CORPUS_NEGATIVES) {
      for (const tier of ['strong', 'user'] as const) {
        const found = values(sample.text, tier)
        if (found.length > 0) falsePositives.push(`${sample.id} [${tier}]: ${JSON.stringify(found)}`)
      }
    }
    expect(falsePositives).toEqual([])
  })
})

describe('detectSecrets — behaviour', () => {
  it('returns non-overlapping spans ordered by start', () => {
    const text = `a ${CORPUS_TOKENS.GHP} b ${CORPUS_TOKENS.AKIA} c ${CORPUS_TOKENS.JWT_HS}`
    const spans = detectSecrets(text, { tier: 'strong' })
    expect(spans.length).toBe(3)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end)
    }
  })

  it('is deterministic', () => {
    const text = `token ${CORPUS_TOKENS.GLPAT} and Passwort: Wolken-77`
    expect(detectSecrets(text, { tier: 'user' })).toEqual(detectSecrets(text, { tier: 'user' }))
  })

  it('does no I/O and handles empty input', () => {
    expect(detectSecrets('', { tier: 'user' })).toEqual([])
  })

  it('seals only the password part of a URL credential', () => {
    const text = 'postgres://appuser:Tr0ub4dor-3xy@db.example.com:5432/appdb'
    const spans = detectSecrets(text, { tier: 'strong' })
    expect(spans).toHaveLength(1)
    expect(text.slice(spans[0].start, spans[0].end)).toBe('Tr0ub4dor-3xy')
    expect(text.slice(0, spans[0].start)).toBe('postgres://appuser:')
  })

  it('validates Luhn', () => {
    expect(passesLuhn('4028008008688643')).toBe(true)
    expect(passesLuhn('4028008008688644')).toBe(false)
    expect(passesLuhn('not-a-number')).toBe(false)
  })

  it('exposes its rule ids', () => {
    expect(STRONG_RULE_IDS).toContain('github-token')
    expect(STRONG_RULE_IDS).toContain('payment-card')
    expect(CONTEXT_RULE_IDS).toEqual(['context-pin', 'context-password', 'context-token'])
  })
})

describe('detectSecrets — performance (risk R4)', () => {
  it('scans 100 KB of tool-like output in under 5 ms (median)', () => {
    const line = 'PASS  src/module-name.test.ts (12 tests) 118ms — commit 1bc70e2df738c3c0604a35953d12ad0925c9953a\n'
    let haystack = ''
    while (haystack.length < 100 * 1024) haystack += line
    haystack = haystack.slice(0, 100 * 1024)

    const timings: number[] = []
    for (let i = 0; i < 25; i++) {
      const start = performance.now()
      detectSecrets(haystack, { tier: 'strong' })
      timings.push(performance.now() - start)
    }
    timings.sort((a, b) => a - b)
    const median = timings[Math.floor(timings.length / 2)]
    console.log(`[perf] detectSecrets(strong) on 100 KB: median ${median.toFixed(2)} ms`)
    expect(median).toBeLessThan(5)
  })
})
