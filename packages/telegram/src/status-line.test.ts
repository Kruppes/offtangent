import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStatusLine, formatStatusText, type StatusLineApi } from './status-line.js'

function fakeApi() {
  const calls: Array<{ op: string; text?: string; at: number }> = []
  const api = {
    sendMessage: vi.fn(async (_chatId: string | number, text: string) => {
      calls.push({ op: 'send', text, at: Date.now() })
      return { message_id: 42 }
    }),
    editMessageText: vi.fn(async (_chatId: string | number, _id: number, text: string) => {
      calls.push({ op: 'edit', text, at: Date.now() })
      return true
    }),
    deleteMessage: vi.fn(async () => {
      calls.push({ op: 'delete', at: Date.now() })
      return true
    }),
  } satisfies StatusLineApi
  return { api, calls }
}

describe('S1-D TurnStatusLine (Telegram status line)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with "⏳ Arbeitet… 0 s" and refreshes the elapsed time at least every 5 s', async () => {
    const { api, calls } = fakeApi()
    const line = new TurnStatusLine({ api, chatId: 1 })
    line.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls[0]).toMatchObject({ op: 'send', text: '⏳ Arbeitet… 0 s' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.filter(c => c.op === 'edit').map(c => c.text)).toEqual(['⏳ Arbeitet… 5 s'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls.filter(c => c.op === 'edit').map(c => c.text)).toEqual(['⏳ Arbeitet… 5 s', '⏳ Arbeitet… 10 s'])
    await line.finish()
  })

  it('edits are throttled to one per 3 s, and the latest state is always drawn by a trailing edit', async () => {
    const { api, calls } = fakeApi()
    const known = new Set(['web_search', 'read_file', 'shell'])
    const line = new TurnStatusLine({ api, chatId: 1, knownTools: () => known })
    line.start()
    await vi.advanceTimersByTimeAsync(0)
    // A burst of tool starts inside one window.
    line.toolStarted('web_search')
    await vi.advanceTimersByTimeAsync(500)
    line.toolStarted('read_file')
    await vi.advanceTimersByTimeAsync(500)
    line.toolStarted('shell')
    await vi.advanceTimersByTimeAsync(2500)
    const edits = calls.filter(c => c.op === 'edit')
    // Only one edit, at the end of the 3 s window, showing the LAST tool.
    expect(edits).toHaveLength(1)
    expect(edits[0]!.text).toContain('shell')
    // Over a longer run no two edits are closer than 3 s.
    for (let i = 0; i < 6; i++) {
      line.toolStarted(i % 2 ? 'web_search' : 'read_file')
      await vi.advanceTimersByTimeAsync(700)
    }
    await vi.advanceTimersByTimeAsync(4000)
    const all = calls.filter(c => c.op === 'edit' || c.op === 'send')
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.at - all[i - 1]!.at).toBeGreaterThanOrEqual(3000)
    }
    // Last state caught up: the last tool started was web_search (i = 5).
    expect(calls.filter(c => c.op === 'edit').at(-1)!.text).toContain('web_search')
    await line.finish()
  })

  it('shows the tool name only, never arguments; unregistered or token-like names become other_tool', async () => {
    const { api, calls } = fakeApi()
    const known = new Set(['shell'])
    const line = new TurnStatusLine({ api, chatId: 1, knownTools: () => known })
    line.start()
    await vi.advanceTimersByTimeAsync(0)
    line.toolStarted('shell')
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.at(-1)!.text).toBe('⏳ Arbeitet… 3 s · 🔧 shell')
    line.toolStarted('shell {"command":"cat /data/secret"}')
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.at(-1)!.text).toBe('⏳ Arbeitet… 6 s · 🔧 other_tool')
    line.toolStarted('evil_tool')
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.at(-1)!.text).toBe('⏳ Arbeitet… 9 s · 🔧 other_tool')
    line.toolStarted(['sk', 'live_abcdef1234567890'].join('_') /* token-shaped name, built at runtime so the secret scanner does not flag the fixture */)
    await vi.advanceTimersByTimeAsync(3000)
    expect(calls.every(c => !String(c.text ?? '').includes('secret') && !String(c.text ?? '').includes('abcdef1234567890'))).toBe(true)
    await line.finish()
  })

  it('deletes the line at turn end by default and stops editing', async () => {
    const { api, calls } = fakeApi()
    const line = new TurnStatusLine({ api, chatId: 1 })
    line.start()
    await vi.advanceTimersByTimeAsync(4000)
    await line.finish()
    expect(api.deleteMessage).toHaveBeenCalledWith(1, 42)
    const before = calls.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls.length).toBe(before)
  })

  it('onEnd "done" sets the line to "✅ fertig nach N s" instead of deleting', async () => {
    const { api } = fakeApi()
    const line = new TurnStatusLine({ api, chatId: 1, onEnd: 'done' })
    line.start()
    await vi.advanceTimersByTimeAsync(12_000)
    // Last edit at 10 s: the final edit waits for the 3 s window (finding 4).
    const finished = line.finish()
    await vi.advanceTimersByTimeAsync(1000)
    await finished
    expect(api.deleteMessage).not.toHaveBeenCalled()
    expect(api.editMessageText).toHaveBeenLastCalledWith(1, 42, '✅ fertig nach 12 s')
  })

  it('REVIEW-S1-D finding 4: no two edits less than 3 s apart, the "done" edit included', async () => {
    const { api, calls } = fakeApi()
    const known = new Set(['shell'])
    const line = new TurnStatusLine({ api, chatId: 1, onEnd: 'done', knownTools: () => known })
    line.start()
    await vi.advanceTimersByTimeAsync(0)
    line.toolStarted('shell')
    await vi.advanceTimersByTimeAsync(3000)
    // An edit just happened at 3 s; the turn ends 200 ms later.
    await vi.advanceTimersByTimeAsync(200)
    const finished = line.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    await finished
    const edits = calls.filter(c => c.op === 'edit')
    expect(edits.at(-1)?.text).toMatch(/^✅ fertig nach/)
    expect(edits.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < edits.length; i++) {
      expect(edits[i]!.at - edits[i - 1]!.at).toBeGreaterThanOrEqual(3000)
    }
  })

  it('a failed editMessageText (message deleted by the user) is swallowed; no further edits, finish does not throw', async () => {
    const { api } = fakeApi()
    api.editMessageText.mockRejectedValue(new Error('Bad Request: message to edit not found'))
    api.deleteMessage.mockRejectedValue(new Error('Bad Request: message to delete not found'))
    const line = new TurnStatusLine({ api, chatId: 1 })
    line.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(api.editMessageText).toHaveBeenCalledTimes(1)
    await expect(line.finish()).resolves.toBeUndefined()
  })

  it('a failed initial send leaves no line and never throws', async () => {
    const { api } = fakeApi()
    api.sendMessage.mockRejectedValue(new Error('Too Many Requests'))
    const line = new TurnStatusLine({ api, chatId: 1 })
    line.start()
    line.toolStarted('shell')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.editMessageText).not.toHaveBeenCalled()
    await expect(line.finish()).resolves.toBeUndefined()
    expect(api.deleteMessage).not.toHaveBeenCalled()
  })

  it('formatStatusText', () => {
    expect(formatStatusText(0, null)).toBe('⏳ Arbeitet… 0 s')
    expect(formatStatusText(7400, 'web_search')).toBe('⏳ Arbeitet… 7 s · 🔧 web_search')
  })
})
