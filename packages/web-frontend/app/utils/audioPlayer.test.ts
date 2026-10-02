import { describe, expect, it } from 'vitest'
import {
  classifyMediaError, formatClock, initialPlayerState, nextRate, progressPercent,
  reducePlayer, seekForKey, seekForPointer, viewForClip, type PlayerEvent, type PlayerState,
} from './audioPlayer'

function run(events: PlayerEvent[], from: PlayerState = initialPlayerState()): PlayerState {
  return events.reduce(reducePlayer, from)
}

describe('player state machine', () => {
  it('starts idle and never plays without an owner', () => {
    const state = run([{ type: 'playing' }, { type: 'time', position: 3 }, { type: 'ended' }])
    expect(state).toEqual(initialPlayerState())
  })

  it('load -> playing -> pause -> playing -> ended', () => {
    let state = run([{ type: 'load', id: 'a', duration: 12 }])
    expect(state).toMatchObject({ id: 'a', status: 'loading', position: 0, duration: 12 })
    state = run([{ type: 'playing' }, { type: 'time', position: 4 }], state)
    expect(state).toMatchObject({ status: 'playing', position: 4 })
    state = run([{ type: 'pause' }], state)
    expect(state.status).toBe('paused')
    state = run([{ type: 'playing' }, { type: 'ended' }], state)
    expect(state).toMatchObject({ status: 'ended', position: 12 })
  })

  it('a new owner resets position and error (one player rule)', () => {
    const state = run([
      { type: 'load', id: 'a', duration: 10 }, { type: 'playing' }, { type: 'time', position: 7 },
      { type: 'load', id: 'b', duration: 5 },
    ])
    expect(state).toMatchObject({ id: 'b', status: 'loading', position: 0, duration: 5 })
    expect(viewForClip(state, 'a', 10)).toMatchObject({ status: 'idle', position: 0, duration: 10 })
  })

  it('errors stay with the owning clip and a load clears them', () => {
    let state = run([{ type: 'load', id: 'a' }, { type: 'error', error: 'network' }])
    expect(state).toMatchObject({ status: 'error', error: 'network' })
    expect(viewForClip(state, 'b').error).toBeNull()
    state = run([{ type: 'load', id: 'a' }], state)
    expect(state.error).toBeNull()
  })

  it('pause is ignored unless something plays or loads', () => {
    expect(run([{ type: 'load', id: 'a' }, { type: 'playing' }, { type: 'ended' }, { type: 'pause' }]).status).toBe('ended')
  })

  it('time is clamped to the duration and the duration can arrive late', () => {
    const state = run([{ type: 'load', id: 'a' }, { type: 'time', position: 3, duration: 2.5 }])
    expect(state).toMatchObject({ position: 2.5, duration: 2.5 })
    expect(run([{ type: 'time', position: Number.NaN }], state).position).toBe(2.5)
  })

  it('stop keeps the chosen rate; unknown rates fall back to 1', () => {
    let state = run([{ type: 'rate', rate: 1.5 }, { type: 'load', id: 'a' }, { type: 'stop' }])
    expect(state).toMatchObject({ id: null, status: 'idle', rate: 1.5 })
    state = run([{ type: 'rate', rate: 3 }], state)
    expect(state.rate).toBe(1)
  })
})

describe('scrubber helpers', () => {
  it('formats clocks in m:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65.9)).toBe('1:05')
    expect(formatClock(3725)).toBe('1:02:05')
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(-4)).toBe('0:00')
  })

  it('maps slider keys and clamps to the track', () => {
    expect(seekForKey('ArrowRight', 10, 60)).toBe(15)
    expect(seekForKey('ArrowUp', 58, 60)).toBe(60)
    expect(seekForKey('ArrowLeft', 2, 60)).toBe(0)
    expect(seekForKey('ArrowDown', 10, 60)).toBe(5)
    expect(seekForKey('PageUp', 10, 60)).toBe(40)
    expect(seekForKey('PageDown', 10, 60)).toBe(0)
    expect(seekForKey('Home', 30, 60)).toBe(0)
    expect(seekForKey('End', 30, 60)).toBe(60)
    expect(seekForKey('Enter', 30, 60)).toBeNull()
    expect(seekForKey('End', 0, 0)).toBeNull()
  })

  it('maps a pointer onto the track', () => {
    expect(seekForPointer(150, 100, 200, 40)).toBe(10)
    expect(seekForPointer(0, 100, 200, 40)).toBe(0)
    expect(seekForPointer(900, 100, 200, 40)).toBe(40)
    expect(seekForPointer(150, 100, 0, 40)).toBeNull()
  })

  it('cycles rates and computes progress', () => {
    expect(nextRate(1)).toBe(1.25)
    expect(nextRate(2)).toBe(1)
    expect(nextRate(7)).toBe(1)
    expect(progressPercent(15, 60)).toBe(25)
    expect(progressPercent(5, 0)).toBe(0)
  })

  it('classifies media errors', () => {
    expect(classifyMediaError({ name: 'NotAllowedError' })).toBe('blocked')
    expect(classifyMediaError({ name: 'AbortError' })).toBe('aborted')
    expect(classifyMediaError({ code: 2 })).toBe('network')
    expect(classifyMediaError({ code: 4 })).toBe('unsupported')
    expect(classifyMediaError(null)).toBe('unknown')
  })
})
