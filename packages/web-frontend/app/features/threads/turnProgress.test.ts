import { describe, expect, it } from 'vitest'
import { advanceTurn, elapsedTurnSeconds, isTurnActive } from './turnProgress'
describe('observed turn lifecycle', () => {
  it('follows measured queued/tool/text/done frames', () => {
    let turn = advanceTurn(undefined, 'send', 1000)
    for (const [type, phase] of [['queued', 'waiting'], ['tool_call_start', 'working'], ['text', 'writing'], ['done', 'done']]) {
      turn = advanceTurn(turn, type!, 4000)
      expect(turn?.phase).toBe(phase)
    }
    expect(elapsedTurnSeconds(turn!, 99000)).toBe(3)
    expect(isTurnActive(turn)).toBe(false)
  })
  it('stops the clock locally when abort never receives a completion frame', () => {
    const started = advanceTurn(undefined, 'send', 1000)
    const stopped = advanceTurn(started, 'stop', 3500)!
    expect(elapsedTurnSeconds(stopped, 90000)).toBe(2)
    expect(isTurnActive(stopped)).toBe(false)
    expect(advanceTurn(stopped, 'text', 100000)).toBe(stopped)
    expect(advanceTurn(stopped, 'send', 100000)?.phase).toBe('waiting')
  })
  it('freezes on disconnection without claiming backend completion', () => {
    const turn = advanceTurn(advanceTurn(undefined, 'thinking', 0), 'disconnect', 5000)!
    expect(turn.phase).toBe('disconnected')
    expect(elapsedTurnSeconds(turn, 8000)).toBe(5)
  })
})
