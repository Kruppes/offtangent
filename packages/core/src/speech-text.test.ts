import { describe, it, expect } from 'vitest'
import {
  SPEECH_SOURCE_CAP,
  cleanSpokenText,
  detectSpeechLanguage,
  limitSpokenSentences,
  sanitizeSpeechSource,
} from './speech-text.js'

/** Everything a TTS voice must never pronounce. */
const FORBIDDEN = /[#*_|`~]|\bhttps?:|\p{Extended_Pictographic}/u

describe('sanitizeSpeechSource', () => {
  it('drops fenced code blocks, including an unterminated one', () => {
    const source = [
      'Der Build ist grün.',
      '```ts',
      'const answer = 42',
      '```',
      'Danach kommt der Deploy.',
      '```sh',
      'npm run build',
    ].join('\n')
    const out = sanitizeSpeechSource(source)
    expect(out).toContain('Der Build ist grün.')
    expect(out).toContain('Danach kommt der Deploy.')
    expect(out).not.toContain('const answer')
    expect(out).not.toContain('npm run build')
  })

  it('flattens a markdown table into spoken rows and drops the separator', () => {
    const source = [
      'Ergebnis:',
      '| Gate | Baseline | Final |',
      '|---|---:|:--|',
      '| Tests | 0 | 0 |',
      '| Lint | 3 | 0 |',
    ].join('\n')
    const out = sanitizeSpeechSource(source)
    expect(out).not.toContain('|')
    expect(out).toContain('Gate, Baseline, Final.')
    expect(out).toContain('Tests, 0, 0.')
    expect(out).toContain('Lint, 3, 0.')
  })

  it('drops log lines and tool dumps but keeps the prose around them', () => {
    const source = [
      'Der Container läuft.',
      '2026-09-16T04:12:01.221Z GET /api/health 200',
      '[ERROR] connection reset by peer',
      'D/OffTangent( 1234): speech failed',
      '<tool_result>{"ok":true,"rows":12345}</tool_result>',
      'Nächster Schritt ist der Smoke.',
    ].join('\n')
    const out = sanitizeSpeechSource(source)
    expect(out).toContain('Der Container läuft.')
    expect(out).toContain('Nächster Schritt ist der Smoke.')
    expect(out).not.toContain('api/health')
    expect(out).not.toContain('connection reset')
    expect(out).not.toContain('tool_result')
  })

  it('caps the source and cuts on a line boundary', () => {
    const line = 'Dies ist eine ganz normale Zeile mit Inhalt und Aussage.\n'
    const out = sanitizeSpeechSource(line.repeat(600))
    expect(out.length).toBeLessThanOrEqual(SPEECH_SOURCE_CAP)
    expect(out.length).toBeGreaterThan(SPEECH_SOURCE_CAP * 0.6)
    expect(out.endsWith('.')).toBe(true)
  })

  it('returns an empty string for an empty input', () => {
    expect(sanitizeSpeechSource('')).toBe('')
    expect(sanitizeSpeechSource('```\ncode only\n```')).toBe('')
  })
})

describe('cleanSpokenText', () => {
  it('removes markdown, emoji, urls, paths and hashes', () => {
    const raw = [
      '## ✅ Ergebnis',
      '',
      '- **Alle Gates grün** (siehe oben)',
      '- Commit `3d008ed` liegt auf `main`, Datei `packages/web-backend/src/app.ts`',
      '- Details unter https://offtangent.example.com/api/health und files.example.com',
    ].join('\n')
    const out = cleanSpokenText(raw)
    expect(out).not.toMatch(FORBIDDEN)
    expect(out).not.toContain('3d008ed')
    expect(out).not.toContain('example.com')
    expect(out).not.toContain('siehe oben')
    expect(out).not.toContain('/api/health')
    expect(out).toContain('Ergebnis')
    expect(out).toContain('Alle Gates grün')
  })

  it('keeps the label of a markdown link and drops its target', () => {
    const out = cleanSpokenText('Mehr dazu im [Deploy-Report](https://example.com/report.md).')
    expect(out).toContain('Deploy-Report')
    expect(out).not.toContain('example')
    expect(out).not.toContain('http')
  })

  it('collapses a table into one spoken line without pipes', () => {
    const out = cleanSpokenText('| Gate | Wert |\n| Tests | grün |')
    expect(out).not.toContain('|')
    expect(out).toContain('Gate')
    expect(out).toContain('grün')
  })

  it('normalizes whitespace into one line', () => {
    const out = cleanSpokenText('Erste Zeile.\n\n\nZweite   Zeile.\n')
    expect(out).toBe('Erste Zeile. Zweite Zeile.')
  })

  it('keeps an already spoken sentence untouched', () => {
    const spoken = 'Der Deploy ist durch und alle Gates sind grün.'
    expect(cleanSpokenText(spoken)).toBe(spoken)
  })

  it('returns an empty string when nothing speakable is left', () => {
    expect(cleanSpokenText('')).toBe('')
    expect(cleanSpokenText('### \n\n- \n| | |\n')).toBe('')
    expect(cleanSpokenText('🎉✅')).toBe('')
  })
})

describe('detectSpeechLanguage', () => {
  it('detects German prose', () => {
    expect(detectSpeechLanguage('Der Deploy ist durch und alle Gates sind grün.')).toBe('de')
  })

  it('detects English prose', () => {
    expect(detectSpeechLanguage('The deploy is done and all gates are green for this release.')).toBe('en')
  })

  it('uses umlauts as evidence in a short German sentence', () => {
    expect(detectSpeechLanguage('Größe geprüft, Umzug fertig.')).toBe('de')
  })

  it('falls back to German without any evidence', () => {
    expect(detectSpeechLanguage('')).toBe('de')
    expect(detectSpeechLanguage('12345 67890')).toBe('de')
  })

  it('keeps German prose German even when it is full of English tech terms', () => {
    const text = 'Der Deploy ist durchgelaufen. Ich habe den Branch per Squash Merge auf main '
      + 'gebracht, der Build ist grün und der Container läuft healthy. Die Gates Test, Lint, '
      + 'Build und Gitleaks sind alle grün.'
    expect(detectSpeechLanguage(text)).toBe('de')
  })

  it('does not let German names and umlauts outvote an English sentence', () => {
    const text = 'Müller and Schröder from Köln, Düsseldorf and Zürich confirmed the order. '
      + 'Grüße were exchanged, the invoice follows next week.'
    expect(detectSpeechLanguage(text)).toBe('en')
  })

  it('reads a one-word status line in the language it is written in', () => {
    expect(detectSpeechLanguage('Done.')).toBe('en')
    expect(detectSpeechLanguage('Fertig.')).toBe('de')
  })

  it('detects a short English line that carries no classic stopword', () => {
    expect(detectSpeechLanguage('Deploy finished, container healthy.')).toBe('en')
  })

  it('still tips to German for a short umlaut line without stopwords', () => {
    expect(detectSpeechLanguage('Grüße, Größe geprüft.')).toBe('de')
  })

  it('follows the dominant half of a mixed message', () => {
    const germanHeavy = 'Ich habe den Server neu gestartet und die Logs geprüft. The container is up.'
    const englishHeavy = 'I restarted the server and checked the logs, all of them are clean. Bitte testen.'
    expect(detectSpeechLanguage(germanHeavy)).toBe('de')
    expect(detectSpeechLanguage(englishHeavy)).toBe('en')
  })

  it('falls back to German for a language the contract does not know', () => {
    // Only de and en exist in the response; French scores no markers and lands
    // on the instance default rather than inventing a third value.
    expect(detectSpeechLanguage('Le déploiement est terminé et le conteneur fonctionne.')).toBe('de')
  })
})

describe('limitSpokenSentences', () => {
  it('keeps at most six sentences', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Satz nummer ${i + 1}.`).join(' ')
    const out = limitSpokenSentences(text)
    expect(out.match(/\./g)?.length).toBe(6)
    expect(out.startsWith('Satz nummer 1.')).toBe(true)
    expect(out).not.toContain('nummer 7')
  })

  it('stays inside the character budget and ends on a sentence', () => {
    const long = `${'Dies ist ein sehr ausführlicher Satz über den Deploy. '.repeat(40)}`
    const out = limitSpokenSentences(long)
    expect(out.length).toBeLessThanOrEqual(700)
    expect(out.endsWith('.')).toBe(true)
  })

  it('cuts a single oversized sentence on a word boundary', () => {
    const out = limitSpokenSentences(`${'wort '.repeat(400)}ende`)
    expect(out.length).toBeLessThanOrEqual(701)
    expect(out.endsWith('.')).toBe(true)
    expect(out).not.toMatch(/\s\.$/)
  })

  it('does not break version numbers into sentences', () => {
    const text = 'Der Vorschlag für 0.7.3 steht. Das Release 0.9.9.1 kommt danach. Ende.'
    expect(limitSpokenSentences(text)).toBe(text)
  })

  it('keeps an abbreviation inside its sentence', () => {
    const text = 'Sie enthält z. B. den Fix für den Deploy. Danach ist Schluss.'
    expect(limitSpokenSentences(text, 2)).toBe(text)
  })

  it('does not invent a second sentence', () => {
    expect(limitSpokenSentences('Alles grün.')).toBe('Alles grün.')
  })

  it('adds a closing period to an unterminated answer', () => {
    expect(limitSpokenSentences('Alles grün')).toBe('Alles grün.')
  })
})
