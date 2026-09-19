import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseInteractionBlockPayload } from '@axiom/core/contracts'
import { ApiError } from './useApi'
import { useInteractions } from './useInteractions'

const block = parseInteractionBlockPayload({ block: 'confirm', id: 'confirm-1', question: 'Proceed?' })!
afterEach(() => vi.unstubAllGlobals())

function setup(result: unknown, error = false) {
  const apiFetch = error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result)
  vi.stubGlobal('useApi', () => ({ apiFetch }))
  return { apiFetch, ...useInteractions() }
}

describe('interaction answer contract', () => {
  it('sends the real message/block IDs, value and stable client ID', async () => {
    const api = setup({ label: 'Yes', resumed: true, applied: true, idempotent: true })
    expect(await api.answerBlock({ messageId: 42, block, value: 'yes', clientMessageId: 'same-tap' })).toEqual({ status: 'applied', label: 'Yes', resumed: true })
    expect(JSON.parse(api.apiFetch.mock.calls[0]![1].body)).toEqual({ messageId: 42, blockId: 'confirm-1', value: 'yes', clientMessageId: 'same-tap' })
  })
  it('uses the persisted answer on an already answered conflict', async () => {
    const api = setup(new ApiError('Already answered', 409, { code: 'already_answered', label: 'No' }), true)
    expect(await api.answerBlock({ messageId: 42, block, value: 'yes', clientMessageId: 'tap' })).toEqual({ status: 'already_answered', label: 'No' })
  })
  it('distinguishes stale from unrelated conflicts', async () => {
    let api = setup(new ApiError('Expired', 410, { code: 'stale' }), true)
    const input = { messageId: 42, block, value: 'yes', clientMessageId: 'tap' }
    expect(await api.answerBlock(input)).toEqual({ status: 'stale', reason: 'Expired' })
    api = setup(new ApiError('Conflict', 409, { code: 'other' }), true)
    expect(await api.answerBlock(input)).toEqual({ status: 'error', message: 'Conflict' })
  })
  it('only renders actual supported web kinds, not invented types', () => {
    const api = setup({})
    for (const kind of ['multi', 'handover', 'schedule']) {
      const segments = api.segmentsOf('```offtangent\n' + JSON.stringify({ block: kind, id: 'b', question: 'Pick', options: [{ id: 'a', label: 'Alpha' }] }) + '\n```')
      expect(segments.every(s => s.type === 'text')).toBe(true)
      expect(JSON.stringify(segments)).toContain('1. Alpha')
    }
  })
})
