/**
 * `news_digest.v1` payload contract (plan 2026-09-28).
 *
 * The backend is the last gate before a digest lands on two clients, so every
 * rejection rule of the contract has a test here — and so has every rule the
 * backend must NOT have: an unknown category, source type or action kind is a
 * client display question, not a publishing error.
 *
 * All fixtures are synthetic (Alice/Bob, example.com).
 */
import { describe, it, expect } from 'vitest'
import {
  NEWS_DIGEST_KIND,
  NEWS_DIGEST_MAX_ITEMS,
  NEWS_DIGEST_MAX_SOURCES,
  NEWS_DIGEST_MAX_QUICK_HITS,
  validateNewsDigestPayload,
} from './board-news-digest.js'

function source(overrides: Record<string, unknown> = {}) {
  return { name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary', ...overrides }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'example-model-3',
    rank: 1,
    title: 'Example Lab releases model 3',
    category: 'frontier',
    verdict: 'hot',
    score: 82,
    summary: 'Example Lab published a new model with a longer context window.',
    critique: 'The benchmark table only compares against its own predecessor.',
    relevance: 'Worth a test on the agent loop; nothing to migrate yet.',
    action: { kind: 'try', text: 'Run the coding loop against it for a day.' },
    source_count: 2,
    sources: [source(), source({ name: 'Example Wire', url: 'https://news.example.com/a', type: 'press' })],
    tags: ['models', 'context'],
    is_update: false,
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: NEWS_DIGEST_KIND,
    date: '2026-09-28',
    generated_at: '2026-09-28T07:04:00+02:00',
    window_hours: 30,
    headline: 'Two model releases and a cheaper speech stack.',
    items: [item()],
    quick_hits: [{ title: 'Example toolkit 2.0', url: 'https://example.org/toolkit', source: 'Example Org', note: 'Minor release.' }],
    stats: { sources_checked: 31, sources_failed: ['Example Feed'], candidates: 191, clusters: 64 },
    ...overrides,
  }
}

describe('validateNewsDigestPayload — accepted', () => {
  it('accepts a full payload', () => {
    expect(validateNewsDigestPayload(payload())).toBeNull()
  })

  it('accepts the minimum: headline plus one item with one source', () => {
    expect(validateNewsDigestPayload({
      headline: 'One thing happened.',
      items: [{ id: 'a', title: 'A', summary: 'B', verdict: 'watch', sources: [{ name: 'S', url: 'https://example.com' }] }],
    })).toBeNull()
  })

  it('accepts every documented verdict', () => {
    for (const verdict of ['hot', 'relevant', 'watch', 'hype']) {
      expect(validateNewsDigestPayload(payload({ items: [item({ verdict })] }))).toBeNull()
    }
  })

  it('does not reject an unknown category, source type or action kind', () => {
    expect(validateNewsDigestPayload(payload({
      items: [item({
        category: 'quantum_teleportation',
        action: { kind: 'teleport', text: 'Hold on.' },
        sources: [source({ type: 'newsletter' })],
      })],
    }))).toBeNull()
  })

  it('ignores unknown fields (forward compatibility)', () => {
    expect(validateNewsDigestPayload(payload({
      mood: 'curious',
      items: [item({ sentiment: 0.4, sources: [source({ archived_url: 'https://example.com/x' })] })],
    }))).toBeNull()
  })

  it('accepts a payload without the optional blocks', () => {
    const value = payload()
    delete (value as Record<string, unknown>).quick_hits
    delete (value as Record<string, unknown>).stats
    delete (value as Record<string, unknown>).schema_version
    delete (value as Record<string, unknown>).date
    expect(validateNewsDigestPayload(value)).toBeNull()
  })

  it('accepts the maxima', () => {
    const items = Array.from({ length: NEWS_DIGEST_MAX_ITEMS }, (_, index) => item({ id: `story-${index}`, rank: index + 1 }))
    const sources = Array.from({ length: NEWS_DIGEST_MAX_SOURCES }, (_, index) => source({ url: `https://example.com/${index}` }))
    const quickHits = Array.from({ length: NEWS_DIGEST_MAX_QUICK_HITS }, (_, index) => ({ title: `Q${index}`, url: `https://example.com/q${index}` }))
    expect(validateNewsDigestPayload(payload({ items, quick_hits: quickHits }))).toBeNull()
    expect(validateNewsDigestPayload(payload({ items: [item({ sources })] }))).toBeNull()
  })
})

