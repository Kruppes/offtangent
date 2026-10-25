/**
 * ClockExchangeTracker (companion K2): follows the answer turns of a clock
 * exchange on TurnRunner.subscribe, cuts the spoken part (H2, H3 fallback)
 * and serves it to the long poll with a cursor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  CLOCK_SPOKEN_MAX,
  ClockExchangeTracker,
  createdTaskId,
  cutAtWord,
  shortenedForVoice,
  spokenPart,
  wholeSentences,
  type ClockAnswerReady,
  type ClockTurnSource,
  type RegisterExchangeInput,
  type TrackedTurnEvent,
} from './exchange.js'

let subscribers: Array<{ user: string; fn: (e: TrackedTurnEvent) => void }>
let subscribeCalls: number
const source: ClockTurnSource = {
  subscribe: (user, fn) => {
    subscribeCalls += 1
    const entry = { user: String(user), fn }
    subscribers.push(entry)
    return () => { subscribers = subscribers.filter(s => s !== entry) }
  },
}
const emit = (event: TrackedTurnEvent, user = '1') => { for (const s of [...subscribers]) if (s.user === user) s.fn(event) }
const text = (turnId: string, t: string) => emit({ type: 'chunk', turnId, chunk: { type: 'text', text: t } })
const end = (turnId: string) => { emit({ type: 'chunk', turnId, chunk: { type: 'done' } }); emit({ type: 'turn_end', turnId }) }

let now: number
let ready: ClockAnswerReady[]
let tracker: ClockExchangeTracker

function make(extra: Partial<ConstructorParameters<typeof ClockExchangeTracker>[0]> = {}): ClockExchangeTracker {
  return new ClockExchangeTracker({
    getTurnSource: () => source,
    now: () => now,
    onAnswerReady: r => ready.push(r),
    backgroundAfterMs: 60_000,
    ...extra,
  })
}

function reg(input: Partial<RegisterExchangeInput> = {}): void {
  tracker.register({
    exchangeId: 'ex-1', deviceId: 'dev-1', userId: 1, strandId: 's-1', strandTitle: 'Wetter', persona: 'main',
    turnIds: [{ partIndex: 0, turnId: 't-1' }], ...input,
  })
}

beforeEach(() => {
  subscribers = []
  subscribeCalls = 0
  now = 1_000_000
  ready = []
  tracker = make()
})
afterEach(() => tracker.dispose())

describe('spokenPart (H2)', () => {
  it('takes the closed first paragraph and marks the rest as truncated', () => {
    const cut = spokenPart('Es wird sonnig.\n\n- Details\n- mehr', false)
    expect(cut).toEqual({ text: 'Es wird sonnig.', complete: true, overLimit: false, truncated: true })
  })
  it('releases whole sentences only while the paragraph streams', () => {
    expect(spokenPart('Erster Satz. Zweiter Sa', false)).toMatchObject({ text: 'Erster Satz.', complete: false })
    // A finished unit without a terminator ends as a sentence (review K0-K2, MINOR-1).
    expect(spokenPart('Erster Satz. Zweiter Sa', true)).toMatchObject({ text: 'Erster Satz. Zweiter Sa.', complete: true })
  })
  it('a closed paragraph without a terminator still ends as a whole sentence (MINOR-1 counter-probe)', () => {
    expect(spokenPart('Kernantwort ohne Punkt\n\nWeitere Details.', false)).toMatchObject({ text: 'Kernantwort ohne Punkt.', complete: true, truncated: true })
    expect(spokenPart('Hier die Schritte:\n\n1. Eins', false).text).toBe('Hier die Schritte.')
    expect(spokenPart('Frage?\n\nMehr.', false).text).toBe('Frage?')
    expect(wholeSentences('Ja. Und dann', 9)).toEqual({ text: 'Ja.', dropped: true })
    expect(wholeSentences('ohne Ende', 9)).toEqual({ text: '', dropped: true })
    expect(wholeSentences('ohne Ende', 10)).toEqual({ text: 'ohne Ende.', dropped: false })
  })
  it('strips interaction fences and markdown', () => {
    const raw = '**Ja**, das geht: [Link](https://x.y).\n\n```offtangent-choice\n{"q":"x"}\n```'
    expect(spokenPart(raw, true).text).toBe('Ja, das geht: Link.')
    expect(spokenPart('Ja. ```offtangent-con', false).text).toBe('Ja.')
  })
  it('cuts an over-long paragraph at whole sentences, or flags H3 when none fits', () => {
    const long = `${'Satz eins ist kurz. '}${'x'.repeat(CLOCK_SPOKEN_MAX)}.`
    expect(spokenPart(long, true)).toMatchObject({ text: 'Satz eins ist kurz.', complete: true, truncated: true })
    expect(spokenPart('y'.repeat(CLOCK_SPOKEN_MAX + 10), true)).toMatchObject({ text: '', overLimit: true })
  })
  it('cutAtWord ends in an ellipsis within the limit', () => {
    const cut = cutAtWord('wort '.repeat(100), 50)
    expect(cut.length).toBeLessThanOrEqual(50)
    expect(cut.endsWith('…')).toBe(true)
  })
  it('createdTaskId reads details and the text fallback', () => {
    expect(createdTaskId({ details: { taskId: 'abc123' } })).toBe('abc123')
    expect(createdTaskId({ content: [{ type: 'text', text: 'Task ID: f00dbeef started' }] })).toBe('f00dbeef')
    expect(createdTaskId(null)).toBeNull()
  })
})

describe('ClockExchangeTracker', () => {
  it('subscribes once per user and follows only the registered turn', () => {
    reg()
    reg({ exchangeId: 'ex-2', turnIds: [{ partIndex: 0, turnId: 't-2' }] })
    expect(subscribeCalls).toBe(1)
    text('t-other', 'Fremd. ')
    text('t-1', 'Morgen sonnig.')
    end('t-1')
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'done', text_delta: 'Morgen sonnig.', spoken_done: true })
    expect(tracker.view('ex-2', 0)).toMatchObject({ state: 'thinking', text_delta: '' })
  })

  it('serves deltas by cursor, idempotently', () => {
    reg()
    text('t-1', 'Eins. ')
    const a = tracker.view('ex-1', 0)!
    expect(a).toMatchObject({ state: 'speaking', text_delta: 'Eins.', cursor: 5 })
    text('t-1', 'Zwei. ')
    expect(tracker.view('ex-1', a.cursor)!.text_delta).toBe(' Zwei.')
    expect(tracker.view('ex-1', 0)!.text_delta).toBe('Eins. Zwei.')
    expect(tracker.view('ex-1', 999)!.text_delta).toBe('')
    expect(tracker.view('nope', 0)).toBeNull()
  })

  it('replays events that arrived before the registration (watch first)', () => {
    tracker.watch(1)
    text('t-1', 'Früh. ')
    end('t-1')
    reg()
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'done', text_delta: 'Früh.' })
  })

  it('goes queued -> thinking on turn_start', () => {
    reg({ queue: { position: 2, blockedByTitle: 'Anderes' } })
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'queued', queue: { position: 2, blocked_by_title: 'Anderes' } })
    emit({ type: 'turn_start', turnId: 't-1', sessionId: 's-1' })
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'thinking', queue: null })
  })

  it('goes to background after 60 s without text and reports answer_ready at the end', () => {
    reg()
    now += 61_000
    expect(tracker.view('ex-1', 0)!.state).toBe('background')
    expect(tracker.busy(1)).toBe(false)
    text('t-1', 'Spät.')
    end('t-1')
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'done', answer_ready: true, text_delta: 'Spät.' })
    expect(ready).toHaveLength(1)
    expect(tracker.answersReady(1)).toHaveLength(1)
  })

  it('follows all turns of a split capture: speaks part 0, answer_ready when the others end', () => {
    reg({ turnIds: [{ partIndex: 1, turnId: 't-b' }, { partIndex: 0, turnId: 't-a' }], moreParts: [{ title: 'Garten' }] })
    text('t-b', 'Teil zwei. ')
    text('t-a', 'Teil eins.')
    end('t-a')
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'done', text_delta: 'Teil eins.', answer_ready: false, more_parts: [{ title: 'Garten' }] })
    end('t-b')
    expect(tracker.view('ex-1', 0)!.answer_ready).toBe(true)
  })

  // Review K0-K2, MAJOR-4: only part 0 is spoken; a later part never becomes primary.
  it('the reviewer probe: without a part-0 turn the answer of part 1 is not spoken', () => {
    reg({ turnIds: [{ partIndex: 1, turnId: 't-b' }], phase: 'needs_choice', moreParts: [{ title: 'Zweites Thema' }] })
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'needs_choice', text_delta: 'Rückfrage in der App', spoken_done: true })
    text('t-b', 'Antwort des zweiten Teils.')
    end('t-b')
    const view = tracker.view('ex-1', 0)!
    expect(view).toMatchObject({ state: 'needs_choice', text_delta: 'Rückfrage in der App', more_parts: [{ title: 'Zweites Thema' }] })
    expect(JSON.stringify(view)).not.toContain('zweiten Teils')
    // The finished answer of part 1 is still announced (answer_ready, §3).
    expect(view.answer_ready).toBe(true)
    expect(tracker.firstAnswer('ex-1')).toMatchObject({ turnId: null })
  })

  it('without a part-0 turn and without a phase the exchange is needs_choice, not thinking', () => {
    reg({ turnIds: [{ partIndex: 1, turnId: 't-b' }] })
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'needs_choice' })
    expect(tracker.busy(1)).toBe(false)
  })

  it('marks a task started by the answer (E4)', () => {
    reg()
    emit({ type: 'chunk', turnId: 't-1', chunk: { type: 'tool_call_end', toolName: 'create_task', toolResult: { details: { taskId: 'task-9' } } } })
    emit({ type: 'chunk', turnId: 't-1', chunk: { type: 'tool_call_end', toolName: 'create_task', toolIsError: true, toolResult: { details: { taskId: 'task-x' } } } })
    expect(tracker.view('ex-1', 0)!.task_ids).toEqual(['task-9'])
    expect([...tracker.questionTaskIds(1)]).toEqual(['task-9'])
    expect([...tracker.questionTaskIds(2)]).toEqual([])
  })

  it('a turn without text that fails ends as error', () => {
    reg()
    emit({ type: 'chunk', turnId: 't-1', chunk: { type: 'error', error: 'boom' } })
    end('t-1')
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'error', error: 'turn_failed' })
  })

  it('an exchange without a turn is terminal at once: noted, needs_choice', () => {
    reg({ turnIds: [], phase: 'noted', strandTitle: 'Einkauf' })
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'noted', text_delta: 'Notiert: Einkauf', spoken_done: true })
    reg({ exchangeId: 'ex-2', turnIds: [], phase: 'needs_choice' })
    expect(tracker.view('ex-2', 0)!.state).toBe('needs_choice')
    expect(subscribeCalls).toBe(0)
  })

  it('hides text and titles in privacy mode', () => {
    reg()
    text('t-1', 'Geheim.')
    expect(tracker.view('ex-1', 0, true)).toMatchObject({ text_delta: '', strand_title: null })
    expect(tracker.view('ex-1', 0, true)!.cursor).toBe(7)
  })

  it('forgets an exchange after the TTL', () => {
    reg()
    now += 16 * 60_000
    expect(tracker.has('ex-1')).toBe(false)
  })

  it('waitForChange resolves on new text, and after the timeout without', async () => {
    reg()
    const started = Date.now()
    await tracker.waitForChange('ex-1', 0, 'thinking', 60)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    const waiting = tracker.waitForChange('ex-1', 0, 'thinking', 5_000)
    setTimeout(() => text('t-1', 'Da.'), 10)
    await waiting
    expect(tracker.view('ex-1', 0)!.text_delta).toBe('Da.')
  })

  it('H3: a paragraph without a fitting sentence is shortened by the model', async () => {
    tracker.dispose()
    tracker = make({ shorten: async () => 'Kurz gesagt: ja.' })
    reg()
    text('t-1', 'z'.repeat(CLOCK_SPOKEN_MAX + 50))
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'thinking', text_delta: '' })
    end('t-1')
    await new Promise(r => setTimeout(r, 0))
    expect(tracker.view('ex-1', 0)).toMatchObject({ state: 'done', text_delta: 'Kurz gesagt: ja.', truncated: true })
  })

  it('H3: a model answer with an interaction fence never reaches the clock (review K0-K2, MAJOR-1)', async () => {
    const fenced = 'Kurz: ja.\n\n```offtangent\n{"kind":"choice","question":"x","options":["a","b"]}\n```'
    tracker.dispose()
    tracker = make({ shorten: async () => fenced })
    reg()
    text('t-1', 'wort '.repeat(100))
    end('t-1')
    await new Promise(r => setTimeout(r, 0))
    const view = tracker.view('ex-1', 0)!
    expect(view.state).toBe('done')
    expect(view.text_delta).not.toMatch(/offtangent|kind|```|\{/)
    expect(view.text_delta.length).toBeLessThanOrEqual(CLOCK_SPOKEN_MAX)
  })

  it('shortenedForVoice: fence, card, residue and over-long model answers', () => {
    // Reviewer's counter-probe: a fence alone used to come out as 'offtangent {"kind":"choice"}'.
    expect(shortenedForVoice('```offtangent\n{"kind":"choice"}\n```')).toBeNull()
    expect(shortenedForVoice('Ja.\n\n```offtangent-choice\n{"question":"x","options":["a","b"]}\n```')).not.toMatch(/offtangent|question|```/)
    expect(shortenedForVoice('Ja. offtangent {"kind":"choice"}')).toBeNull()
    expect(shortenedForVoice('Ja. {"kind": "confirm"}')).toBeNull()
    expect(shortenedForVoice('**Ja**, das geht.')).toBe('Ja, das geht.')
    const long = `Erster Satz passt. ${'x'.repeat(CLOCK_SPOKEN_MAX)}.`
    expect(shortenedForVoice(long)).toBe('Erster Satz passt.')
    expect(shortenedForVoice('y'.repeat(CLOCK_SPOKEN_MAX + 5))).toBeNull()
    expect(shortenedForVoice('')).toBeNull()
    // MINOR-1: a short model answer without a sentence end still ends as a sentence.
    expect(shortenedForVoice('Kurz gesagt ja')).toBe('Kurz gesagt ja.')
  })

  it('H3 falls back to the word cut when the model fails or times out', async () => {
    tracker.dispose()
    tracker = make({ shorten: () => new Promise(() => {}), shortenTimeoutMs: 20 })
    reg()
    text('t-1', 'wort '.repeat(100))
    end('t-1')
    await new Promise(r => setTimeout(r, 40))
    const view = tracker.view('ex-1', 0)!
    expect(view.state).toBe('done')
    expect(view.text_delta.length).toBeLessThanOrEqual(CLOCK_SPOKEN_MAX)
    expect(view.text_delta.endsWith('…')).toBe(true)
  })
})

// Review K0-K2, MINOR-2: watch() subscribed early and nothing but dispose()
// ever unsubscribed, also after an abandoned upload or the exchange TTL.
describe('ClockExchangeTracker subscription lifetime (MINOR-2)', () => {
  let unsubscribed: string[]
  const spied: ClockTurnSource = {
    subscribe: (user, fn) => {
      const unsub = source.subscribe(user, fn)
      return () => { unsubscribed.push(String(user)); unsub() }
    },
  }
  beforeEach(() => {
    unsubscribed = []
    tracker.dispose()
    tracker = make({ getTurnSource: () => spied, ttlMs: 60_000 })
  })

  it('an upload given up after watch() (STT/capture failed) unsubscribes', () => {
    tracker.watch(1)
    expect(tracker.subscribedUsers()).toEqual([1])
    tracker.unwatch(1)
    expect(unsubscribed).toEqual(['1'])
    expect(tracker.subscribedUsers()).toEqual([])
    expect(subscribers).toHaveLength(0)
  })

  it('stays subscribed while a turn runs and unsubscribes when the last turn ends', () => {
    tracker.watch(1)
    reg()
    tracker.unwatch(1)
    expect(unsubscribed).toEqual([])
    text('t-1', 'Es wird sonnig.')
    end('t-1')
    expect(unsubscribed).toEqual(['1'])
    expect(tracker.view('ex-1', 0)?.text_delta).toBe('Es wird sonnig.')
  })

  it('a second upload of the same user keeps the subscription until both are done', () => {
    tracker.watch(1)
    reg()
    tracker.unwatch(1)
    tracker.watch(1)
    reg({ exchangeId: 'ex-2', turnIds: [{ partIndex: 0, turnId: 't-2' }] })
    tracker.unwatch(1)
    end('t-1')
    expect(unsubscribed).toEqual([])
    end('t-2')
    expect(unsubscribed).toEqual(['1'])
    expect(subscribeCalls).toBe(1)
  })

  it('a turn that never ends is dropped with the exchange TTL, and so is the subscription', () => {
    tracker.watch(1)
    reg()
    tracker.unwatch(1)
    text('t-1', 'Ich denke')
    now += 60_001
    expect(tracker.has('ex-1')).toBe(false)
    expect(unsubscribed).toEqual(['1'])
    expect(subscribers).toHaveLength(0)
  })

  it('the TTL fires without a further request (timer)', async () => {
    tracker.dispose()
    tracker = make({ getTurnSource: () => spied, ttlMs: 20, now: () => Date.now() })
    tracker.watch(1)
    reg()
    tracker.unwatch(1)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(unsubscribed).toEqual(['1'])
  })

  it('the next upload subscribes again and still gets its early chunks', () => {
    tracker.watch(1)
    tracker.unwatch(1)
    tracker.watch(1)
    text('t-1', 'Früh. ')
    reg()
    tracker.unwatch(1)
    text('t-1', 'Spät.')
    end('t-1')
    expect(tracker.view('ex-1', 0)?.text_delta).toBe('Früh. Spät.')
    expect(subscribeCalls).toBe(2)
    expect(unsubscribed).toEqual(['1', '1'])
  })
})
