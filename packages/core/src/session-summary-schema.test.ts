import { describe, expect, it } from 'vitest'
import {
  parseSummaryDelta,
  mergeSummaryDelta,
  renderSummaryMarkdown,
  emptySummary,
  isEmptySummary,
  buildSummaryDeltaSystemPrompt,
  EMPTY_SUMMARY_TEXT,
} from './session-summary-schema.js'

describe('parseSummaryDelta', () => {
  it('parses a bare JSON delta', () => {
    const r = parseSummaryDelta('{"goal":"Ship the PR","add":{"decisions":["Opened PR #15"],"open":["Review pending"]}}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.delta.goal).toBe('Ship the PR')
      expect(r.delta.add?.decisions).toEqual(['Opened PR #15'])
      expect(r.delta.add?.open).toEqual(['Review pending'])
    }
  })

  it('accepts a fenced JSON block and drops non string entries', () => {
    const r = parseSummaryDelta('```json\n{"add":{"artifacts":["a.ts", 3, "  "],"next":[]}}\n```')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.delta.add?.artifacts).toEqual(['a.ts'])
  })

  it('rejects prose, invalid JSON, arrays and empty deltas', () => {
    expect(parseSummaryDelta('Discussed Docker.').ok).toBe(false)
    expect(parseSummaryDelta('{"goal": ').ok).toBe(false)
    expect(parseSummaryDelta('[1,2]').ok).toBe(false)
    expect(parseSummaryDelta('{"add":{"decisions":[]}}').ok).toBe(false)
  })

  it('accepts the empty marker', () => {
    const r = parseSummaryDelta('{"empty": true}')
    expect(r.ok && r.delta.empty).toBe(true)
  })
})

describe('mergeSummaryDelta', () => {
  it('appends without duplicates and keeps the previous goal when none is given', () => {
    const prev = { goal: 'G', decisions: ['A'], open: ['X'], artifacts: [], next: ['n1'] }
    const merged = mergeSummaryDelta(prev, { add: { decisions: ['a', 'B'], open: ['x', 'Y'] } })
    expect(merged.goal).toBe('G')
    expect(merged.decisions).toEqual(['A', 'B'])
    expect(merged.open).toEqual(['X', 'Y'])
    expect(merged.next).toEqual(['n1'])
    expect(prev.decisions).toEqual(['A'])
  })

  it('resolves open items by loose match and replaces next steps', () => {
    const prev = { goal: 'G', decisions: [], open: ['PR #15 review pending', 'Deploy after merge'], artifacts: [], next: ['old'] }
    const merged = mergeSummaryDelta(prev, {
      resolve: { open: ['PR #15 review'] },
      add: { decisions: ['PR #15 merged'], next: ['deploy'] },
    })
    expect(merged.open).toEqual(['Deploy after merge'])
    expect(merged.decisions).toEqual(['PR #15 merged'])
    expect(merged.next).toEqual(['deploy'])
  })

  it('starts from an empty summary when there is no previous version', () => {
    const merged = mergeSummaryDelta(null, { goal: 'New' })
    expect(merged).toEqual({ ...emptySummary(), goal: 'New' })
    expect(isEmptySummary(emptySummary())).toBe(true)
  })
})

describe('renderSummaryMarkdown', () => {
  it('renders goal, decisions, artifacts, next and the Open Threads section', () => {
    const md = renderSummaryMarkdown({
      goal: 'Ship the PDF upload.',
      decisions: ['Started PR #15', 'Tests added'],
      open: ['Review pending'],
      artifacts: ['packages/core/upload.ts'],
      next: ['Merge after review'],
    })
    expect(md).toBe([
      'Ship the PDF upload.',
      '- Started PR #15',
      '- Tests added',
      'Artifacts: packages/core/upload.ts',
      'Next: Merge after review',
      '',
      '### Open Threads',
      '- Review pending',
    ].join('\n'))
  })

  it('omits the Open Threads section when nothing is open and falls back to Empty session', () => {
    expect(renderSummaryMarkdown({ goal: 'G', decisions: [], open: [], artifacts: [], next: [] })).toBe('G')
    expect(renderSummaryMarkdown(emptySummary())).toBe(EMPTY_SUMMARY_TEXT)
  })
})

describe('buildSummaryDeltaSystemPrompt', () => {
  it('demands JSON only and explains open items and digest lines', () => {
    const p = buildSummaryDeltaSystemPrompt()
    expect(p).toContain('exactly one JSON object')
    expect(p).toContain('unfinished tasks')
    expect(p).toContain('[msg:<id>]')
    expect(p).toContain('"empty": true')
  })
})
