import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { TranscriptCompactor, EARLIER_MESSAGES_OPEN, EARLIER_MESSAGES_CLOSE } from './transcript-compaction.js'

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as unknown as AgentMessage
}
function assistant(text: string, toolCallId?: string): AgentMessage {
  const content: unknown[] = [{ type: 'text', text }]
  if (toolCallId) content.push({ type: 'toolCall', id: toolCallId, name: 'shell', arguments: {} })
  return { role: 'assistant', content, timestamp: 1, stopReason: toolCallId ? 'toolUse' : 'stop' } as unknown as AgentMessage
}
function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'shell',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage
}

function roleOf(msg: AgentMessage): string {
  return (msg as { role: string }).role
}
function textOf(msg: AgentMessage): string {
  const content = (msg as { content: unknown }).content
  if (typeof content === 'string') return content
  return (content as Array<{ text?: string }>).map(b => b.text ?? '').join('')
}

/** A synthetic task transcript: one prompt, then N shell round trips. */
function buildTranscript(rounds: number, resultChars = 4000): AgentMessage[] {
  const msgs: AgentMessage[] = [user('Begin working on the task described in your system prompt.')]
  for (let i = 0; i < rounds; i++) {
    msgs.push(assistant(`step ${i}`, `tc${i}`))
    msgs.push(toolResult(`tc${i}`, `result ${i} ${'x'.repeat(resultChars)}`))
  }
  return msgs
}

describe('TranscriptCompactor', () => {
  it('returns short transcripts unchanged', () => {
    const c = new TranscriptCompactor({ windowTokens: 6000, targetTokens: 3000, indexLines: 60 })
    const msgs = buildTranscript(2)
    const view = c.compact(msgs)
    expect(view).toHaveLength(msgs.length)
    expect(c.stats().hiddenMessages).toBe(0)
    expect(c.stats().trims).toBe(0)
  })

  it('trims a long transcript and keeps the newest turns verbatim', () => {
    const c = new TranscriptCompactor({ windowTokens: 6000, targetTokens: 3000, indexLines: 60 })
    // 40 rounds x ~4000 chars = ~160.000 chars = ~40.000 estimated tokens.
    const msgs = buildTranscript(40)
    const view = c.compact(msgs)

    expect(view.length).toBeLessThan(msgs.length)
    expect(c.stats().trims).toBe(1)
    expect(c.stats().hiddenMessages).toBeGreaterThan(0)

    // First message is the digest, rendered as a user message.
    expect(roleOf(view[0])).toBe('user')
    expect(textOf(view[0])).toContain(EARLIER_MESSAGES_OPEN)
    expect(textOf(view[0])).toContain(EARLIER_MESSAGES_CLOSE)
    expect(textOf(view[0])).toContain('recall_message')

    // The tail is raw: the last messages of the transcript are passed through
    // as the very same objects, not summaries.
    expect(view[view.length - 1]).toBe(msgs[msgs.length - 1])
    expect(view[view.length - 2]).toBe(msgs[msgs.length - 2])
    expect(textOf(view[view.length - 1])).toContain('result 39')

    // And the window actually got small.
    const windowChars = view.slice(1).reduce((n, m) => n + textOf(m).length, 0)
    expect(windowChars).toBeLessThan(40 * 4000 * 0.5)
  })

  it('never opens the window on an orphan tool result', () => {
    const c = new TranscriptCompactor({ windowTokens: 4000, targetTokens: 2000, indexLines: 60 })
    const view = c.compact(buildTranscript(30))
    expect(roleOf(view[1])).not.toBe('toolResult')
  })

  it('holds the cut point between trims so the prompt prefix stays stable', () => {
    const c = new TranscriptCompactor({ windowTokens: 6000, targetTokens: 3000, indexLines: 60 })
    const msgs = buildTranscript(40)
    const first = c.compact(msgs)
    const hiddenAfterFirst = c.stats().hiddenMessages

    // Two more round trips arrive: no new trim, the digest and the whole
    // previous window are byte-identical, only the new messages are appended.
    msgs.push(assistant('step 40', 'tc40'), toolResult('tc40', 'result 40'))
    const second = c.compact(msgs)

    expect(c.stats().trims).toBe(1)
    expect(c.stats().hiddenMessages).toBe(hiddenAfterFirst)
    expect(second).toHaveLength(first.length + 2)
    expect(textOf(second[0])).toBe(textOf(first[0]))
    for (let i = 0; i < first.length; i++) {
      expect(textOf(second[i])).toBe(textOf(first[i]))
    }
  })

  it('trims again only after the window grew past the budget again', () => {
    const c = new TranscriptCompactor({ windowTokens: 6000, targetTokens: 3000, indexLines: 60 })
    const msgs = buildTranscript(40)
    c.compact(msgs)
    expect(c.stats().trims).toBe(1)

    // Small additions do not move the cut...
    for (let i = 0; i < 3; i++) {
      msgs.push(assistant(`small ${i}`, `s${i}`), toolResult(`s${i}`, 'ok'))
      c.compact(msgs)
    }
    expect(c.stats().trims).toBe(1)

    // ...a large burst does.
    for (let i = 0; i < 20; i++) {
      msgs.push(assistant(`big ${i}`, `b${i}`), toolResult(`b${i}`, 'y'.repeat(4000)))
    }
    c.compact(msgs)
    expect(c.stats().trims).toBe(2)
  })

  it('renders recallable ids for registered messages and marks the rest', () => {
    const c = new TranscriptCompactor({ windowTokens: 4000, targetTokens: 2000, indexLines: 200 })
    const msgs = buildTranscript(30)
    // Register ids the way the task runner does after persisting rows.
    c.noteToolResultId('tc0', 4711)
    c.noteMessageId(msgs[1] as unknown as object, 4710)

    const view = c.compact(msgs)
    const digest = textOf(view[0])
    expect(digest).toContain('[msg:4711] tool,')
    expect(digest).toContain('[msg:4710] assistant,')
    expect(digest).toContain('[no-id]')
  })

  it('caps the number of digest lines', () => {
    const c = new TranscriptCompactor({ windowTokens: 4000, targetTokens: 2000, indexLines: 5 })
    const view = c.compact(buildTranscript(40))
    const digest = textOf(view[0])
    const lines = digest.split('\n').filter(l => l.startsWith('[msg:') || l.startsWith('[no-id]'))
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(digest).toContain('oldest not listed')
  })

  it('starts over when the transcript was reset', () => {
    const c = new TranscriptCompactor({ windowTokens: 4000, targetTokens: 2000, indexLines: 60 })
    c.compact(buildTranscript(30))
    expect(c.stats().hiddenMessages).toBeGreaterThan(0)

    const fresh = buildTranscript(1)
    const view = c.compact(fresh)
    expect(c.stats().hiddenMessages).toBe(0)
    expect(view).toHaveLength(fresh.length)
  })
})

