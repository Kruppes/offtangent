/**
 * The parser is the only thing between an agent-written payload and the
 * screen, so these tests are about what it refuses to do: invent a `take`,
 * link a non-https URL, throw on a broken item, or reorder what the payload
 * decided. Both wire formats land in the same model.
 *
 * All fixtures are synthetic (Alice/Bob, example.com).
 */
import { describe, expect, it } from 'vitest'
import {
  isHttpsUrl, parseNewsDigest, sourceHost, verdictShape,
  actionLabelKey, sourceTypeLabelKey, verdictLabelKey, storyReadKey,
} from './newsDigest'

const v2 = {
  schema_version: 'news_digest.v2',
  date: '2026-09-28',
  generated_at: '2026-09-28T07:04:00+02:00',
  headline: 'Two releases and one licence change.',
  categories: { frontier: 'Frontier', tts_stt: 'Speech' },
  items: [
    {
      story_id: 'model-3', rank: 2, status: 'new', title: 'Example Lab releases model 3',
      take: 'Real progress, weak benchmarks.', category: 'frontier', verdict: 'hot',
      summary: 'A longer context window.', critique: 'Only compared against itself.',
      relevance: 'Worth a day on the agent loop.', action: { kind: 'try', text: 'Run it.' },
      source_count: 4,
      sources: [
        { name: 'Example Wire', url: 'https://news.example.com/a', type: 'press', published_at: '2026-09-28' },
        { name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary', published_at: '2026-09-27' },
        { name: 'Example Paper', url: 'https://arxiv.example.org/abs/1', type: 'paper', published_at: '2026-09-20' },
        { name: 'Insecure Feed', url: 'http://insecure.example.com/a', type: 'aggregator' },
      ],
    },
    {
      story_id: 'speech-1', rank: 1, status: 'update', delta: 'The licence changed.',
      title: 'Cheaper speech stack', category: 'video', verdict: 'watch',
      take: 'Cheap, but every source is a reseller.', summary: 'A third of the price.',
      sources: [{ name: 'Example Vendor', url: 'https://vendor.example.com/p' }],
    },
  ],
  quick_hits: [
    { title: 'Example toolkit 2.0', url: 'https://example.org/toolkit', source: 'Example Org', note: 'Minor.' },
    { title: 'Unlinkable hit', url: 'javascript:alert(1)' },
  ],
  stats: { sources_checked: 31, sources_failed: ['Example Feed'], candidates: 191 },
}

const v1 = {
  schema_version: 'news_digest.v1',
  date: '2026-09-27',
  headline: 'A quiet Sunday.',
  items: [{
    id: 'patch-1', rank: 1, title: 'Example Lab ships a patch', category: 'tooling', verdict: 'relevant',
    summary: 'Bug fixes only.', is_update: true,
    sources: [{ name: 'Example Lab blog', url: 'https://example.com/patch', type: 'primary' }],
  }],
  stats: { sources_checked: 28 },
}

describe('parseNewsDigest — v2', () => {
  it('reads the digest head', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.schemaVersion).toBe('news_digest.v2')
    expect(digest.date).toBe('2026-09-28')
    expect(digest.headline).toBe('Two releases and one licence change.')
    expect(digest.sourcesChecked).toBe(31)
    expect(digest.candidates).toBe(191)
    expect(digest.sourcesFailed).toEqual(['Example Feed'])
    expect(digest.hotCount).toBe(1)
  })

  it('orders items by rank and keeps story ids, rank labels and status', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.items.map(item => item.storyId)).toEqual(['speech-1', 'model-3'])
    expect(digest.items.map(item => item.rankLabel)).toEqual(['01', '02'])
    expect(digest.items[0]!.status).toBe('update')
    expect(digest.items[0]!.delta).toBe('The licence changed.')
    expect(digest.items[1]!.status).toBe('new')
    expect(digest.items[1]!.delta).toBeUndefined()
  })

  it('keeps the take as written and never derives one', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.items[1]!.take).toBe('Real progress, weak benchmarks.')
    const withoutTake = parseNewsDigest({ ...v2, items: [{ ...v2.items[0], take: undefined }] })!
    expect(withoutTake.items[0]!.take).toBeUndefined()
    expect(withoutTake.items[0]!.summary).toBe('A longer context window.')
  })

  it('labels the category from the payload map, falls back to the raw id', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.items[1]!.categoryLabel).toBe('Frontier')
    // `video` is not in this payload's map but is a known v1 id.
    expect(digest.items[0]!.categoryLabel).toBe('Video')
    const unknown = parseNewsDigest({ ...v2, items: [{ ...v2.items[0], category: 'quantum_kittens' }] })!
    expect(unknown.items[0]!.categoryLabel).toBe('quantum_kittens')
  })

  it('sorts sources firsthand first, then by date, and marks firsthand types', () => {
    const story = parseNewsDigest(v2)!.items[1]!
    expect(story.sources.map(source => source.name)).toEqual(['Example Paper', 'Example Lab blog', 'Example Wire', 'Insecure Feed'])
    expect(story.sources.map(source => source.firsthand)).toEqual([true, true, false, false])
    expect(story.firsthandCount).toBe(2)
    expect(story.sources[0]!.publishedAt).toBe('2026-09-20')
    expect(story.sources[1]!.host).toBe('example.com')
  })

  it('keeps a non-https source as text without a link', () => {
    const story = parseNewsDigest(v2)!.items[1]!
    const insecure = story.sources.find(source => source.name === 'Insecure Feed')!
    expect(insecure.url).toBeUndefined()
    expect(insecure.name).toBe('Insecure Feed')
  })

  it('uses the declared source_count when it is at least the number of sources', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.items[1]!.sourceCount).toBe(4)
    const understated = parseNewsDigest({ ...v2, items: [{ ...v2.items[0], source_count: 1 }] })!
    expect(understated.items[0]!.sourceCount).toBe(4)
  })

  it('keeps quick hits but drops a javascript: link', () => {
    const digest = parseNewsDigest(v2)!
    expect(digest.quickHits).toHaveLength(2)
    expect(digest.quickHits[0]!.url).toBe('https://example.org/toolkit')
    expect(digest.quickHits[0]!.note).toBe('Minor.')
    expect(digest.quickHits[1]!.url).toBeUndefined()
    expect(digest.quickHits[1]!.title).toBe('Unlinkable hit')
  })
})

