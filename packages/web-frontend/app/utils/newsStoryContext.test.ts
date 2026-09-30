import { describe, expect, it } from 'vitest'
import { buildNewsStoryContext, newsStoryComposerDraft, newsStoryLink } from './newsStoryContext'
import { parseNewsDigest } from './newsDigest'

/** Synthetic v2 payload, one v2 and one v1-shaped story. */
const v2Payload = {
  schema_version: 'news_digest.v2',
  date: '2026-09-28',
  headline: 'Two releases.',
  categories: { frontier: 'Frontier' },
  items: [{
    story_id: 'model-3', rank: 1, status: 'update', delta: 'The licence now allows commercial use.',
    title: 'Example Lab releases model 3', category: 'frontier', verdict: 'hot',
    take: 'Real progress on context, the rate limits are hidden.',
    summary: 'A longer context window and a lower price.',
    critique: 'The benchmark table only compares against its own predecessor.',
    relevance: 'Worth a day on the agent loop.',
    sources: [
      { name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary', published_at: '2026-09-27' },
      { name: 'Insecure Feed', url: 'http://insecure.example.com/a', type: 'aggregator' },
    ],
  }],
}

const options = {
  boardKey: 'ai-news', boardTitle: 'AI news', revision: 9,
  date: '2026-09-28', basePath: '/boards/ai-news',
}

function story(payload: unknown = v2Payload, index = 0) {
  const digest = parseNewsDigest(payload)
  if (!digest) throw new Error('fixture does not parse')
  const item = digest.items[index]
  if (!item) throw new Error('fixture has no such item')
  return item
}

describe('newsStoryLink', () => {
  it('builds the shareable deep link of the story', () => {
    expect(newsStoryLink(story(), options)).toBe('/boards/ai-news?date=2026-09-28&story=model-3')
  })

  it('returns an empty string without an app-relative base path', () => {
    expect(newsStoryLink(story(), { ...options, basePath: 'https://evil.example.com' })).toBe('')
    expect(newsStoryLink(story(), { ...options, basePath: null })).toBe('')
  })
})

describe('buildNewsStoryContext', () => {
  it('carries title, take, summary, delta, date, board and story id', () => {
    const block = buildNewsStoryContext(story(), options)
    expect(block).toContain('Code: ot-news:ai-news/model-3@r9')
    expect(block).toContain('Board: AI news (ai-news) · Digest date: 2026-09-28 · Revision: 9')
    expect(block).toContain('Story: model-3 · Verdict: hot · Category: Frontier')
    expect(block).toContain('Title: Example Lab releases model 3')
    expect(block).toContain('Take: Real progress on context, the rate limits are hidden.')
    expect(block).toContain('Summary: A longer context window and a lower price.')
    expect(block).toContain("What's new: The licence now allows commercial use.")
    expect(block).toContain('Board link: /boards/ai-news?date=2026-09-28&story=model-3')
  })

  it('keeps https sources as links and drops the http one to its name', () => {
    const block = buildNewsStoryContext(story(), options)
    expect(block).toContain('- Example Lab blog (primary, 2026-09-27): https://example.com/post')
    expect(block).toContain('- Insecure Feed (aggregator) (no link in the payload)')
    expect(block).not.toContain('http://insecure.example.com')
  })

  /**
   * The digest's own opinion is not evidence. "Use in question" hands over the
   * story, not the verdict the board already wrote about it.
   */
  it('leaves critique and relevance out of the context', () => {
    const block = buildNewsStoryContext(story(), options)
    expect(block).not.toContain('only compares against its own predecessor')
    expect(block).not.toContain('Worth a day on the agent loop')
  })

  it('claims no full text', () => {
    expect(buildNewsStoryContext(story(), options)).toContain('not the full text')
  })

  it('renders a v1 story without inventing a take or a delta', () => {
    const v1 = {
      schema_version: 'news_digest.v1',
      date: '2026-09-20', headline: 'An older digest.',
      items: [{
        id: 'legacy', title: 'An older story', verdict: 'relevant',
        summary: 'A v1 item has a summary but no take.',
        sources: [{ name: 'Example Lab blog', url: 'https://example.com/legacy', type: 'primary' }],
      }],
    }
    const block = buildNewsStoryContext(story(v1), { ...options, date: '2026-09-20', revision: 4 })
    expect(block).toContain('Code: ot-news:ai-news/legacy@r4')
    expect(block).toContain('Title: An older story')
    expect(block).not.toContain('Take:')
    expect(block).not.toContain("What's new:")
  })

  /**
   * The same story on two revisions yields two codes. An older message keeps
   * pointing at the revision it was written from, even after the board was
   * republished with a changed story.
   */
  it('pins the revision the snapshot was taken from', () => {
    const before = buildNewsStoryContext(story(), { ...options, revision: 9 })
    const changed = {
      ...v2Payload,
      items: [{ ...v2Payload.items[0], take: 'Rewritten take on revision 10.' }],
    }
    const after = buildNewsStoryContext(story(changed), { ...options, revision: 10 })
    expect(before).toContain('ot-news:ai-news/model-3@r9')
    expect(before).toContain('Take: Real progress on context, the rate limits are hidden.')
    expect(after).toContain('ot-news:ai-news/model-3@r10')
    expect(after).toContain('Take: Rewritten take on revision 10.')
  })
})

describe('newsStoryComposerDraft', () => {
  it('ends with a blank line so the question goes below the snapshot', () => {
    const draft = newsStoryComposerDraft(story(), options)
    expect(draft.startsWith(buildNewsStoryContext(story(), options))).toBe(true)
    expect(draft.endsWith('---\n\n')).toBe(true)
  })
})
