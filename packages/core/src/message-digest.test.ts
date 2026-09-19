import { describe, expect, it } from 'vitest'
import {
  formatMessageDigest,
  parseMessageDigestId,
  maskTranscript,
  stripRecalledLines,
  RECALLED_MARKER,
} from './message-digest.js'

describe('formatMessageDigest', () => {
  it('renders id, role, length and the first sentence', () => {
    const line = formatMessageDigest({ id: 42, role: 'assistant', content: 'First sentence here. Second one follows.' })
    expect(line).toBe('[msg:42] assistant, 40 chars: First sentence here.')
    expect(parseMessageDigestId(line)).toBe(42)
  })

  it('caps a sentence that never ends', () => {
    const line = formatMessageDigest({ id: 1, role: 'tool', content: 'x'.repeat(500) })
    expect(line.length).toBeLessThan(200)
    expect(line.startsWith('[msg:1] tool, 500 chars: ')).toBe(true)
  })

  it('parseMessageDigestId returns null for a normal line', () => {
    expect(parseMessageDigestId('User: hello')).toBeNull()
  })
})

describe('maskTranscript', () => {
  it('keeps everything verbatim when it fits', () => {
    const r = maskTranscript([
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: 'hello' },
    ], { totalChars: 1000, perMessageChars: 100 })
    expect(r.text).toBe('User: hi\nAssistant: hello')
    expect(r.masked).toEqual([])
    expect(r.verbatim).toEqual([1, 2])
  })

  it('turns an oversized assistant message into a digest with its id', () => {
    const long = 'A long answer. ' + 'y'.repeat(3000)
    const r = maskTranscript([
      { id: 7, role: 'user', content: 'question' },
      { id: 8, role: 'assistant', content: long },
    ], { totalChars: 100000, perMessageChars: 2000 })
    expect(r.masked).toEqual([8])
    expect(r.text).toContain('[msg:8] assistant, 3015 chars: A long answer.')
    expect(r.text).not.toContain('yyyy')
  })

  it('always digests tool results and uses the given label for verbatim rows', () => {
    const r = maskTranscript([
      { id: 1, role: 'tool', content: 'shell: ok' },
      { id: 2, role: 'task', content: 'done', label: 'Background task (completed: X)' },
    ], { totalChars: 100000, perMessageChars: 2000 })
    expect(r.text).toContain('[msg:1] tool, 9 chars: shell: ok')
    expect(r.text).toContain('Background task (completed: X): done')
  })

  it('applies the total budget oldest first so the newest turns stay verbatim', () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i + 1}. ` + 'z'.repeat(400),
    }))
    const r = maskTranscript(msgs, { totalChars: 1200, perMessageChars: 2000 })
    expect(r.verbatim).toEqual([5, 6])
    expect(r.masked).toEqual([1, 2, 3, 4])
    expect(r.text.length).toBeLessThanOrEqual(1300)
    expect(r.text).toContain('User: Message 5.')
    expect(r.text).toContain('[msg:1] user, 411 chars: Message 1.')
  })
})

describe('stripRecalledLines', () => {
  it('removes lines marked as recalled and keeps the rest', () => {
    const text = ['User: remember X', `${RECALLED_MARKER} message 3 (assistant)`, 'Assistant: ok'].join('\n')
    expect(stripRecalledLines(text)).toBe('User: remember X\nAssistant: ok')
  })
})
