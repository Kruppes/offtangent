/**
 * `news_digest.v2` payload contract (plan 2026-09-28, v2 contract document).
 *
 * The backend is the last gate before a digest lands on two clients, so every
 * rejection rule of the contract has a test here — and so has every rule the
 * backend must NOT have: an unknown category, source type, action kind or an
 * `update` without `delta` are client display questions, not publishing errors.
 *
 * All fixtures are synthetic (Alice/Bob, example.com).
 */
import { describe, it, expect } from 'vitest'
import {
  NEWS_DIGEST_MAX_ITEMS,
  NEWS_DIGEST_MAX_QUICK_HITS,
  NEWS_DIGEST_MAX_SOURCES,
  NEWS_DIGEST_V2_KIND,
  validateNewsDigestV2Payload,
} from './board-news-digest.js'

function source(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Example Lab blog',
    url: 'https://example.com/post',
    type: 'primary',
    published_at: '2026-09-27',
    ...overrides,
  }
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    story_id: 'example-model-3',
    rank: 1,
    status: 'new',
    delta: null,
    title: 'Example Lab releases model 3',
    take: 'Solid step, but the benchmark table only compares against its own predecessor.',
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
    ...overrides,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: NEWS_DIGEST_V2_KIND,
    profile: 'example',
    date: '2026-09-28',
    generated_at: '2026-09-28T07:04:00+02:00',
    window_hours: 30,
    headline: 'Two releases, one of them matters',
    categories: { frontier: 'Frontier', tts_stt: 'Speech' },
    items: [item()],
    quick_hits: [{ title: 'Example tool 0.4', url: 'https://example.com/tool', source: 'Example Wire', note: 'Patch release.' }],
    stats: { sources_checked: 31, sources_failed: ['Example Feed'], candidates: 255, clusters: 60 },
    ...overrides,
  }
}

describe('validateNewsDigestV2Payload — accepted', () => {
  it('accepts a full payload', () => {
    expect(validateNewsDigestV2Payload(payload())).toBeNull()
  })

  it('accepts the minimum: headline, one item with the four required strings, one source', () => {
    expect(validateNewsDigestV2Payload({
      headline: 'One thing happened',
      items: [{
        story_id: 'a-thing',
        title: 'A thing happened',
        take: 'Worth a look, nothing urgent.',
        summary: 'Alice published a thing.',
        verdict: 'watch',
        sources: [{ name: 'Example blog', url: 'https://example.com/a' }],
      }],
    })).toBeNull()
  })

  it('accepts a payload without schema_version', () => {
    expect(validateNewsDigestV2Payload(payload({ schema_version: undefined }))).toBeNull()
  })

  it.each(['hot', 'relevant', 'watch', 'hype'])('accepts verdict %s', (verdict) => {
    expect(validateNewsDigestV2Payload(payload({ items: [item({ verdict })] }))).toBeNull()
  })

  it.each(['new', 'update'])('accepts status %s', (status) => {
    expect(validateNewsDigestV2Payload(payload({ items: [item({ status, delta: 'The licence changed.' })] }))).toBeNull()
  })

  it('accepts status update without delta (the renderer just omits the section)', () => {
    expect(validateNewsDigestV2Payload(payload({ items: [item({ status: 'update', delta: undefined })] }))).toBeNull()
  })

  it('accepts an unknown category, source type and action kind', () => {
    expect(validateNewsDigestV2Payload(payload({
      items: [item({ category: 'quantum_kittens', sources: [source({ type: 'newsletter' })], action: { kind: 'ponder', text: 'Think about it.' } })],
    }))).toBeNull()
  })

  it('accepts a category that has no entry in the categories map', () => {
    expect(validateNewsDigestV2Payload(payload({ categories: { frontier: 'Frontier' }, items: [item({ category: 'video' })] }))).toBeNull()
  })

  it('accepts a payload without the optional blocks', () => {
    expect(validateNewsDigestV2Payload(payload({
      categories: undefined, quick_hits: undefined, stats: undefined, window_hours: undefined,
      profile: undefined, date: undefined, generated_at: undefined,
      items: [item({ delta: undefined, action: undefined, tags: undefined, score: undefined, rank: undefined, status: undefined, critique: undefined, relevance: undefined, source_count: undefined })],
    }))).toBeNull()
  })

  it('accepts unknown extra fields', () => {
    expect(validateNewsDigestV2Payload(payload({ mood: 'sunny', items: [item({ vibes: 7 })] }))).toBeNull()
  })

  it('accepts a source without published_at', () => {
    expect(validateNewsDigestV2Payload(payload({ items: [item({ sources: [source({ published_at: undefined })] })] }))).toBeNull()
  })

  it('accepts the maxima', () => {
    const items = Array.from({ length: NEWS_DIGEST_MAX_ITEMS }, (_, index) => item({ story_id: `story-${index}`, rank: index + 1 }))
    const sources = Array.from({ length: NEWS_DIGEST_MAX_SOURCES }, (_, index) => source({ url: `https://example.com/${index}` }))
    const quickHits = Array.from({ length: NEWS_DIGEST_MAX_QUICK_HITS }, (_, index) => ({ title: `Q${index}`, url: `https://example.com/q${index}` }))
    expect(validateNewsDigestV2Payload(payload({ items, quick_hits: quickHits }))).toBeNull()
    expect(validateNewsDigestV2Payload(payload({ items: [item({ sources })] }))).toBeNull()
  })

  it('accepts text exactly at the generous caps', () => {
    expect(validateNewsDigestV2Payload(payload({
      headline: 'x'.repeat(240),
      items: [item({
        title: 'x'.repeat(180), take: 'x'.repeat(280), summary: 'x'.repeat(840),
        critique: 'x'.repeat(960), relevance: 'x'.repeat(480), delta: 'x'.repeat(280),
        action: { kind: 'try', text: 'x'.repeat(320) },
      })],
    }))).toBeNull()
  })
})

