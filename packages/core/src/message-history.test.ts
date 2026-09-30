import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { sanitizeHistoryBoundaries, describeHistoryStructure } from './message-history.js'

// --- Message builders (minimal, shaped like pi-ai's Message union) ---

function user(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as unknown as AgentMessage
}

function assistant(
  blocks: Array<{ type: 'text'; text: string } | { type: 'toolCall'; id: string; name?: string }>,
  stopReason: string = 'toolUse',
): AgentMessage {
  return {
    role: 'assistant',
    content: blocks.map(b =>
      b.type === 'toolCall'
        ? { type: 'toolCall', id: b.id, name: b.name ?? 'shell', arguments: {} }
        : { type: 'text', text: b.text },
    ),
    api: 'anthropic',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 1,
  } as unknown as AgentMessage
}

function toolResult(id: string, text = 'ok'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'shell',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1,
  } as unknown as AgentMessage
}

const roles = (msgs: AgentMessage[]) => msgs.map(m => (m as { role: string }).role)

describe('sanitizeHistoryBoundaries', () => {
  it('drops a leading orphan tool_result (the messages[0] incident)', () => {
    // toolResult whose tool_use lived in a prior, already-dropped assistant turn.
    const history: AgentMessage[] = [
      toolResult('toolu_orphan'),
      assistant([{ type: 'text', text: 'continuing' }], 'stop'),
      user('next question'),
    ]
    const { messages, dropped, drops } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    expect(roles(messages)).toEqual(['assistant', 'user'])
    expect(drops[0]).toContain('no preceding tool_use')
    // no orphan remains
    expect(messages.some(m => (m as { role: string }).role === 'toolResult')).toBe(false)
  })

  it('drops a trailing dangling tool_use (assistant tool call with no result)', () => {
    const history: AgentMessage[] = [
      user('do a thing'),
      assistant([{ type: 'text', text: 'working' }, { type: 'toolCall', id: 'toolu_1' }], 'toolUse'),
      // no toolResult follows
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    // assistant keeps its text block; only the dangling toolCall block is stripped
    expect(roles(messages)).toEqual(['user', 'assistant'])
    const a = messages[1] as { content: Array<{ type: string }> }
    expect(a.content.map(b => b.type)).toEqual(['text'])
  })

  it('multi-block message: only the orphan block is removed, valid blocks stay', () => {
    // Assistant has one resolved call and one dangling call in the same message.
    const history: AgentMessage[] = [
      user('two tools'),
      assistant([
        { type: 'text', text: 'running both' },
        { type: 'toolCall', id: 'toolu_ok' },
        { type: 'toolCall', id: 'toolu_dangling' },
      ], 'toolUse'),
      toolResult('toolu_ok'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    const a = messages[1] as { content: Array<{ type: string; id?: string }> }
    // text + resolved toolCall survive; dangling toolCall gone
    expect(a.content.map(b => b.type)).toEqual(['text', 'toolCall'])
    expect(a.content.find(b => b.type === 'toolCall')?.id).toBe('toolu_ok')
    // the resolved toolResult survives
    expect(messages.some(m => (m as { role: string; toolCallId?: string }).toolCallId === 'toolu_ok')).toBe(true)
  })

  it('drops the whole assistant message when it becomes empty (only dangling tool_use)', () => {
    const history: AgentMessage[] = [
      user('go'),
      assistant([{ type: 'toolCall', id: 'toolu_only' }], 'aborted'),
      // no result — the assistant message has nothing left after stripping
    ]
    const { messages, dropped, drops } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    expect(roles(messages)).toEqual(['user'])
    expect(drops[0]).toContain('dropped')
  })

  it('keeps a valid tool_use/tool_result pair atomic (both present → both kept)', () => {
    const history: AgentMessage[] = [
      user('run'),
      assistant([{ type: 'text', text: 'ok' }, { type: 'toolCall', id: 'toolu_1' }], 'toolUse'),
      toolResult('toolu_1'),
      assistant([{ type: 'text', text: 'done' }], 'stop'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(false)
    expect(messages).toEqual(history)
  })

  it('OpenAI/Kimi dialect (toolCallId join key) is covered by the same pass', () => {
    // Same shape in this SDK; the join key is toolCallId. A leading orphan with
    // an OpenAI-style id must also be dropped.
    const history: AgentMessage[] = [
      toolResult('call_abc123'),
      user('hi'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    expect(roles(messages)).toEqual(['user'])
  })

  it('handles a batch of parallel tool results correctly', () => {
    const history: AgentMessage[] = [
      user('parallel'),
      assistant([
        { type: 'toolCall', id: 'toolu_a' },
        { type: 'toolCall', id: 'toolu_b' },
      ], 'toolUse'),
      toolResult('toolu_a'),
      toolResult('toolu_b'),
      assistant([{ type: 'text', text: 'both done' }], 'stop'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(false)
    expect(messages).toEqual(history)
  })

  it('drops only the orphan when a batch is partially resolved', () => {
    const history: AgentMessage[] = [
      user('parallel'),
      assistant([
        { type: 'toolCall', id: 'toolu_a' },
        { type: 'toolCall', id: 'toolu_b' },
      ], 'toolUse'),
      toolResult('toolu_a'),
      // toolu_b never resolved
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(true)
    const a = messages[1] as { content: Array<{ id?: string }> }
    expect(a.content.map(b => b.id)).toEqual(['toolu_a'])
    expect(messages.some(m => (m as { toolCallId?: string }).toolCallId === 'toolu_a')).toBe(true)
  })

  // --- Negative tests: valid histories must never be touched ---

  it('leaves a plain conversation (no tools) unchanged', () => {
    const history: AgentMessage[] = [
      user('hello'),
      assistant([{ type: 'text', text: 'hi there' }], 'stop'),
      user('how are you'),
      assistant([{ type: 'text', text: 'good' }], 'stop'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(false)
    expect(messages).toEqual(history)
  })

  it('leaves an empty history unchanged', () => {
    const { messages, dropped } = sanitizeHistoryBoundaries([])
    expect(dropped).toBe(false)
    expect(messages).toEqual([])
  })

  it('leaves multiple valid tool rounds unchanged', () => {
    const history: AgentMessage[] = [
      user('multi'),
      assistant([{ type: 'toolCall', id: 't1' }], 'toolUse'),
      toolResult('t1'),
      assistant([{ type: 'toolCall', id: 't2' }], 'toolUse'),
      toolResult('t2'),
      assistant([{ type: 'text', text: 'finished' }], 'stop'),
    ]
    const { messages, dropped } = sanitizeHistoryBoundaries(history)
    expect(dropped).toBe(false)
    expect(messages).toEqual(history)
  })
})

describe('describeHistoryStructure', () => {
  it('renders roles, block types and tool ids without any content text', () => {
    const history: AgentMessage[] = [
      user('secret password is hunter2'),
      assistant([{ type: 'text', text: 'also secret' }, { type: 'toolCall', id: 'toolu_9' }], 'toolUse'),
      toolResult('toolu_9', 'sensitive output'),
    ]
    const s = describeHistoryStructure(history)
    expect(s).toBe('user | assistant[text,toolCall:toolu_9](toolUse) | toolResult:toolu_9')
    // never leaks content
    expect(s).not.toContain('hunter2')
    expect(s).not.toContain('secret')
    expect(s).not.toContain('sensitive')
  })
})
