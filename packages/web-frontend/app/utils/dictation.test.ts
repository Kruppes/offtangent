import { describe, expect, it } from 'vitest'
import {
  INITIAL_DICTATION_STATE,
  dictationReducer,
  formatElapsed,
  insertAtCursor,
  isDictationShortcut,
  levelFromTimeDomain,
  pickTranscriptText,
  pushLevel,
  type DictationEvent,
  type DictationState,
} from './dictation'

function run(...events: DictationEvent[]): DictationState {
  return events.reduce(dictationReducer, INITIAL_DICTATION_STATE)
}

describe('dictationReducer', () => {
  it('walks idle → starting → recording → transcribing → idle', () => {
    expect(run({ type: 'start' }).phase).toBe('starting')
    const recording = run({ type: 'start' }, { type: 'started', at: 1000 })
    expect(recording).toEqual({ phase: 'recording', startedAt: 1000, error: null, canRetry: false })
    const transcribing = dictationReducer(recording, { type: 'stop' })
    expect(transcribing.phase).toBe('transcribing')
    expect(dictationReducer(transcribing, { type: 'transcribed' })).toEqual(INITIAL_DICTATION_STATE)
  })

  it('cancel drops a starting or running recording back to idle', () => {
    expect(run({ type: 'start' }, { type: 'cancel' })).toEqual(INITIAL_DICTATION_STATE)
    expect(run({ type: 'start' }, { type: 'started', at: 1 }, { type: 'cancel' })).toEqual(INITIAL_DICTATION_STATE)
    // A running transcription is not cancelled by Esc.
    expect(run({ type: 'start' }, { type: 'started', at: 1 }, { type: 'stop' }, { type: 'cancel' }).phase).toBe('transcribing')
  })

  it('reports a refused microphone as a lasting error without retry', () => {
    const state = run({ type: 'start' }, { type: 'start_failed', error: 'permission_denied' })
    expect(state).toEqual({ phase: 'error', startedAt: null, error: 'permission_denied', canRetry: false })
    // Only an explicit dismiss or a new start leaves the error.
    expect(dictationReducer(state, { type: 'transcribed' })).toBe(state)
    expect(dictationReducer(state, { type: 'retry' })).toBe(state)
    expect(dictationReducer(state, { type: 'dismiss' })).toEqual(INITIAL_DICTATION_STATE)
    expect(dictationReducer(state, { type: 'start' }).phase).toBe('starting')
  })

  it('a too short recording is an error without retry', () => {
    const state = run({ type: 'start' }, { type: 'started', at: 1 }, { type: 'stop' }, { type: 'too_short' })
    expect(state).toMatchObject({ phase: 'error', error: 'too_short', canRetry: false })
  })

  it('a failed transcription can be retried and then succeed', () => {
    const failed = run({ type: 'start' }, { type: 'started', at: 1 }, { type: 'stop' }, { type: 'failed' })
    expect(failed).toMatchObject({ phase: 'error', error: 'transcribe_error', canRetry: true })
    const retrying = dictationReducer(failed, { type: 'retry' })
    expect(retrying.phase).toBe('transcribing')
    expect(dictationReducer(retrying, { type: 'transcribed' })).toEqual(INITIAL_DICTATION_STATE)
    expect(dictationReducer(retrying, { type: 'failed' })).toMatchObject({ error: 'transcribe_error', canRetry: true })
  })

  it('ignores events that do not fit the phase (double clicks, late callbacks)', () => {
    const idle = INITIAL_DICTATION_STATE
    for (const event of [{ type: 'stop' }, { type: 'started', at: 5 }, { type: 'transcribed' }, { type: 'failed' }, { type: 'retry' }, { type: 'cancel' }, { type: 'dismiss' }] as DictationEvent[]) {
      expect(dictationReducer(idle, event)).toBe(idle)
    }
    const recording = run({ type: 'start' }, { type: 'started', at: 1 })
    expect(dictationReducer(recording, { type: 'start' })).toBe(recording)
  })

  it('no speech is a dismissible error', () => {
    const state = run({ type: 'start' }, { type: 'started', at: 1 }, { type: 'stop' }, { type: 'no_speech' })
    expect(state).toMatchObject({ phase: 'error', error: 'no_speech', canRetry: false })
  })
})

