/**
 * capture-split.ts (plan 2026-09-24): segmentation, the stage 1 validator and
 * its repair loop, the confidence gate, the tiny-topic merge and the
 * consolidation fallback. The model is stubbed everywhere: what is tested is
 * the code around it, because that is what decides.
 */
import { describe, it, expect } from 'vitest'
import {
  segmentSentences,
  parseStage1Answer,
  splitCapture,
  mergeTinyTopics,
  consolidatePart,
  runCaptureSplit,
  isSplitEligible,
  capturePartContextLine,
  withCapturePartPrefix,
  parseCapturePartRef,
  SPLIT_MIN,
  SPLIT_REPAIR_ATTEMPTS,
  STAGE1_SYSTEM_PROMPT,
  STAGE2_SYSTEM_PROMPT,
} from './capture-split.js'
import type { SplitCompletion, SplitTopic } from './capture-split.js'

/** A stub that answers the queued texts in order and records every call. */
function stub(answers: string[]): { complete: SplitCompletion; calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = []
  const queue = [...answers]
  return {
    calls,
    complete: async (system, user) => {
      calls.push({ system, user })
      const next = queue.shift()
      if (next === undefined) throw new Error('stub has no answer')
      if (next.startsWith('THROW:')) throw new Error(next.slice(6))
      return next
    },
  }
}

function stage1(topics: Array<{ id: string; title: string; sentenceIds: number[] }>, splitConfidence = 0.9): string {
  return JSON.stringify({ topics, uncertain: [], splitConfidence, rationale: 'two unrelated matters' })
}

describe('segmentSentences', () => {
  it('splits on sentence punctuation and collapses whitespace', () => {
    expect(segmentSentences('Erstens das.  Zweitens\ndas! Drittens?')).toEqual(['Erstens das.', 'Zweitens das!', 'Drittens?'])
  })

  it('strips a leading voice marker for segmentation only', () => {
    expect(segmentSentences('🎤 Voice: Eins. Zwei.')).toEqual(['Eins.', 'Zwei.'])
  })

  it('breaks a long unpunctuated run at discourse markers', () => {
    const run = `${'a'.repeat(200)} und dann ${'b'.repeat(200)} also ${'c'.repeat(100)}`
    const out = segmentSentences(run)
    expect(out.length).toBeGreaterThan(1)
    expect(out.join(' ').replace(/\s+/g, ' ')).toBe(run)
    expect(out[1].startsWith('dann')).toBe(true)
  })

  it('returns nothing for an empty text', () => {
    expect(segmentSentences('   ')).toEqual([])
  })
})

describe('parseStage1Answer', () => {
  it('accepts a complete assignment and sorts the ids', () => {
    const parsed = parseStage1Answer(stage1([{ id: 'A', title: 'Dach', sentenceIds: [3, 1] }, { id: 'B', title: 'Auto', sentenceIds: [2] }]), 3)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.answer.topics[0].sentenceIds).toEqual([1, 3])
    expect(parsed.answer.splitConfidence).toBe(0.9)
  })

  it('reads a fenced answer', () => {
    const parsed = parseStage1Answer('```json\n' + stage1([{ id: 'A', title: 'x', sentenceIds: [1, 2] }], 1) + '\n```', 2)
    expect(parsed.ok).toBe(true)
  })

  it('rejects a missing sentence', () => {
    const parsed = parseStage1Answer(stage1([{ id: 'A', title: 'x', sentenceIds: [1] }]), 3)
    expect(parsed).toEqual({ ok: false, error: 'sentences not assigned: 2, 3' })
  })

  it('rejects a duplicated sentence', () => {
    const parsed = parseStage1Answer(stage1([{ id: 'A', title: 'x', sentenceIds: [1, 2] }, { id: 'B', title: 'y', sentenceIds: [2] }]), 2)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.error).toContain('sentence 2 in topics A and B')
  })

  it('rejects an id out of range and a non object', () => {
    expect(parseStage1Answer(stage1([{ id: 'A', title: 'x', sentenceIds: [1, 9] }]), 2).ok).toBe(false)
    expect(parseStage1Answer('nonsense', 2)).toEqual({ ok: false, error: 'not JSON' })
    expect(parseStage1Answer('[1,2]', 2)).toEqual({ ok: false, error: 'not an object' })
  })

  it('forces splitConfidence 1 for a single topic and 0 for a missing value', () => {
    const single = parseStage1Answer(JSON.stringify({ topics: [{ id: 'A', title: 'x', sentenceIds: [1, 2] }], rationale: 'one matter' }), 2)
    expect(single.ok && single.answer.splitConfidence).toBe(1)
    const multi = parseStage1Answer(JSON.stringify({
      topics: [{ id: 'A', title: 'x', sentenceIds: [1] }, { id: 'B', title: 'y', sentenceIds: [2] }],
      rationale: '',
    }), 2)
    expect(multi.ok && multi.answer.splitConfidence).toBe(0)
  })
})

