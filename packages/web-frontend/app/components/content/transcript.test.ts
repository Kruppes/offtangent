import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../composables/useChat'
import { elapsedToolSeconds, groupTranscript, toolState, transcriptState } from './transcript'
const tool = (id: string): ChatMessage => ({ role: 'tool', content: '', toolData: { toolName: 'shell', toolCallId: id } })
describe('transcript presentation', () => {
  it.each([[true, true, 1, 'error'], [false, true, 1, 'loading'], [false, false, 0, 'empty'], [false, false, 1, 'ready']] as const)('covers state %s/%s/%s', (error, loading, count, expected) => {
    expect(transcriptState(error, loading, count)).toBe(expected)
  })
  it('groups only adjacent structured tools without mutating messages or losing identity', () => {
    const a = tool('a'), b = tool('b'), c = tool('c')
    const answer: ChatMessage = { role: 'assistant', content: 'Answer' }
    const input = [a, b, answer, c]
    const rows = groupTranscript(input)
    expect(rows.map(r => r.tools?.length ?? 0)).toEqual([2, 0, 1])
    expect(rows[0]!.tools).toEqual([a, b])
    expect(rows[1]!.message).toBe(answer)
    expect(rows[1]!.index).toBe(2)
    expect(input).toEqual([a, b, answer, c])
    expect(a).not.toHaveProperty('tools')
  })
  it.each(['user', 'system', 'divider', 'tool', 'assistant'] as const)('does not group across a %s boundary', role => {
    expect(groupTranscript([tool('a'), { role, content: '' }, tool('b')])).toHaveLength(3)
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
})
