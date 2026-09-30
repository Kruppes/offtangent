import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { isCorruptedContextError, isAgentBusyError } from './agent-runtime.js'
import { sanitizeHistoryBoundaries } from './message-history.js'

describe('isCorruptedContextError', () => {
  it('matches the Anthropic dangling-tool_use phrasing', () => {
    const msg = '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01N2. Each `tool_result` block must have a corresponding `tool_use` block in the previous message."}}'
    expect(isCorruptedContextError(msg)).toBe(true)
    expect(isCorruptedContextError(new Error(msg))).toBe(true)
  })

  it('matches the OpenAI/Kimi tool_call_id phrasing', () => {
    expect(isCorruptedContextError('400: {"message":"Invalid request: tool_call_id  is not found","type":"invalid_request_error"}')).toBe(true)
  })

  it('matches a generic tool_result/tool_use mismatch', () => {
    expect(isCorruptedContextError('tool_result without matching tool_use')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isCorruptedContextError('429 rate limit exceeded')).toBe(false)
    expect(isCorruptedContextError('invalid temperature: only 1 is allowed for this model')).toBe(false)
    expect(isCorruptedContextError('This request triggered restrictions on violative cyber content')).toBe(false)
    expect(isCorruptedContextError('')).toBe(false)
    expect(isCorruptedContextError(undefined)).toBe(false)
    expect(isCorruptedContextError(null)).toBe(false)
  })
})

describe('corrupted context — boundary invariant closes the loop', () => {
  // The 400 that isCorruptedContextError matches is exactly the history state
  // that sanitizeHistoryBoundaries prevents. These two guards are the reactive
  // (detect + heal) and proactive (never emit) halves of the same fix.
  const orphanTr = (id: string): AgentMessage =>
    ({ role: 'toolResult', toolCallId: id, toolName: 'shell', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 } as unknown as AgentMessage)
  const userMsg = (t: string): AgentMessage =>
    ({ role: 'user', content: [{ type: 'text', text: t }], timestamp: 1 } as unknown as AgentMessage)

  it('the history that produces the Anthropic 400 is sanitized away proactively', () => {
    // messages.0 is an orphan tool_result — the precise wedge from the incident.
    const wedged: AgentMessage[] = [orphanTr('toolu_01N2'), userMsg('resend please')]
    const { messages, dropped } = sanitizeHistoryBoundaries(wedged)
    expect(dropped).toBe(true)
    expect((messages[0] as { role: string }).role).toBe('user')
    // And the raw provider error for that state is still detected reactively.
    expect(isCorruptedContextError('messages.0.content.0: unexpected `tool_use_id` found in `tool_result` blocks: toolu_01N2')).toBe(true)
  })
})

describe('isAgentBusyError', () => {
  it('matches the pi-agent "already processing" rejection', () => {
    expect(isAgentBusyError(new Error('Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.'))).toBe(true)
    expect(isAgentBusyError('Agent is already processing.')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isAgentBusyError('429 rate limit')).toBe(false)
    expect(isAgentBusyError('tool_use_id not found')).toBe(false)
    expect(isAgentBusyError(undefined)).toBe(false)
  })
})
