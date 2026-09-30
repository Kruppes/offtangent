import { describe, expect, it } from 'vitest'
import { isStaleSending, SENDING_STALE_MS } from './sendLogFormat'

/**
 * Review finding M4: a row stuck at `sending` must be visible as such. The
 * status is written before the SMTP handover, so an old one means the process
 * died mid-send and nobody knows whether the mail went out.
 */
describe('isStaleSending', () => {
  const now = Date.parse('2026-09-26T12:00:00Z')

  function stamp(msAgo: number): string {
    // Backend timestamps arrive as naked UTC ("YYYY-MM-DD HH:MM:SS").
    return new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19)
  }

  it('warns about a sending entry older than 15 minutes', () => {
    expect(isStaleSending({ status: 'sending', updatedAt: stamp(SENDING_STALE_MS + 60_000) }, now)).toBe(true)
  })

  it('stays quiet for a fresh send in progress', () => {
    expect(isStaleSending({ status: 'sending', updatedAt: stamp(30_000) }, now)).toBe(false)
  })

  it('falls back to createdAt when the entry was never updated', () => {
    expect(isStaleSending({ status: 'sending', createdAt: stamp(60 * 60 * 1000) }, now)).toBe(true)
  })

  it('ignores every other status', () => {
    expect(isStaleSending({ status: 'failed', updatedAt: stamp(60 * 60 * 1000) }, now)).toBe(false)
    expect(isStaleSending({ status: 'sent', updatedAt: stamp(60 * 60 * 1000) }, now)).toBe(false)
    expect(isStaleSending({ status: 'pending', updatedAt: stamp(60 * 60 * 1000) }, now)).toBe(false)
  })
})
