/**
 * W5b client contracts: tolerant mapping of the fork, search, facts and
 * recalled answers, snippet splitting (text only) and the anchor parser.
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest'
import {
  mapFacts, mapForkResult, mapMessageHits, mapRecalled, messageRoute, messageSearchTerm, snippetParts,
  STRAND_FACTS_PATH, STRAND_FORK_PATH,
} from './strandW5b'
import { anchoredMessageId } from '~/composables/useMessageAnchor'

describe('paths', () => {
  it('encodes the strand id', () => {
    expect(STRAND_FORK_PATH('a/b')).toBe('/api/strands/a%2Fb/fork')
    expect(STRAND_FACTS_PATH('s1')).toBe('/api/strands/s1/facts')
    expect(messageRoute('web:x y', 42)).toBe('/strands/web%3Ax%20y#msg-42')
  })
})

describe('mapForkResult', () => {
  it('maps the 201 body', () => {
    expect(mapForkResult({ fork: { strandId: 's2', title: 'T', parentStrandId: 's1', forkedFromMessageId: 7 }, strand: {} }))
      .toEqual({ strandId: 's2', title: 'T', parentStrandId: 's1', forkedFromMessageId: 7 })
  })
  it('rejects a body without a strand id', () => {
    expect(mapForkResult({})).toBeNull()
    expect(mapForkResult({ fork: { strandId: '' } })).toBeNull()
    expect(mapForkResult(null)).toBeNull()
  })
})

describe('mapMessageHits', () => {
  it('keeps valid hits, drops malformed ones, clamps and orders highlight ranges', () => {
    const hits = mapMessageHits({ hits: [
      { strandId: 's1', strandTitle: 'Alpha', messageId: 3, role: 'assistant', snippet: 'one two three', highlights: [[4, 7], [2, 5], [8, 99], ['x', 1]], timestamp: '2026-01-01 10:00:00' },
      { strandId: 's1', messageId: -1, snippet: 'x' },
      { strandId: 5, messageId: 4, snippet: 'x' },
      { strandId: 's2', messageId: 9, role: 'system', snippet: 'plain' },
    ] })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.highlights).toEqual([[4, 7], [8, 13]])
    expect(hits[1]).toMatchObject({ strandTitle: null, role: 'user', highlights: [], timestamp: null })
  })
  it('returns [] for anything else', () => {
    expect(mapMessageHits({ hits: 'no' })).toEqual([])
    expect(mapMessageHits(undefined)).toEqual([])
  })
})

describe('snippetParts', () => {
  it('splits into plain and marked text, markup stays text', () => {
    const parts = snippetParts({ snippet: '<b>x</b> needle end', highlights: [[9, 15]] })
    expect(parts).toEqual([{ text: '<b>x</b> ', match: false }, { text: 'needle', match: true }, { text: ' end', match: false }])
  })
  it('no highlights: one plain part', () => {
    expect(snippetParts({ snippet: 'abc', highlights: [] })).toEqual([{ text: 'abc', match: false }])
  })
})

describe('mapRecalled and mapFacts', () => {
  it('maps recalled rows and drops broken ones', () => {
    expect(mapRecalled({ recalled: [
      { messageId: 5, strandId: 's1', role: 'assistant', excerpt: 'e', recalledAt: '2026-01-01 10:00:00', source: 'context' },
      { messageId: 6, strandId: 's1' },
      { messageId: 'x', strandId: 's1' },
    ] })).toEqual([
      { messageId: 5, strandId: 's1', role: 'assistant', excerpt: 'e', recalledAt: '2026-01-01 10:00:00', source: 'context' },
      { messageId: 6, strandId: 's1', role: 'user', excerpt: '', recalledAt: null, source: 'recall' },
    ])
    expect(mapRecalled({})).toEqual([])
  })
  it('maps the facts list, total never below the listed count', () => {
    expect(mapFacts({ facts: [{ id: 1, text: 'f', createdAt: null, status: 'active' }, { id: 0, text: 'bad' }], total: 0, truncated: true, summaries: 2, toolCalls: 'x' }))
      .toEqual({ facts: [{ id: 1, text: 'f', createdAt: null, status: 'active' }], total: 1, truncated: true, summaries: 2, toolCalls: 0 })
  })
})

describe('messageSearchTerm and anchors', () => {
  it('needs two characters, trims and caps', () => {
    expect(messageSearchTerm(' a ')).toBeNull()
    expect(messageSearchTerm('  ab   cd ')).toBe('ab cd')
    expect(messageSearchTerm('x'.repeat(300))).toHaveLength(200)
  })
  it('parses #msg-<id> only', () => {
    expect(anchoredMessageId('#msg-42')).toBe(42)
    expect(anchoredMessageId('#msg-4x')).toBeNull()
    expect(anchoredMessageId('')).toBeNull()
    expect(anchoredMessageId(undefined)).toBeNull()
  })
})