describe('parseNewsDigest — v1 revisions', () => {
  it('maps a v1 item onto the same model', () => {
    const digest = parseNewsDigest(v1)!
    expect(digest.schemaVersion).toBe('news_digest.v1')
    const story = digest.items[0]!
    expect(story.storyId).toBe('patch-1')
    expect(story.take).toBeUndefined()
    expect(story.status).toBe('update')
    expect(story.categoryLabel).toBe('Tooling')
    expect(story.sourceCount).toBe(1)
    expect(story.firsthandCount).toBe(1)
    expect(story.sources[0]!.publishedAt).toBeUndefined()
  })

  it('detects the version from the payload when schema_version is missing', () => {
    expect(parseNewsDigest({ ...v2, schema_version: undefined })!.schemaVersion).toBe('news_digest.v2')
    expect(parseNewsDigest({ ...v1, schema_version: undefined })!.schemaVersion).toBe('news_digest.v1')
  })
})

describe('parseNewsDigest — broken payloads', () => {
  it('returns null for anything that is not an object with content', () => {
    for (const value of [null, undefined, 'x', 42, [], {}, { items: [] }, { items: [{ id: 'x' }] }]) {
      expect(parseNewsDigest(value)).toBeNull()
    }
  })

  it('keeps a digest that has a headline but no item', () => {
    const digest = parseNewsDigest({ headline: 'Quiet day.', items: [] })!
    expect(digest.items).toHaveLength(0)
    expect(digest.headline).toBe('Quiet day.')
  })

  it('skips an item without a title instead of throwing', () => {
    const digest = parseNewsDigest({ ...v2, items: [...v2.items, { story_id: 'broken', verdict: 'hype' }] })!
    expect(digest.items).toHaveLength(2)
  })

  it('survives wrong types everywhere', () => {
    const digest = parseNewsDigest({
      headline: 'Odd payload',
      categories: 'nope',
      items: [{ story_id: 7, title: 'Still a title', rank: 'first', sources: 'none', tags: 5, action: 'try', status: 9 }],
      quick_hits: 'none',
      stats: 'none',
    })!
    const story = digest.items[0]!
    expect(story.storyId).toBe('item-0')
    expect(story.rankLabel).toBe('')
    expect(story.status).toBe('new')
    expect(story.sources).toEqual([])
    expect(story.sourceCount).toBe(0)
    expect(story.action).toBeUndefined()
    expect(digest.quickHits).toEqual([])
    expect(digest.sourcesFailed).toEqual([])
  })

  it('never mutates the payload', () => {
    const value = JSON.parse(JSON.stringify(v2))
    const before = JSON.stringify(value)
    parseNewsDigest(value)
    expect(JSON.stringify(value)).toBe(before)
  })
})

