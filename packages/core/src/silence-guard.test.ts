/**
 * The silence guard, pinned from both sides.
 *
 * The incident: seven of the ten captures the product owner could not get rid
 * of read `* Musik *` — Whisper's answer to a microphone that recorded
 * nothing, routed by a model and parked in the tray as a real thought.
 *
 * The opposite risk is worse than the bug: a guard that eats a real sentence
 * loses a thought silently. So every "this is speech" case below is as
 * important as the artefacts.
 */
import { describe, it, expect } from 'vitest'
import { isSilenceTranscript } from './silence-guard.js'

describe('isSilenceTranscript', () => {
  it('catches the annotation Whisper writes for a silent recording', () => {
    for (const text of [
      '* Musik *',
      '*Musik*',
      '[Musik]',
      '(Music)',
      '[ Applaus ]',
      '{Geräusche}',
      '<Stille>',
      '♪',
      '♪♪',
      '* Musik *  ',
      // German silence, taken from the live tray.
      'Vielen Dank.',
      'Tschüss.',
      'Untertitelung des ZDF, 2020',
      'Copyright WDR 2021',
      'Untertitel im Auftrag des ZDF für funk, 2017',
    ]) {
      expect(isSilenceTranscript(text), text).toBe(true)
    }
  })

  it('catches the bare artefacts of a silent clip, punctuation and umlauts aside', () => {
    for (const text of [
      'Thank you.',
      'thank you',
      'Thank you very much.',
      'Thanks for watching!',
      'Untertitel der Amara.org-Community',
      'Untertitelung des ZDF für funk',
      'Subtitles by the amara.org community',
    ]) {
      expect(isSilenceTranscript(text), text).toBe(true)
    }
  })

  it('treats an empty or whitespace-only transcript as silence', () => {
    expect(isSilenceTranscript('')).toBe(true)
    expect(isSilenceTranscript('   \n ')).toBe(true)
  })

  it('leaves speech alone, even when it talks about music', () => {
    for (const text of [
      'Musik aufnehmen für den Film',
      // Credits need a broadcaster to count; this is a real thought.
      'Copyright für die Reliefkarten klären',
      'Untertitel für das Video selber schreiben und einsprechen lassen',
      'Musik',
      'Die Musik war zu laut',
      '[Musik] und dann der Plan für morgen',
      'Ich sollte mich bei ihm bedanken, thank you war zu wenig',
      '(Für die Nordseite 4200 Euro, aber nur wenn das Gerüst schon steht und der Termin hält)',
      'Thank you for the roof quote, we should compare it',
    ]) {
      expect(isSilenceTranscript(text), text).toBe(false)
    }
  })

  it('does not treat a long parenthesis as an annotation', () => {
    const long = `(${'x'.repeat(41)})`
    expect(isSilenceTranscript(long)).toBe(false)
  })
})
