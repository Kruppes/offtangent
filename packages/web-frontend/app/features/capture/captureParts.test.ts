import { describe, expect, it } from 'vitest'
import type { CaptureListPage, CapturePart, CaptureResult } from '~/api/captures'
import { daysSince, isSplit, partLabel, partState, partsOf, trayItems } from './captureParts'

const capture = (id: string, createdAt = '2026-01-01T10:00:00Z') => ({ id, text: 'Synthetic note one. Synthetic note two.', kind: 'note', source: 'web', agentId: null, strandId: null, messageId: null, status: 'unsorted', createdAt, filedAt: null, attachments: [], clientMessageId: null }) as unknown as CaptureResult['capture']
const decision = (captureId: string, extra: Record<string, unknown> = {}) => ({ id: `d-${captureId}`, captureId, action: 'append', strandId: 's1', state: 'proposed', partIndex: 0, partCount: 1, createdAt: '2026-01-01T10:00:01Z', alternatives: [], ...extra }) as unknown as CaptureResult['decision']
const part = (index: number, state = 'proposed', title: string | null = null): CapturePart => ({ index, title, text: `Part text ${index}`, sentenceIds: [index + 1], decision: decision('c1', { id: `d${index}`, partIndex: index, state }) })

describe('partsOf / isSplit', () => {
  it('treats a result without parts as one part built from the decision', () => {
    const result = { capture: capture('c1'), decision: decision('c1') }
    expect(partsOf(result)).toEqual([{ index: 0, title: null, text: result.capture.text, sentenceIds: [], decision: result.decision }])
    expect(isSplit(result)).toBe(false)
  })
  it('sorts parts by index and reports a split', () => {
    const result = { capture: capture('c1'), decision: decision('c1'), parts: [part(1), part(0)] }
    expect(partsOf(result).map(p => p.index)).toEqual([0, 1])
    expect(isSplit(result)).toBe(true)
  })
})

describe('partState', () => {
  it.each([['applied', 'placed'], ['confirmed', 'placed'], ['undone', 'undone'], ['superseded', 'undone'], ['proposed', 'open']])('%s -> %s', (state, expected) => {
    expect(partState(part(0, state))).toBe(expected)
  })
})

describe('partLabel', () => {
  it('prefers the title and shortens long text', () => {
    expect(partLabel(part(0, 'proposed', 'Garden'))).toBe('Garden')
    const long = { ...part(0), text: 'word '.repeat(30) }
    expect(partLabel(long, 20)).toHaveLength(20)
    expect(partLabel(long, 20).endsWith('…')).toBe(true)
  })
})

describe('trayItems', () => {
  it('merges status pages newest first, once per capture, with parts', () => {
    const pages: CaptureListPage[] = [
      { captures: [capture('a', '2026-01-01T09:00:00Z')], decisions: [decision('a')], parts: { a: [part(0), part(1)] } },
      { captures: [capture('b', '2026-01-02T09:00:00Z'), capture('a', '2026-01-01T09:00:00Z')], decisions: [decision('b'), decision('a')] },
      { captures: [capture('c')], decisions: [] },
    ]
    const items = trayItems(pages)
    expect(items.map(i => i.capture.id)).toEqual(['b', 'a'])
    expect(items[1]!.partCount).toBe(2)
    expect(items[0]!.parts).toBeUndefined()
  })
})

describe('daysSince', () => {
  it('counts whole days and guards broken input', () => {
    const now = Date.parse('2026-01-13T12:00:00Z')
    expect(daysSince('2026-01-01T13:00:00Z', now)).toBe(11)
    expect(daysSince('2026-01-14T00:00:00Z', now)).toBe(0)
    expect(daysSince('nope', now)).toBeNull()
  })
})