describe('validateNewsDigestV2Payload — rejected', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a v1 schema_version', payload({ schema_version: 'news_digest.v1' }), /schema_version must be "news_digest\.v2"/],
    ['a missing headline', payload({ headline: undefined }), /headline is required/],
    ['an empty headline', payload({ headline: '   ' }), /headline is required/],
    ['a non-string headline', payload({ headline: 42 }), /headline must be a string/],
    ['an over-long headline', payload({ headline: 'x'.repeat(241) }), /headline must be at most 240/],
    ['a non-string date', payload({ date: 20260928 }), /date must be a string/],
    ['a non-numeric window_hours', payload({ window_hours: '30h' }), /window_hours must be a finite number/],
    ['categories that are not an object', payload({ categories: ['Frontier'] }), /categories must be an object/],
    ['a non-string category label', payload({ categories: { frontier: 7 } }), /categories\.frontier must be a string label/],
    ['an over-long category label', payload({ categories: { frontier: 'x'.repeat(121) } }), /categories\.frontier must be at most 120/],
    ['missing items', payload({ items: undefined }), /items is required/],
    ['items that are not an array', payload({ items: { a: 1 } }), /items is required/],
    ['zero items', payload({ items: [] }), /between 1 and 20/],
    ['21 items', payload({ items: Array.from({ length: 21 }, (_, i) => item({ story_id: `s-${i}` })) }), /between 1 and 20/],
    ['an item that is not an object', payload({ items: ['nope'] }), /items\[0\] must be an object/],
    ['an item without story_id', payload({ items: [item({ story_id: undefined })] }), /items\[0\]\.story_id is required/],
    ['an empty story_id', payload({ items: [item({ story_id: '  ' })] }), /items\[0\]\.story_id is required/],
    ['an item without title', payload({ items: [item({ title: undefined })] }), /items\[0\]\.title is required/],
    ['an item without take', payload({ items: [item({ take: undefined })] }), /items\[0\]\.take is required/],
    ['an empty take', payload({ items: [item({ take: '' })] }), /items\[0\]\.take is required/],
    ['an item without summary', payload({ items: [item({ summary: '  ' })] }), /items\[0\]\.summary is required/],
    ['an unknown verdict', payload({ items: [item({ verdict: 'spicy' })] }), /verdict must be one of hot, relevant, watch, hype/],
    ['a missing verdict', payload({ items: [item({ verdict: undefined })] }), /verdict must be one of/],
    ['an unknown status', payload({ items: [item({ status: 'revisited' })] }), /status must be one of new, update/],
    ['a non-string status', payload({ items: [item({ status: 1 })] }), /status must be one of new, update/],
    ['an over-long title', payload({ items: [item({ title: 'x'.repeat(181) })] }), /title must be at most 180/],
    ['an over-long take', payload({ items: [item({ take: 'x'.repeat(281) })] }), /take must be at most 280/],
    ['an over-long summary', payload({ items: [item({ summary: 'x'.repeat(841) })] }), /summary must be at most 840/],
    ['an over-long critique', payload({ items: [item({ critique: 'x'.repeat(961) })] }), /critique must be at most 960/],
    ['an over-long relevance', payload({ items: [item({ relevance: 'x'.repeat(481) })] }), /relevance must be at most 480/],
    ['an over-long delta', payload({ items: [item({ delta: 'x'.repeat(281) })] }), /delta must be at most 280/],
    ['an over-long action text', payload({ items: [item({ action: { kind: 'try', text: 'x'.repeat(321) } })] }), /action\.text must be at most 320/],
    ['an action that is not an object', payload({ items: [item({ action: 'try it' })] }), /action must be an object/],
    ['a non-numeric rank', payload({ items: [item({ rank: 'first' })] }), /rank must be a finite number/],
    ['an infinite score', payload({ items: [item({ score: Number.POSITIVE_INFINITY })] }), /score must be a finite number/],
    ['a non-numeric source_count', payload({ items: [item({ source_count: 'four' })] }), /source_count must be a finite number/],
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
    ['a non-string published_at', payload({ items: [item({ sources: [source({ published_at: 20260901 })] })] }), /published_at must be a string/],
    ['quick_hits that are not an array', payload({ quick_hits: 'none' }), /quick_hits must be an array/],
    ['21 quick hits', payload({ quick_hits: Array.from({ length: 21 }, (_, i) => ({ title: `Q${i}`, url: 'https://example.com/q' })) }), /at most 20/],
    ['a quick hit without a title', payload({ quick_hits: [{ url: 'https://example.com/q' }] }), /quick_hits\[0\]\.title is required/],
    ['a quick hit with an http url', payload({ quick_hits: [{ title: 'Q', url: 'http://example.com/q' }] }), /must start with "https:\/\/"/],
    ['a quick hit with a javascript url', payload({ quick_hits: [{ title: 'Q', url: 'javascript:alert(1)' }] }), /must start with "https:\/\/"/],
    ['a quick hit without a url', payload({ quick_hits: [{ title: 'Q' }] }), /quick_hits\[0\]\.url is required/],
    ['stats that are not an object', payload({ stats: 31 }), /stats must be an object/],
    ['a non-numeric sources_checked', payload({ stats: { sources_checked: 'many' } }), /sources_checked must be a finite number/],
    ['sources_failed that is not an array', payload({ stats: { sources_checked: 1, sources_failed: 'Example Feed' } }), /sources_failed must be an array/],
    ['a non-string entry in sources_failed', payload({ stats: { sources_checked: 1, sources_failed: [7] } }), /sources_failed\[0\] must be a string/],
  ]

  for (const [label, value, expected] of cases) {
    it(`rejects ${label}`, () => {
      const problem = validateNewsDigestV2Payload(value)
      expect(problem, `expected a rejection for ${label}`).toBeTruthy()
      expect(problem).toMatch(expected)
    })
  }

  it('never rewrites the payload it inspects', () => {
    const value = payload()
    const before = JSON.stringify(value)
    validateNewsDigestV2Payload(value)
    expect(JSON.stringify(value)).toBe(before)
  })

  it('does not accept a v1 item shape (id/no take) under v2', () => {
    const problem = validateNewsDigestV2Payload({
      headline: 'Old shape',
      items: [{ id: 'a', title: 'A', summary: 'B', verdict: 'hot', sources: [{ name: 'n', url: 'https://example.com/a' }] }],
    })
    expect(problem).toMatch(/story_id is required/)
  })
})