describe('splitCapture repair loop', () => {
  const sentences = ['Eins.', 'Zwei.', 'Drei.', 'Vier.']

  it('echoes the rejected answer back and accepts the repair', async () => {
    const bad = stage1([{ id: 'A', title: 'x', sentenceIds: [1] }])
    const good = stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }])
    const s = stub([bad, good])
    const out = await splitCapture(sentences, s.complete)
    expect(out.attempts).toBe(2)
    expect(out.answer.topics).toHaveLength(2)
    expect(s.calls[0].system).toBe(STAGE1_SYSTEM_PROMPT)
    expect(s.calls[1].user).toContain('Your previous answer was rejected')
    expect(s.calls[1].user).toContain(bad)
    expect(out.notes[0]).toContain('rejected')
  })

  it('gives up after three attempts', async () => {
    const bad = stage1([{ id: 'A', title: 'x', sentenceIds: [1] }])
    const s = stub([bad, bad, bad])
    await expect(splitCapture(sentences, s.complete)).rejects.toThrow(/failed after 3 attempts/)
    expect(s.calls).toHaveLength(SPLIT_REPAIR_ATTEMPTS)
  })

  it('retries a model error too', async () => {
    const good = stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }])
    const s = stub(['THROW:overloaded', good])
    const out = await splitCapture(sentences, s.complete)
    expect(out.attempts).toBe(2)
  })
})

describe('mergeTinyTopics', () => {
  it('folds a one sentence topic into the preceding topic', () => {
    const topics: SplitTopic[] = [
      { id: 'A', title: 'Dach', sentenceIds: [1, 2] },
      { id: 'B', title: 'Meta', sentenceIds: [3] },
      { id: 'C', title: 'Auto', sentenceIds: [4, 5] },
    ]
    const merged = mergeTinyTopics(topics)
    expect(merged.map(t => t.id)).toEqual(['A', 'C'])
    expect(merged[0].sentenceIds).toEqual([1, 2, 3])
  })

  it('folds a leading one sentence topic forward', () => {
    const merged = mergeTinyTopics([
      { id: 'A', title: 'Gruss', sentenceIds: [1] },
      { id: 'B', title: 'Dach', sentenceIds: [2, 3] },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].sentenceIds).toEqual([1, 2, 3])
  })

  it('leaves a set of only tiny topics alone', () => {
    const topics: SplitTopic[] = [{ id: 'A', title: 'x', sentenceIds: [1] }, { id: 'B', title: 'y', sentenceIds: [2] }]
    expect(mergeTinyTopics(topics)).toEqual(topics)
  })
})

describe('consolidatePart', () => {
  it('returns a single sentence verbatim without a model call', async () => {
    const s = stub([])
    expect(await consolidatePart('Dach', ['Nur ein Satz.'], s.complete)).toBe('Nur ein Satz.')
    expect(s.calls).toHaveLength(0)
  })

  it('asks the model with the part sentences in spoken order', async () => {
    const s = stub(['Konsolidiert.'])
    const text = await consolidatePart('Dach', ['Eins.', 'Zwei.'], s.complete)
    expect(text).toBe('Konsolidiert.')
    expect(s.calls[0].system).toBe(STAGE2_SYSTEM_PROMPT)
    expect(s.calls[0].user).toContain('Topic: Dach')
    expect(s.calls[0].user).toContain('Eins.\nZwei.')
  })

  it('rejects an empty answer', async () => {
    const s = stub(['   '])
    await expect(consolidatePart('Dach', ['Eins.', 'Zwei.'], s.complete)).rejects.toThrow(/empty/)
  })
})