describe('TranscriptCompactor with a leading system message', () => {
  // pi-agent-core 0.87 folds the system prompt and the tool declarations into
  // messages[0] (role 'system'). Hiding it leaves the model without its task
  // and without tools: the observed failure was a thinking-only turn and an
  // empty "completed" right after the first trim (2026-09-24).
  const system = { role: 'system', content: 'Task prompt', timestamp: 0 } as unknown as AgentMessage

  it('never hides the system message and never lists it in the digest', () => {
    const c = new TranscriptCompactor({ windowTokens: 5000, targetTokens: 2500, indexLines: 60 })
    const msgs = [system, ...buildTranscript(12)]
    const view = c.compact(msgs)
    expect(c.stats().trims).toBe(1)
    expect(view[0]).toBe(system)
    expect(roleOf(view[1])).toBe('user')
    expect(textOf(view[1])).toContain(EARLIER_MESSAGES_OPEN)
    expect(textOf(view[1])).not.toContain('Task prompt')
    expect(view.filter(m => roleOf(m) === 'system')).toHaveLength(1)
  })

  it('keeps the system message pinned across later trims', () => {
    const c = new TranscriptCompactor({ windowTokens: 5000, targetTokens: 2500, indexLines: 60 })
    const msgs = [system, ...buildTranscript(12)]
    c.compact(msgs)
    for (let i = 12; i < 30; i++) {
      msgs.push(assistant(`step ${i}`, `tc${i}`), toolResult(`tc${i}`, `result ${i} ${'x'.repeat(4000)}`))
    }
    const view = c.compact(msgs)
    expect(c.stats().trims).toBe(2)
    expect(view[0]).toBe(system)
    expect(view.filter(m => roleOf(m) === 'system')).toHaveLength(1)
  })
})

describe('TranscriptCompactor message shape', () => {
  it('merges the digest into the window when it opens on a user message', () => {
    const c = new TranscriptCompactor({ windowTokens: 4000, targetTokens: 2000, indexLines: 60 })
    const msgs: AgentMessage[] = []
    for (let i = 0; i < 20; i++) {
      msgs.push(assistant(`step ${i}`, `tc${i}`), toolResult(`tc${i}`, 'x'.repeat(4000)))
    }
    // A follow-up question answered by the user lands late in the transcript.
    msgs.push(user('here is my answer'), assistant('thanks', 'tcz'), toolResult('tcz', 'ok'))

    const view = c.compact(msgs)
    expect(c.stats().hiddenMessages).toBeGreaterThan(0)
    // No two user messages in a row anywhere in the view.
    const roles = view.map(roleOf)
    for (let i = 1; i < roles.length; i++) {
      expect(roles[i] === 'user' && roles[i - 1] === 'user').toBe(false)
    }
    const firstUser = view.find(m => roleOf(m) === 'user')!
    expect(textOf(firstUser)).toContain(EARLIER_MESSAGES_OPEN)
    expect(textOf(firstUser)).toContain('here is my answer')
  })
})
