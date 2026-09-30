import { describe, it, expect } from 'vitest'
import { TaskProgressGuard, stableArgsSignature } from './task-progress-guard.js'
import { DEFAULT_HEURISTICS } from './heuristics.js'

describe('stableArgsSignature', () => {
  it('is key-order independent', () => {
    expect(stableArgsSignature({ a: 1, b: { c: 2, d: 3 } }))
      .toBe(stableArgsSignature({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('separates different values', () => {
    expect(stableArgsSignature({ command: 'ls' })).not.toBe(stableArgsSignature({ command: 'ls -la' }))
  })

  it('survives unserializable args instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => stableArgsSignature(circular)).not.toThrow()
  })
})

describe('TaskProgressGuard', () => {
  const limits = { maxToolCalls: 10, repeatedToolCalls: 3, maxInputTokens: 1000 }

  it('does not trip on normal work', () => {
    const guard = new TaskProgressGuard(limits)
    for (let i = 0; i < 9; i++) {
      expect(guard.recordToolCall('shell', { command: `echo ${i}` })).toBeNull()
      expect(guard.recordUsage(100)).toBeNull()
    }
    expect(guard.getState().toolCalls).toBe(9)
  })

  it('trips the hard tool-call cap', () => {
    const guard = new TaskProgressGuard({ ...limits, repeatedToolCalls: 0, maxInputTokens: 0 })
    let trip = null
    for (let i = 0; i < 10; i++) trip = guard.recordToolCall('shell', { command: `echo ${i}` })
    expect(trip?.kind).toBe('tool_call_cap')
    expect(trip?.message).toContain('tool call cap of 10 calls')
    expect(trip?.details.limit).toBe(10)
  })

  it('trips on identical consecutive tool calls', () => {
    const guard = new TaskProgressGuard(limits)
    expect(guard.recordToolCall('read_file', { path: '/a' })).toBeNull()
    expect(guard.recordToolCall('read_file', { path: '/a' })).toBeNull()
    const trip = guard.recordToolCall('read_file', { path: '/a' })
    expect(trip?.kind).toBe('repeated_tool_calls')
    expect(trip?.message).toContain('read_file')
    expect(trip?.details.repeats).toBe(3)
  })

  it('does not count a different tool or different arguments as a repeat', () => {
    const guard = new TaskProgressGuard(limits)
    expect(guard.recordToolCall('read_file', { path: '/a' })).toBeNull()
    expect(guard.recordToolCall('read_file', { path: '/b' })).toBeNull()
    expect(guard.recordToolCall('read_file', { path: '/a' })).toBeNull()
    expect(guard.recordToolCall('shell', { path: '/a' })).toBeNull()
    expect(guard.getState().repeatRun).toBe(1)
  })

  it('trips the input token budget', () => {
    const guard = new TaskProgressGuard(limits)
    expect(guard.recordUsage(600)).toBeNull()
    const trip = guard.recordUsage(500)
    expect(trip?.kind).toBe('token_budget')
    expect(trip?.details.inputTokens).toBe(1100)
    expect(trip?.message).toContain('input tokens')
  })

  it('ignores negative or non-finite usage', () => {
    const guard = new TaskProgressGuard(limits)
    expect(guard.recordUsage(-5)).toBeNull()
    expect(guard.recordUsage(Number.NaN)).toBeNull()
    expect(guard.getState().inputTokens).toBe(0)
  })

  it('treats 0 / negative limits as disabled (fail-open)', () => {
    const guard = new TaskProgressGuard({ maxToolCalls: 0, repeatedToolCalls: -1, maxInputTokens: 0 })
    for (let i = 0; i < 500; i++) {
      expect(guard.recordToolCall('shell', { command: 'ls' })).toBeNull()
      expect(guard.recordUsage(1_000_000)).toBeNull()
    }
  })

  it('reports each trip only once, so a late event cannot re-fire it', () => {
    const guard = new TaskProgressGuard({ maxToolCalls: 1, repeatedToolCalls: 0, maxInputTokens: 0 })
    expect(guard.recordToolCall('shell', {})?.kind).toBe('tool_call_cap')
    expect(guard.recordToolCall('shell', {})).toBeNull()
  })

  it('seeds an already-spent budget without tripping immediately', () => {
    const guard = new TaskProgressGuard(limits, { toolCalls: 9, inputTokens: 999 })
    expect(guard.getState().toolCalls).toBe(9)
    expect(guard.recordToolCall('shell', {})?.kind).toBe('tool_call_cap')
  })

  it('ships conservative defaults in heuristics', () => {
    expect(DEFAULT_HEURISTICS.taskGuard.maxToolCalls).toBe(300)
    expect(DEFAULT_HEURISTICS.taskGuard.repeatedToolCalls).toBe(5)
    expect(DEFAULT_HEURISTICS.taskGuard.maxInputTokens).toBe(30_000_000)
  })
})
