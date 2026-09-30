import { describe, expect, it } from 'vitest'
import { buildNewsAskHandoff, parseRevision } from './newsAskHandoff'
import type { Board } from '~/api/boards'

const payload = {
  schema_version: 'news_digest.v2',
  date: '2026-09-28',
  headline: 'Two releases.',
  items: [{
    story_id: 'model-3', rank: 1, title: 'Example Lab releases model 3', verdict: 'hot',
    take: 'Real progress on context, the rate limits are hidden.',
    summary: 'A longer context window and a lower price.',
    sources: [{ name: 'Example Lab blog', url: 'https://example.com/post', type: 'primary' }],
  }],
}

function board(overrides: Partial<Board> = {}): Board {
  return {
    key: 'ai-news', kind: 'news_digest.v2', title: 'AI news', icon: null, summary: null,
    payload, revision: 9, asOf: '2026-09-28T05:00:00Z', updatedAt: '2026-09-28T05:00:00Z',
    ...overrides,
  } as Board
}

describe('parseRevision', () => {
  it('takes a positive integer and refuses everything else', () => {
    expect(parseRevision('9')).toBe(9)
    expect(parseRevision('0')).toBeNull()
    expect(parseRevision('-3')).toBeNull()
    expect(parseRevision('')).toBeNull()
    expect(parseRevision('abc')).toBeNull()
  })
})

describe('buildNewsAskHandoff', () => {
  it('rebuilds the article snapshot from the board the API returned', () => {
    const result = buildNewsAskHandoff(board(), 'ai-news', 'model-3')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.handoff.title).toBe('Example Lab releases model 3')
    expect(result.handoff.text).toContain('Example Lab releases model 3')
    expect(result.handoff.text).toContain('A longer context window and a lower price.')
    expect(result.handoff.text).toContain('https://example.com/post')
    // The revision the reader saw is part of the snapshot, so a republished
    // board cannot silently change what the question is about.
    expect(result.handoff.text).toContain('9')
    expect(result.handoff.text.endsWith('\n\n')).toBe(true)
  })

  it('says so when the story is gone from that revision', () => {
    expect(buildNewsAskHandoff(board(), 'ai-news', 'not-there')).toEqual({ ok: false, error: 'ask.storyGone' })
  })

  it('says so when the link carried no board or no story', () => {
    expect(buildNewsAskHandoff(board(), '', 'model-3')).toEqual({ ok: false, error: 'ask.missing' })
    expect(buildNewsAskHandoff(board(), 'ai-news', '')).toEqual({ ok: false, error: 'ask.missing' })
  })

  it('treats a board that is not a news digest as a missing story', () => {
    const other = board({ kind: 'portfolio_digest.v1', payload: { schema_version: 'portfolio_digest.v1' } })
    expect(buildNewsAskHandoff(other, 'ai-news', 'model-3')).toEqual({ ok: false, error: 'ask.storyGone' })
  })
})
