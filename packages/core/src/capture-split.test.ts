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
  findUncoveredSentences,
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

function stage1(
  topics: Array<{ id: string; title: string; sentenceIds: number[]; standalone?: boolean }>,
  splitConfidence = 0.9,
): string {
  return JSON.stringify({ topics, uncertain: [], splitConfidence, rationale: 'two unrelated matters' })
}

/**
 * A synthetic dictation, four matters, one of them a single sentence request
 * (the share price question). Written for this test, not taken from a real
 * note: fixtures never carry content of a live instance.
 */
const DICTATION_FOUR_MATTERS = `So, jetzt wollen wir das Ganze doch mal testen, ob du wirklich in der Lage bist, verschiedene
 zusammenhangslose Strands, die sich vermischen, in eigene Kategorien zu teilen.
 Also erstmal möchte ich dich bitten, mir den Wetterbericht für morgen zu nennen.
 Dann, was ich vergessen habe, wie steht Siemens heute und wie geht es da weiter?
 Achso, das Wetter für Hamburg, meine ich natürlich, hätte ich dazu sagen sollen.
 Und meinem Kollegen Alex, mit dem ich neulich über die Notiz-App gesprochen hatte, würde ich gerne in einer kurzen Nachricht zusammenfassen,
 welches Feature ich hier gerade teste und welches coole Feature diese App hat.
 Weil er sowas auch gut gebrauchen könnte, um unsortierte Gedanken zu sortieren.
 Was hatten wir denn noch?
 Irgendwas wollte ich noch von dir, aber ich komme gerade nicht drauf.
 Aber, ja, was wichtig ist, die Nachricht an Alex auf jeden Fall auf Englisch formulieren und von der Formulierung
 sehr locker, also sehr informell und umgangssprachlich.
 Nicht gestochen korrekt.
 Wollen wir doch mal schauen, wie viele Strands du hier rauskriegst.
 Also, einen Extra-Strand hätte ich gerne noch, wo du bewertest, wie das ganze Experiment hier ausgegangen ist.`

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
      { id: 'A', title: 'Dach', sentenceIds: [1, 2], standalone: false },
      { id: 'B', title: 'Meta', sentenceIds: [3], standalone: false },
      { id: 'C', title: 'Auto', sentenceIds: [4, 5], standalone: false },
    ]
    const merged = mergeTinyTopics(topics)
    expect(merged.map(t => t.id)).toEqual(['A', 'C'])
    expect(merged[0].sentenceIds).toEqual([1, 2, 3])
  })

  it('folds a leading one sentence topic forward', () => {
    const merged = mergeTinyTopics([
      { id: 'A', title: 'Gruss', sentenceIds: [1], standalone: false },
      { id: 'B', title: 'Dach', sentenceIds: [2, 3], standalone: false },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].sentenceIds).toEqual([1, 2, 3])
  })

  it('leaves a set of only tiny topics alone', () => {
    const topics: SplitTopic[] = [
      { id: 'A', title: 'x', sentenceIds: [1], standalone: false },
      { id: 'B', title: 'y', sentenceIds: [2], standalone: false },
    ]
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

describe('mergeTinyTopics with a standalone topic', () => {
  it('keeps a one sentence topic that carries its own request', () => {
    const topics: SplitTopic[] = [
      { id: 'A', title: 'Wetter', sentenceIds: [1, 2], standalone: false },
      { id: 'B', title: 'Aktienkurs', sentenceIds: [3], standalone: true },
      { id: 'C', title: 'Nachricht an Alex', sentenceIds: [4, 5], standalone: false },
    ]
    const merged = mergeTinyTopics(topics)
    expect(merged.map(t => t.id)).toEqual(['A', 'B', 'C'])
    expect(merged[1].sentenceIds).toEqual([3])
  })

  it('still folds a one sentence topic that is not standalone', () => {
    const topics: SplitTopic[] = [
      { id: 'A', title: 'Wetter', sentenceIds: [1, 2], standalone: false },
      { id: 'B', title: 'Korrektur', sentenceIds: [3], standalone: false },
      { id: 'C', title: 'Nachricht an Alex', sentenceIds: [4, 5], standalone: true },
    ]
    const merged = mergeTinyTopics(topics)
    expect(merged.map(t => t.id)).toEqual(['A', 'C'])
    expect(merged[0].sentenceIds).toEqual([1, 2, 3])
  })

  it('reads the flag out of a stage 1 answer and defaults it to false', () => {
    const parsed = parseStage1Answer(stage1([
      { id: 'A', title: 'Wetter', sentenceIds: [1, 2] },
      { id: 'B', title: 'Aktienkurs', sentenceIds: [3], standalone: true },
    ]), 3)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.answer.topics.map(t => t.standalone)).toEqual([false, true])
  })
})

describe('findUncoveredSentences', () => {
  it('names a sentence whose salient tokens are gone from the consolidated text', () => {
    const sentences = [
      'Also erstmal möchte ich dich bitten, mir den Wetterbericht für morgen zu nennen.',
      'Dann, was ich vergessen habe, wie steht Siemens heute und wie geht es da weiter?',
      'Achso, das Wetter für Hamburg, meine ich natürlich, hätte ich dazu sagen sollen.',
    ]
    const consolidated = 'Bitte nenne mir den Wetterbericht für morgen, für Hamburg, das hätte ich dazu sagen sollen.'
    expect(findUncoveredSentences(sentences, consolidated)).toEqual([1])
  })

  it('accepts a rewrite that keeps the names and numbers in other wording', () => {
    const sentences = ['Der Termin mit Alex ist am 3. Oktober.', 'Das Dach tropft seit Montag.']
    const consolidated = 'Das Dach tropft seit Montag, und der Termin mit Alex steht am 3. Oktober.'
    expect(findUncoveredSentences(sentences, consolidated)).toEqual([])
  })

  it('never flags a sentence without salient tokens', () => {
    expect(findUncoveredSentences(['was hatten wir denn noch?'], 'nichts davon')).toEqual([])
  })
})

describe('four matters, one single sentence request', () => {
  const sentenceOf = (n: number) => segmentSentences(DICTATION_FOUR_MATTERS)[n - 1]

  it('appends the share price question verbatim when stage 2 drops it', async () => {
    const s = stub([
      stage1([
        { id: 'A', title: 'Wetterbericht Hamburg', sentenceIds: [2, 3, 4] },
        { id: 'B', title: 'Nachricht an Alex', sentenceIds: [5, 6, 9, 10] },
        { id: 'C', title: 'Meta', sentenceIds: [1, 7, 8, 11, 12] },
      ], 0.92),
      // a stage 2 text that silently lost sentence 3
      'Bitte nenne mir den Wetterbericht für morgen, für Hamburg, das hätte ich dazu sagen sollen.',
      'Ich würde Alex gerne auf Englisch schreiben, sehr locker und informell.',
      'Wir testen, wie viele Strands dabei herauskommen, und ich hätte gerne einen Extra-Strand zur Bewertung.',
    ])
    const split = await runCaptureSplit(DICTATION_FOUR_MATTERS, { complete: s.complete })
    expect(split.parts).toHaveLength(3)
    expect(split.parts[0].text).toContain('Siemens')
    expect(split.parts[0].text).toBe(
      'Bitte nenne mir den Wetterbericht für morgen, für Hamburg, das hätte ich dazu sagen sollen. ' + sentenceOf(3),
    )
    expect(split.notes.some(n => n.includes('dropped'))).toBe(true)
  })

  it('keeps the standalone share price question as its own part', async () => {
    const s = stub([
      stage1([
        { id: 'A', title: 'Test der Strand-Trennung', sentenceIds: [1, 7, 8, 11, 12], standalone: false },
        { id: 'B', title: 'Wetterbericht Hamburg', sentenceIds: [2, 4], standalone: true },
        { id: 'C', title: 'Aktienkurs', sentenceIds: [3], standalone: true },
        { id: 'D', title: 'Nachricht an Alex', sentenceIds: [5, 6, 9, 10], standalone: true },
      ], 0.92),
      [1, 7, 8, 11, 12].map(sentenceOf).join(' '),
      'Bitte nenne mir den Wetterbericht für morgen, für Hamburg meine ich.',
      [5, 6, 9, 10].map(sentenceOf).join(' '),
    ])
    const split = await runCaptureSplit(DICTATION_FOUR_MATTERS, { complete: s.complete })
    expect(split.parts.map(p => p.sentenceIds)).toEqual([[1, 7, 8, 11, 12], [2, 4], [3], [5, 6, 9, 10]])
    expect(split.parts[2].text).toBe(sentenceOf(3))
    expect(split.parts[2].text).toContain('Siemens')
    expect(split.parts[1].text).toContain('Hamburg')
    expect(split.notes.some(n => n.includes('dropped'))).toBe(false)
    expect(split.notes.some(n => n.includes('merged'))).toBe(false)
  })
})

/**
 * A synthetic dictation, two matters plus a meta request, with a spoken
 * self-correction ("SQLite, Entschuldigung, DuckDB") and a transcription
 * artefact ("Open Sors") that stage 2 repairs. Written for this test.
 */
const DICTATION_TWO_MATTERS = `Es hat sich die letzten Tage, während ich mit anderen Dingen beschäftigt war, wieder einiges bei den Open-Source-Datenbanken getan.
 Das würde ich mir gerne im Detail anschauen.
 Und zwar hat PostgreSQL meines Wissens sowohl ein neues Major-Release als auch eine neue Erweiterung für Vektorsuche bekommen.
 Ich bin mir aber nicht sicher, ob das Open Sors ist und ob ich die Erweiterung lokal in einem Container nutzen kann.
 Und auch, ob die Migration aus der alten Version automatisch läuft.
 Also das wäre die erste Frage, bevor wir weitermachen.
 Schau mal bitte da rein, was wirklich relevant ist.
 Und sende mir eine Zusammenfassung direkt als kurze Liste, weil ich heute wenig Zeit habe.
 Und dann ein zweites Thema.
 Auch SQLite, Entschuldigung, DuckDB hat neue Versionen veröffentlicht.
 Und ich meine, da sind sogar schnelle Leichte mit dabei.
 Also es sind sehr leistungsfähige und ausgereifte mit dabei.
 Aber es sollten auch sehr schlanke Varianten dabei sein.
 Prüfe da bitte mal, ob die schlanken Varianten sparsamer sind als unsere aktuelle Analyse-Datenbank.
 Und schicke mir meine Testabfrage an.
 Du kannst direkt die Antwort auf deine Recherche als Textnachricht oder als kurze Tabelle senden,
 weil ich heute eh wenig Zeit habe.
 Und unabhängig davon kannst du gerne mal die neuen Versionen testen und schauen, wie sie sich schlagen.
 Also Speicherbedarf bewerten, Geschwindigkeit bewerten, Stabilität bewertet oder nicht.
 Genau, schau dir das mal an.
 Wie gesagt, ich erwarte, dass das Ganze hier in zwei Strands bearbeitet wird.
 Das sind zwei verschiedene Themen.`

describe('a self-correction must not trip the coverage check', () => {
  const STAGE2_TEXTS = [
    "Es hat sich die letzten Tage, während ich mit anderen Dingen beschäftigt war, wieder einiges bei den Open-Source-Datenbanken getan. Das würde ich mir gerne im Detail anschauen.\n\nUnd zwar hat PostgreSQL meines Wissens sowohl ein neues Major-Release als auch eine neue Erweiterung für Vektorsuche bekommen. Ich bin mir aber nicht sicher, ob das Open Source ist und ob ich die Erweiterung lokal in einem Container nutzen kann. Und auch, ob die Migration aus der alten Version automatisch läuft. Also das wäre die erste Frage, bevor wir weitermachen.\n\nSchau mal bitte da rein, was wirklich relevant ist. Und sende mir eine Zusammenfassung direkt als kurze Liste, weil ich heute wenig Zeit habe.",
    "DuckDB hat neue Versionen veröffentlicht. Da sind sogar schnelle, leichte Varianten mit dabei – also es sind sehr leistungsfähige und ausgereifte mit dabei, aber es sollten auch sehr schlanke Varianten dabei sein. Prüfe da bitte mal, ob die schlanken Varianten sparsamer sind als unsere aktuelle Analyse-Datenbank. Und schicke mir meine Testabfrage an. Du kannst direkt die Antwort auf deine Recherche als Textnachricht oder als kurze Tabelle senden, weil ich heute eh wenig Zeit habe. Und unabhängig davon kannst du gerne mal die neuen Versionen testen und schauen, wie sie sich schlagen. Also Speicherbedarf bewerten, Geschwindigkeit bewerten, Stabilität bewerten. Schau dir das mal an.",
    "Wie gesagt, ich erwarte, dass das Ganze hier in zwei Strands bearbeitet wird. Das sind zwei verschiedene Themen.",
  ]
  const TOPICS = [
    { id: 'A', title: "PostgreSQL-Release und Vektor-Erweiterung", sentenceIds: [1,2,3,4,5,6,7,8], standalone: true },
    { id: 'B', title: "Schlanke Analyse-Datenbanken prüfen", sentenceIds: [9,10,11,12,13,14,15,16,17,18,19], standalone: true },
    { id: 'C', title: "Meta: getrennte Bearbeitung beider Themen", sentenceIds: [20,21], standalone: true },
  ]

  it('segments into the expected sentence ids', () => {
    expect(segmentSentences(DICTATION_TWO_MATTERS)).toHaveLength(21)
  })

  it('does not flag the corrected-away name, only the dropped transition', () => {
    // "Auch SQLite, Entschuldigung, DuckDB ..." -> stage 2 kept DuckDB, dropped
    // SQLite: covered. "Und dann ein zweites Thema." -> its only salient token
    // is the noun "Thema", which stage 2 rightly removed: a false alarm.
    const sentences = segmentSentences(DICTATION_TWO_MATTERS)
    const flagged = TOPICS.map((topic, i) => {
      const own = topic.sentenceIds.map(n => sentences[n - 1])
      return findUncoveredSentences(own, STAGE2_TEXTS[i]).map(u => own[u])
    })
    expect(flagged).toEqual([[], ['Und dann ein zweites Thema.'], []])
    expect(STAGE2_TEXTS[1]).not.toContain('SQLite')
  })

  it('keeps the consolidated texts, a false alarm costs one appended sentence', async () => {
    const s = stub([stage1(TOPICS, 0.9), ...STAGE2_TEXTS])
    const split = await runCaptureSplit(DICTATION_TWO_MATTERS, { complete: s.complete })
    expect(split.parts.map(p => p.sentenceIds)).toEqual(TOPICS.map(t => t.sentenceIds))
    expect(split.parts[0].text).toBe(STAGE2_TEXTS[0])
    expect(split.parts[1].text).toBe(STAGE2_TEXTS[1] + ' Und dann ein zweites Thema.')
    expect(split.parts[2].text).toBe(STAGE2_TEXTS[2])
    expect(split.notes.filter(n => n.includes('dropped'))).toHaveLength(1)
  })
})