describe('runCaptureSplit', () => {
  const text = 'Das Dach tropft. Ich brauche einen Dachdecker. Das Auto muss zum Service. Der Termin ist Montag.'

  it('keeps the original text verbatim for one topic', async () => {
    const s = stub([stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2, 3, 4] }], 1)])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts).toHaveLength(1)
    expect(split.parts[0].text).toBe(text)
    expect(split.gated).toBe(false)
    expect(s.calls).toHaveLength(1)
  })

  it('consolidates every part of a real split', async () => {
    const s = stub([
      stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }], 0.92),
      'Das Dach tropft, ich brauche einen Dachdecker.',
      'Das Auto muss zum Service, der Termin ist Montag.',
    ])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts.map(p => ({ index: p.index, title: p.title, ids: p.sentenceIds }))).toEqual([
      { index: 0, title: 'Dach', ids: [1, 2] },
      { index: 1, title: 'Auto', ids: [3, 4] },
    ])
    expect(split.parts[0].text).toBe('Das Dach tropft, ich brauche einen Dachdecker.')
    expect(split.splitConfidence).toBe(0.92)
    expect(split.rationale).toBe('two unrelated matters')
  })

  it('gates a split below the minimum confidence back into one part', async () => {
    const s = stub([stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }], SPLIT_MIN - 0.01)])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts).toHaveLength(1)
    expect(split.parts[0].text).toBe(text)
    expect(split.gated).toBe(true)
    expect(split.notes.some(n => n.includes('below 0.7'))).toBe(true)
  })

  it('falls back to the verbatim sentences when a consolidation fails', async () => {
    const s = stub([
      stage1([{ id: 'A', title: 'Dach', sentenceIds: [1, 2] }, { id: 'B', title: 'Auto', sentenceIds: [3, 4] }], 0.92),
      'THROW:provider down',
      'THROW:provider down',
    ])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts).toHaveLength(2)
    expect(split.parts[0].text).toBe('Das Dach tropft. Ich brauche einen Dachdecker.')
    expect(split.parts[1].text).toBe('Das Auto muss zum Service. Der Termin ist Montag.')
    expect(split.notes.some(n => n.includes('consolidation failed'))).toBe(true)
  })

  it('does not call the model for a text with too few sentences', async () => {
    const s = stub([])
    const short = 'Kurz. Notiz.'
    const split = await runCaptureSplit(short, { complete: s.complete })
    expect(split.parts[0].text).toBe(short)
    expect(s.calls).toHaveLength(0)
  })

  it('degrades to one part when stage 1 never answers', async () => {
    const s = stub(['THROW:down', 'THROW:down', 'THROW:down'])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts).toHaveLength(1)
    expect(split.parts[0].text).toBe(text)
    expect(split.rationale).toBe('split unavailable')
  })

  it('files a tiny topic into its neighbour instead of opening a part for it', async () => {
    const s = stub([
      stage1([
        { id: 'A', title: 'Dach', sentenceIds: [1, 2] },
        { id: 'B', title: 'Meta', sentenceIds: [3] },
        { id: 'C', title: 'Auto', sentenceIds: [4] },
      ], 0.95),
    ])
    const split = await runCaptureSplit(text, { complete: s.complete })
    expect(split.parts).toHaveLength(1)
    expect(split.parts[0].text).toBe(text)
  })

  it('returns one part without a model when no chain entry resolves', async () => {
    const split = await runCaptureSplit(text, { chain: [] })
    expect(split.parts).toHaveLength(1)
    expect(split.model).toBe('none')
  })
})

describe('isSplitEligible', () => {
  it('always considers a voice capture', () => {
    expect(isSplitEligible({ kind: 'voice', text: 'kurz' }, { splitOnIntake: true, splitMinChars: 400 })).toBe(true)
  })

  it('considers text only from the minimum length on', () => {
    const settings = { splitOnIntake: true, splitMinChars: 10 }
    expect(isSplitEligible({ kind: 'text', text: 'kurz' }, settings)).toBe(false)
    expect(isSplitEligible({ kind: 'text', text: 'x'.repeat(10) }, settings)).toBe(true)
  })

  it('is off when the setting is off', () => {
    expect(isSplitEligible({ kind: 'voice', text: 'x'.repeat(999) }, { splitOnIntake: false, splitMinChars: 0 })).toBe(false)
  })
})

describe('capture part context line', () => {
  it('names the position in the note in the capture language', () => {
    expect(capturePartContextLine({ index: 1, count: 3, captureId: 'c1' }, 'de'))
      .toBe('[Teil 2 von 3 einer Sprachnotiz; Original: capture c1]')
    expect(capturePartContextLine({ index: 0, count: 2, captureId: 'c1' }, 'en'))
      .toBe('[Part 1 of 2 of a voice note; original: capture c1]')
  })

  it('prefixes a part message and leaves a single part alone', () => {
    expect(withCapturePartPrefix('Das Dach tropft.', { index: 1, count: 2, captureId: 'c1' }))
      .toBe('[Teil 2 von 2 einer Sprachnotiz; Original: capture c1]\nDas Dach tropft.')
    expect(withCapturePartPrefix('Das Dach tropft.', { index: 0, count: 1, captureId: 'c1' })).toBe('Das Dach tropft.')
  })

  it('reads the marker back from metadata and ignores everything else', () => {
    expect(parseCapturePartRef(JSON.stringify({ capturePart: { index: 1, count: 2, captureId: 'c1' } })))
      .toEqual({ index: 1, count: 2, captureId: 'c1' })
    expect(parseCapturePartRef(null)).toBeNull()
    expect(parseCapturePartRef('{')).toBeNull()
    expect(parseCapturePartRef(JSON.stringify({ uploads: [] }))).toBeNull()
  })
})