describe('link and label helpers', () => {
  it('accepts only https URLs', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true)
    for (const value of ['http://example.com', 'javascript:alert(1)', 'data:text/html,<p>', '//example.com', 'example.com', '', null, 7]) {
      expect(isHttpsUrl(value)).toBe(false)
    }
  })

  it('shortens the host for the source line', () => {
    expect(sourceHost('https://www.example.com/a/b')).toBe('example.com')
    expect(sourceHost('https://news.example.com')).toBe('news.example.com')
    expect(sourceHost(undefined)).toBeUndefined()
  })

  it('gives the verdict four different shapes, unknown ones the quietest', () => {
    expect(verdictShape('hot')).toBe('filled-signal')
    expect(verdictShape('relevant')).toBe('filled-raised')
    expect(verdictShape('watch')).toBe('outlined')
    expect(verdictShape('hype')).toBe('bare')
    expect(verdictShape('spicy')).toBe('bare')
    expect(new Set(['hot', 'relevant', 'watch', 'hype'].map(verdictShape)).size).toBe(4)
  })

  it('translates only known enum values', () => {
    expect(verdictLabelKey('hot')).toBe('boards.news.verdict.hot')
    expect(verdictLabelKey('spicy')).toBeNull()
    expect(sourceTypeLabelKey('primary')).toBe('boards.news.sourceType.primary')
    expect(sourceTypeLabelKey('newsletter')).toBeNull()
    expect(actionLabelKey('try')).toBe('boards.news.action.try')
    expect(actionLabelKey('ponder')).toBeNull()
  })
})

describe('storyReadKey — read state per story and last change', () => {
  it('uses the plain story id while the story does not change', () => {
    expect(storyReadKey({ storyId: 'model-3', status: 'new' })).toBe('model-3')
    expect(storyReadKey({ storyId: 'model-3', status: 'new', delta: 'ignored' })).toBe('model-3')
  })

  it('changes the key when the story returns as an update with a delta', () => {
    const first = storyReadKey({ storyId: 'model-3', status: 'update', delta: 'The licence now allows commercial use.' })
    const second = storyReadKey({ storyId: 'model-3', status: 'update', delta: 'And the price dropped again.' })
    expect(first).not.toBe('model-3')
    expect(first).toContain('model-3@')
    expect(second).not.toBe(first)
    // Same delta, same key: re-rendering the same revision keeps it read.
    expect(storyReadKey({ storyId: 'model-3', status: 'update', delta: 'The licence now allows commercial use.' })).toBe(first)
    // Whitespace around the delta is not a change.
    expect(storyReadKey({ storyId: 'model-3', status: 'update', delta: '  The licence now allows commercial use. ' })).toBe(first)
  })

  it('keeps an update without a delta apart from the new state', () => {
    expect(storyReadKey({ storyId: 'x', status: 'update' })).toBe('x@update')
    expect(storyReadKey({ storyId: 'x', status: 'update', delta: '   ' })).toBe('x@update')
    expect(storyReadKey({ storyId: 'x', status: 'new' })).toBe('x')
  })

  it('keeps the keys of different stories apart', () => {
    const delta = 'Same delta text.'
    expect(storyReadKey({ storyId: 'a', status: 'update', delta })).not.toBe(storyReadKey({ storyId: 'b', status: 'update', delta }))
  })
})