describe('validateNewsDigestPayload — rejected', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a foreign schema_version', payload({ schema_version: 'news_digest.v2' }), /schema_version/],
    ['a missing headline', payload({ headline: undefined }), /headline is required/],
    ['an empty headline', payload({ headline: '   ' }), /headline is required/],
    ['a non-string headline', payload({ headline: 42 }), /headline must be a string/],
    ['an over-long headline', payload({ headline: 'x'.repeat(441) }), /headline must be at most 440/],
    ['missing items', payload({ items: undefined }), /items is required/],
    ['items that are not an array', payload({ items: { a: 1 } }), /items is required/],
    ['zero items', payload({ items: [] }), /between 1 and 20/],
    ['21 items', payload({ items: Array.from({ length: 21 }, (_, i) => item({ id: `s-${i}` })) }), /between 1 and 20/],
    ['an item that is not an object', payload({ items: ['nope'] }), /items\[0\] must be an object/],
    ['an item without id', payload({ items: [item({ id: '' })] }), /items\[0\]\.id is required/],
    ['an item without title', payload({ items: [item({ title: undefined })] }), /items\[0\]\.title is required/],
    ['an item without summary', payload({ items: [item({ summary: '  ' })] }), /items\[0\]\.summary is required/],
    ['an unknown verdict', payload({ items: [item({ verdict: 'spicy' })] }), /verdict must be one of/],
    ['a missing verdict', payload({ items: [item({ verdict: undefined })] }), /verdict must be one of/],
    ['a non-numeric rank', payload({ items: [item({ rank: 'first' })] }), /rank must be a finite number/],
    ['an infinite score', payload({ items: [item({ score: Number.POSITIVE_INFINITY })] }), /score must be a finite number/],
    ['a non-boolean is_update', payload({ items: [item({ is_update: 'yes' })] }), /is_update must be a boolean/],
    ['an action that is not an object', payload({ items: [item({ action: 'try it' })] }), /action must be an object/],
    ['tags that are not an array', payload({ items: [item({ tags: 'models' })] }), /tags must be an array/],
    ['a non-string tag', payload({ items: [item({ tags: [1] })] }), /tags\[0\] must be a string/],
    ['13 tags', payload({ items: [item({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) })] }), /tags must have at most 12/],
    ['missing sources', payload({ items: [item({ sources: undefined })] }), /sources must be an array/],
    ['zero sources', payload({ items: [item({ sources: [] })] }), /between 1 and 20/],
    ['21 sources', payload({ items: [item({ sources: Array.from({ length: 21 }, () => source()) })] }), /between 1 and 20/],
    ['a source without a name', payload({ items: [item({ sources: [source({ name: '' })] })] }), /sources\[0\]\.name is required/],
    ['a source without a url', payload({ items: [item({ sources: [source({ url: undefined })] })] }), /sources\[0\]\.url is required/],
    ['an http source url', payload({ items: [item({ sources: [source({ url: 'http://example.com/a' })] })] }), /must start with "https:\/\/"/],
    ['a javascript source url', payload({ items: [item({ sources: [source({ url: 'javascript:alert(1)' })] })] }), /must start with "https:\/\/"/],
    ['a data source url', payload({ items: [item({ sources: [source({ url: 'data:text/html,<p>x' })] })] }), /must start with "https:\/\/"/],
    ['a protocol-relative source url', payload({ items: [item({ sources: [source({ url: '//example.com/a' })] })] }), /must start with "https:\/\/"/],
    ['quick_hits that are not an array', payload({ quick_hits: 'none' }), /quick_hits must be an array/],
    ['21 quick hits', payload({ quick_hits: Array.from({ length: 21 }, (_, i) => ({ title: `Q${i}`, url: 'https://example.com/q' })) }), /at most 20/],
    ['a quick hit without a title', payload({ quick_hits: [{ url: 'https://example.com/q' }] }), /quick_hits\[0\]\.title is required/],
    ['a quick hit with an http url', payload({ quick_hits: [{ title: 'Q', url: 'http://example.com/q' }] }), /must start with "https:\/\/"/],
    ['a quick hit with a javascript url', payload({ quick_hits: [{ title: 'Q', url: 'javascript:alert(1)' }] }), /must start with "https:\/\/"/],
    ['stats that are not an object', payload({ stats: 31 }), /stats must be an object/],
    ['a non-numeric sources_checked', payload({ stats: { sources_checked: 'many' } }), /sources_checked must be a finite number/],
    ['sources_failed that is not an array', payload({ stats: { sources_checked: 1, sources_failed: 'Example Feed' } }), /sources_failed must be an array/],
    ['a non-string entry in sources_failed', payload({ stats: { sources_checked: 1, sources_failed: [7] } }), /sources_failed\[0\] must be a string/],
    ['an over-long summary', payload({ items: [item({ summary: 'x'.repeat(1401) })] }), /summary must be at most 1400/],
    ['an over-long title', payload({ items: [item({ title: 'x'.repeat(281) })] }), /title must be at most 280/],
    ['an over-long action text', payload({ items: [item({ action: { kind: 'try', text: 'x'.repeat(441) } })] }), /action\.text must be at most 440/],
  ]

  for (const [label, value, expected] of cases) {
    it(`rejects ${label}`, () => {
      const problem = validateNewsDigestPayload(value)
      expect(problem, `expected a rejection for ${label}`).toBeTruthy()
      expect(problem).toMatch(expected)
    })
  }

  it('never rewrites the payload it inspects', () => {
    const value = payload()
    const before = JSON.stringify(value)
    validateNewsDigestPayload(value)
    expect(JSON.stringify(value)).toBe(before)
  })
})