describe('insertAtCursor', () => {
  it('inserts into an empty field', () => {
    expect(insertAtCursor('', ' hello there ', 0)).toEqual({ value: 'hello there', caret: 11 })
  })

  it('appends with one separating space and puts the caret after the text', () => {
    expect(insertAtCursor('Typed', 'spoken', 5)).toEqual({ value: 'Typed spoken', caret: 12 })
    expect(insertAtCursor('Typed ', 'spoken', 6)).toEqual({ value: 'Typed spoken', caret: 12 })
  })

  it('inserts in the middle with spaces on both sides', () => {
    expect(insertAtCursor('ab', 'X', 1)).toEqual({ value: 'a X b', caret: 3 })
    expect(insertAtCursor('a b', 'X', 2)).toEqual({ value: 'a X b', caret: 3 })
  })

  it('never replaces a selection; the text goes in at its end', () => {
    expect(insertAtCursor('one two', 'three', 0, 3)).toEqual({ value: 'one three two', caret: 9 })
  })

  it('falls back to the end for a missing or out-of-range caret', () => {
    expect(insertAtCursor('abc', 'd', null)).toEqual({ value: 'abc d', caret: 5 })
    expect(insertAtCursor('abc', 'd', 99)).toEqual({ value: 'abc d', caret: 5 })
  })

  it('leaves the value alone for blank text', () => {
    expect(insertAtCursor('abc', '   ', 1)).toEqual({ value: 'abc', caret: 1 })
  })
})

describe('helpers', () => {
  it('formats the running time as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(9_999)).toBe('00:09')
    expect(formatElapsed(65_000)).toBe('01:05')
    expect(formatElapsed(3_600_000)).toBe('60:00')
    expect(formatElapsed(-5)).toBe('00:00')
  })

  it('prefers a non-blank rewritten text, like the app', () => {
    expect(pickTranscriptText({ transcript: ' raw ', rewritten: ' clean ' })).toBe('clean')
    expect(pickTranscriptText({ transcript: ' raw ', rewritten: '  ' })).toBe('raw')
    expect(pickTranscriptText({ transcript: 'raw' })).toBe('raw')
    expect(pickTranscriptText({})).toBe('')
  })

  it('computes a 0..1 level from a time-domain frame', () => {
    expect(levelFromTimeDomain(new Uint8Array(32).fill(128))).toBe(0)
    expect(levelFromTimeDomain([])).toBe(0)
    const loud = Uint8Array.from({ length: 32 }, (_, i) => (i % 2 ? 255 : 0))
    expect(levelFromTimeDomain(loud)).toBe(1)
  })

  it('keeps a fixed, smoothed level history', () => {
    let row: number[] = []
    for (let i = 0; i < 30; i++) row = pushLevel(row, 1, 24)
    expect(row).toHaveLength(24)
    expect(row.at(-1)).toBeGreaterThan(0.99)
    expect(pushLevel([], 1, 24)).toEqual([0.5])
    expect(pushLevel([0.5], 5, 24)).toEqual([0.5, 0.75])
  })

  it('recognises Ctrl+M only (Cmd+M belongs to the OS on macOS)', () => {
    const base = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }
    expect(isDictationShortcut({ ...base, key: 'm', ctrlKey: true })).toBe(true)
    expect(isDictationShortcut({ ...base, key: 'M', ctrlKey: true })).toBe(true)
    expect(isDictationShortcut({ ...base, key: 'm', metaKey: true })).toBe(false)
    expect(isDictationShortcut({ ...base, key: 'm', ctrlKey: true, shiftKey: true })).toBe(false)
    expect(isDictationShortcut({ ...base, key: 'm' })).toBe(false)
  })
})
