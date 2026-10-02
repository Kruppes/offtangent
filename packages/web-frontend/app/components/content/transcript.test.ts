import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../composables/useChat'
import { elapsedToolSeconds, formatTurnDuration, groupTranscript, isTurnStep, summarizeTurn, toolState, transcriptState } from './transcript'
const tool = (id: string): ChatMessage => ({ role: 'tool', content: '', toolData: { toolName: 'shell', toolCallId: id } })
describe('transcript presentation', () => {
  it.each([[true, true, 1, 'error'], [false, true, 1, 'loading'], [false, false, 0, 'empty'], [false, false, 1, 'ready']] as const)('covers state %s/%s/%s', (error, loading, count, expected) => {
    expect(transcriptState(error, loading, count)).toBe(expected)
  })
  it('folds every step of a turn into one row without mutating messages or losing identity', () => {
    const a = tool('a'), b = tool('b'), c = tool('c')
    const thought: ChatMessage = { role: 'assistant', content: 'Reasoning', isThinking: true }
    const interim: ChatMessage = { role: 'assistant', content: 'Interim note' }
    const answer: ChatMessage = { role: 'assistant', content: 'Answer', timestamp: '2026-01-01T00:00:40Z' }
    const input = [thought, a, b, interim, c, answer]
    const rows = groupTranscript(input)
    expect(rows.map(r => r.steps?.length ?? 0)).toEqual([4, 0, 0])
    expect(rows[0]!.steps).toEqual([thought, a, b, c])
    expect(rows[1]!.message).toBe(interim)
    expect(rows[1]!.index).toBe(3)
    expect(rows[2]!.message).toBe(answer)
    expect(rows[2]!.index).toBe(5)
    expect(rows[0]!.turnEnd).toBe('2026-01-01T00:00:40Z')
    expect(input).toEqual([thought, a, b, interim, c, answer])
    expect(a).not.toHaveProperty('steps')
  })
  it.each(['user', 'divider'] as const)('starts a new turn line after a %s message', role => {
    expect(groupTranscript([tool('a'), { role, content: '' }, tool('b')]).map(r => r.steps?.length ?? 0)).toEqual([1, 0, 1])
  })
  it.each(['system', 'assistant'] as const)('keeps one turn line across a %s message inside the turn', role => {
    expect(groupTranscript([tool('a'), { role, content: '' }, tool('b')]).map(r => r.steps?.length ?? 0)).toEqual([2, 0])
  })
  it('keeps unstructured tool rows as their own rows', () => {
    expect(isTurnStep({ role: 'tool', content: '' })).toBe(false)
    expect(groupTranscript([tool('a'), { role: 'tool', content: '' }, tool('b')]).map(r => r.steps?.length ?? 0)).toEqual([2, 0])
  })
  it('does not take a streaming answer as the end of the turn', () => {
    const rows = groupTranscript([tool('a'), { role: 'assistant', content: 'Ans', streaming: true, timestamp: '2026-01-01T00:00:09Z' }])
    expect(rows[0]!.turnEnd).toBeUndefined()
  })
  it('handles empty transcript and stable first group key while results arrive', () => {
    expect(groupTranscript([])).toEqual([])
    const a = tool('a')
    expect(groupTranscript([a])[0]!.key).toBe(groupTranscript([{ ...a, toolData: { ...a.toolData!, toolResult: 'done' } }, tool('b')])[0]!.key)
  })
  it('distinguishes running, successful empty results, errors and unavailable history', () => {
    expect(toolState(tool('a'))).toBe('running')
    expect(toolState(tool('a'), false)).toBe('unknown')
    for (const toolResult of [null, '', false, 0]) expect(toolState({ ...tool('a'), toolData: { ...tool('a').toolData!, toolResult } })).toBe('complete')
    expect(toolState({ ...tool('a'), toolData: { ...tool('a').toolData!, toolIsError: true } })).toBe('error')
    expect(toolState({ ...tool('a'), id: 4 })).toBe('unknown')
  })
  it('only computes live duration from a valid start timestamp, never invents historical duration', () => {
    const a = { ...tool('a'), timestamp: '2026-01-01T00:00:00Z' }
    const now = Date.parse(a.timestamp) + 5300
    expect(elapsedToolSeconds(a, now)).toBe(5)
    expect(elapsedToolSeconds(a, 0)).toBe(0)
    expect(elapsedToolSeconds({ ...a, timestamp: 'bad' }, now)).toBeNull()
    expect(elapsedToolSeconds({ ...a, id: 4 }, now)).toBeNull()
    expect(elapsedToolSeconds({ ...a, toolData: { ...a.toolData!, toolResult: 'done', completedAt: '2026-01-01T00:00:03Z' } }, now)).toBe(3)
  })

  it('summarizes a finished turn: tool count, reasoning, errors and duration from completion times', () => {
    const steps: ChatMessage[] = [
      { id: 1, role: 'assistant', content: 'r', isThinking: true, timestamp: '2026-01-01T00:00:00Z' },
      { id: 2, role: 'tool', content: '', timestamp: '2026-01-01T00:00:02Z', toolData: { toolName: 'web_search', toolCallId: 'x', toolResult: 'ok' } },
      { id: 3, role: 'tool', content: '', timestamp: '2026-01-01T00:00:05Z', toolData: { toolName: 'shell', toolCallId: 'y', toolIsError: true, toolResult: 'no', completedAt: '2026-01-01T00:00:12Z' } },
    ]
    const summary = summarizeTurn(steps, { active: false, now: 0 })
    expect(summary).toMatchObject({ toolCount: 2, thinkingCount: 1, errorCount: 1, live: false, current: null, currentStep: null, durationSeconds: 12 })
    expect(summarizeTurn(steps, { active: false, now: 0, turnEnd: '2026-01-01T00:00:40Z' }).durationSeconds).toBe(40)
  })
  it('never invents a duration from a single timestamp or none', () => {
    expect(summarizeTurn([{ id: 4, ...tool('a'), timestamp: '2026-01-01T00:00:00Z' }], { active: false, now: 0 }).durationSeconds).toBeNull()
    expect(summarizeTurn([tool('a')], { active: false, now: 0 }).durationSeconds).toBeNull()
  })
  it('reports the running step live, with elapsed time against now', () => {
    const start = '2026-01-01T00:00:00Z'
    const steps: ChatMessage[] = [
      { ...tool('a'), timestamp: start, toolData: { toolName: 'shell', toolCallId: 'a', toolResult: 'ok' } },
      { ...tool('b'), timestamp: '2026-01-01T00:00:03Z' },
    ]
    const summary = summarizeTurn(steps, { active: true, now: Date.parse(start) + 7400 })
    expect(summary.live).toBe(true)
    expect(summary.currentStep).toBe(2)
    expect(summary.current).toEqual({ kind: 'tool', message: steps[1] })
    expect(summary.durationSeconds).toBe(7)
    // The same rows after the turn ended are not running anymore.
    expect(summarizeTurn(steps, { active: false, now: Date.parse(start) + 7400 }).live).toBe(false)
  })
  it('reports streaming reasoning as the live step', () => {
    const summary = summarizeTurn([tool('a'), { role: 'assistant', content: 'hm', isThinking: true, streaming: true }], { active: true, now: 0 })
    expect(summary.current).toEqual({ kind: 'thinking' })
    expect(summary.currentStep).toBe(2)
  })
  it('formats durations without fractions', () => {
    expect(formatTurnDuration(40)).toEqual({ key: 'seconds', params: { s: 40 } })
    expect(formatTurnDuration(125)).toEqual({ key: 'minutes', params: { m: 2, s: 5 } })
    expect(formatTurnDuration(3780)).toEqual({ key: 'hours', params: { h: 1, m: 3 } })
  })
})
