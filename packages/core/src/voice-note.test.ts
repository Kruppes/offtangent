/**
 * The voice-note pipeline without a provider: the rewrite step, the audio
 * assembly (chunking, pause, fade, duration) and the metadata merge.
 *
 * All fixtures are synthetic. The audio seam returns generated PCM, so the
 * test asserts the joining rules, not what a voice sounds like.
 */
import { describe, it, expect } from 'vitest'
import {
  VOICE_NOTE_MAX_CHARS,
  VOICE_NOTE_PAUSE_SECONDS,
  VoiceNoteUnconfiguredError,
  VoiceNoteUpstreamError,
  buildVoiceNotePrompt,
  buildVoiceNoteScript,
  createVoiceNote,
  mergeVoiceNoteMetadata,
  readVoiceNoteMetadata,
  speakVoiceNote,
  synthesizeVoiceNoteAudio,
  voiceNoteScriptRecord,
  estimateVoiceNoteUsage,
  voiceReplyHintFor,
  VOICE_REPLY_TURN_HINT,
  type VoiceNote,
} from './voice-note.js'
import { summarizeForSpeech } from './speech-summary.js'
import { resolveVoiceNoteConfig } from './voice-note-config.js'
import { wrapPcmInWav } from './ogg-opus.js'
import type { PcmAudio } from './ogg-opus.js'
import type { TtsSettings } from './tts.js'

/** Synthetic read-aloud settings; the voice note inherits this route. */
const READ_ALOUD: TtsSettings = {
  enabled: true,
  provider: 'gemini',
  providerId: 'provider-google',
  openaiModel: 'gpt-4o-mini-tts',
  openaiVoice: 'nova',
  openaiInstructions: '',
  mistralVoice: '',
  responseFormat: 'mp3',
  deepgramModel: 'aura-2-thalia-en',
  geminiModel: 'gemini-3.1-flash-tts-preview',
  geminiVoice: 'Charon',
  geminiStyle: '',
}
const CONFIG = resolveVoiceNoteConfig(READ_ALOUD)
const VOICE_NOTE_MODEL = CONFIG.model
const VOICE_NOTE_VOICE = CONFIG.voice

/** A provider answer: the tone above, in a WAV container. */
function toneWav(seconds: number, amplitude = 8000): { audio: Buffer; contentType: string } {
  const pcm = tone(seconds, amplitude)
  const bytes = Buffer.alloc(pcm.samples.length * 2)
  for (let i = 0; i < pcm.samples.length; i++) bytes.writeInt16LE(pcm.samples[i]!, i * 2)
  return { audio: wrapPcmInWav(bytes, pcm.sampleRate, pcm.channels, 16), contentType: 'audio/wav' }
}

const SAMPLE_RATE = 24_000

function tone(seconds: number, amplitude = 8000): PcmAudio {
  const samples = new Int16Array(Math.round(SAMPLE_RATE * seconds))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.round(Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220) * amplitude)
  }
  return { samples, sampleRate: SAMPLE_RATE, channels: 1 }
}

const NOTE: VoiceNote = {
  url: '/api/uploads/2026/voice-note.ogg',
  mimeType: 'audio/ogg',
  seconds: 9.3,
  spokenChars: 120,
  sourceChars: 900,
  model: VOICE_NOTE_MODEL,
  voice: VOICE_NOTE_VOICE,
  createdAt: '2026-09-24T10:00:00.000Z',
}

describe('buildVoiceNotePrompt', () => {
  it('names the language and forbids everything unspeakable', () => {
    const prompt = buildVoiceNotePrompt('de')
    expect(prompt).toContain('German')
    expect(prompt).toContain('no urls')
    expect(prompt).toContain(String(VOICE_NOTE_MAX_CHARS))
  })

  it('states the configured cap, aims below it and forbids unfinished lists', () => {
    const prompt = buildVoiceNotePrompt('de', 2000)
    expect(prompt).toContain('2000 characters is a hard limit')
    expect(prompt).toContain('about 1500 characters')
    expect(prompt).not.toContain(String(VOICE_NOTE_MAX_CHARS))
    expect(prompt).toContain('Never announce a list')
  })
})

describe('buildVoiceNoteScript', () => {
  it('passes a short answer through instead of asking a model', async () => {
    let calls = 0
    const result = await buildVoiceNoteScript('Der Lauf ist durch, alle Gates sind grün.', {
      config: CONFIG,
      summarize: (raw, options) => summarizeForSpeech(raw, {
        ...options,
        complete: async () => { calls += 1; return { text: 'nie benutzt', model: 'x:y' } },
      }),
    })

    expect(result.passthrough).toBe(true)
    expect(result.text).toBe('Der Lauf ist durch, alle Gates sind grün.')
    expect(calls).toBe(0)
  })

  it('keeps a medium answer (over the read-aloud budget) as it stands', async () => {
    // 900 characters: too long for the "summarize aloud" cap of 600, but well
    // inside the voice-note budget, so it is spoken as written.
    const raw = `${'Wir haben den Lauf beendet und dabei einiges gelernt. '.repeat(17)}`
    expect(raw.length).toBeGreaterThan(600)
    expect(raw.length).toBeLessThan(VOICE_NOTE_MAX_CHARS)

    const result = await buildVoiceNoteScript(raw, {
      config: CONFIG,
      summarize: (rawText, options) => summarizeForSpeech(rawText, {
        ...options,
        complete: async () => ({ text: 'nie benutzt', model: 'x:y' }),
      }),
    })
    expect(result.passthrough).toBe(true)
  })

  it('rewrites a long answer with the voice-message rules and the long budget', async () => {
    const raw = `Bericht. ${'Dieser Absatz beschreibt den Ablauf sehr ausführlich. '.repeat(60)}`
    let seenPrompt = ''
    const result = await buildVoiceNoteScript(raw, {
      config: CONFIG,
      summarize: (rawText, options) => summarizeForSpeech(rawText, {
        ...options,
        complete: async input => {
          seenPrompt = input.systemPrompt
          // 10 sentences: more than the read-aloud cap of 6, so the longer
          // sentence budget of a voice note is what is being checked here.
          return { text: 'Satz eins. '.repeat(10).trim(), model: 'test:model' }
        },
      }),
    })

    expect(seenPrompt).toContain('VOICE MESSAGE')
    expect(seenPrompt).toContain(`${CONFIG.maxChars} characters is a hard limit`)
    expect(result.passthrough).toBe(false)
    expect(result.text.match(/Satz eins\./g)).toHaveLength(10)
  })
})

describe('synthesizeVoiceNoteAudio', () => {
  it('joins the chunks with a pause, fades the edges and reports the duration', async () => {
    const spoken: string[] = []
    const text = `${'Erster Absatz mit einem vollständigen Satz. '.repeat(30)}\n\n${'Zweiter Absatz mit einem vollständigen Satz. '.repeat(30)}`

    const result = await synthesizeVoiceNoteAudio(text, {
      config: CONFIG,
      synthesize: async input => {
        spoken.push(input.text)
        expect(input.config.model).toBe(VOICE_NOTE_MODEL)
        expect(input.config.voice).toBe(VOICE_NOTE_VOICE)
        return toneWav(1)
      },
    })

    expect(spoken.length).toBeGreaterThan(1)
    // Two one-second chunks plus the pauses between them.
    const expected = spoken.length + (spoken.length - 1) * VOICE_NOTE_PAUSE_SECONDS
    expect(result.seconds).toBeCloseTo(expected, 1)
    expect(result.chunks).toBe(spoken.length)
    // Ogg container magic — a real file, not raw PCM.
    expect(result.audio.subarray(0, 4).toString('latin1')).toBe('OggS')
  })

  it('answers 503-material when the provider has no key', async () => {
    await expect(synthesizeVoiceNoteAudio('Hallo Welt.', {
      config: CONFIG,
      synthesize: async () => { throw new Error('No API key configured for this provider') },
    })).rejects.toBeInstanceOf(VoiceNoteUnconfiguredError)
  })

  it('answers 502-material when the voice fails', async () => {
    await expect(synthesizeVoiceNoteAudio('Hallo Welt.', {
      config: CONFIG,
      synthesize: async () => { throw new Error('boom') },
    })).rejects.toBeInstanceOf(VoiceNoteUpstreamError)
  })

  it('answers 502-material when the voice returns nothing', async () => {
    await expect(synthesizeVoiceNoteAudio('Hallo Welt.', {
      config: CONFIG,
      synthesize: async () => toneWav(0),
    })).rejects.toBeInstanceOf(VoiceNoteUpstreamError)
  })
})

describe('createVoiceNote', () => {
  it('stores the audio and describes it with the pinned model and voice', async () => {
    const stored: Array<{ bytes: number; name: string }> = []
    const created = await createVoiceNote('Der Lauf ist durch, alle Gates sind grün.', {
      config: CONFIG,
      summarize: (raw, options) => summarizeForSpeech(raw, {
        ...options,
        complete: async () => ({ text: 'nie benutzt', model: 'x:y' }),
      }),
      synthesize: async () => toneWav(2),
      store: (audio, fileName) => {
        stored.push({ bytes: audio.length, name: fileName })
        return {
          kind: 'file', originalName: fileName, storedName: fileName,
          relativePath: `2026/${fileName}`, urlPath: `/api/uploads/2026/${fileName}`,
          mimeType: 'audio/ogg', size: audio.length,
        }
      },
      now: () => new Date('2026-09-24T10:00:00.000Z'),
      fileNameHint: '4711',
    })

    expect(stored).toHaveLength(1)
    expect(stored[0]!.name).toBe('voice-note-4711.ogg')
    expect(created.voiceNote).toEqual({
      url: '/api/uploads/2026/voice-note-4711.ogg',
      mimeType: 'audio/ogg',
      seconds: 2,
      spokenChars: 41,
      sourceChars: 41,
      model: VOICE_NOTE_MODEL,
      voice: VOICE_NOTE_VOICE,
      createdAt: '2026-09-24T10:00:00.000Z',
      variant: 'full',
    })
  })
})

describe('mergeVoiceNoteMetadata', () => {
  it('keeps every existing key', () => {
    const existing = JSON.stringify({
      kind: 'answer',
      files: [{ urlPath: '/api/uploads/a.pdf' }],
      telegramDelivered: true,
    })
    const merged = JSON.parse(mergeVoiceNoteMetadata(existing, NOTE))

    expect(merged.kind).toBe('answer')
    expect(merged.files).toEqual([{ urlPath: '/api/uploads/a.pdf' }])
    expect(merged.telegramDelivered).toBe(true)
    expect(merged.voiceNote).toEqual(NOTE)
  })

  it('replaces an older note instead of nesting it', () => {
    const first = mergeVoiceNoteMetadata(null, NOTE)
    const second = mergeVoiceNoteMetadata(first, { ...NOTE, url: '/api/uploads/new.ogg' })
    expect(JSON.parse(second).voiceNote.url).toBe('/api/uploads/new.ogg')
  })

  it('stores the spoken script next to the note, and drops a stale one', () => {
    const script = voiceNoteScriptRecord({
      text: 'Gesprochen.', language: 'de', sourceChars: 2836, summaryChars: 11,
      passthrough: false, model: 'p:m', rounds: 2, draftChars: 1612, trimmed: false,
    })
    const withScript = JSON.parse(mergeVoiceNoteMetadata('{"kind":"answer"}', NOTE, script))
    expect(withScript.kind).toBe('answer')
    expect(withScript.voiceNoteScript).toEqual({
      text: 'Gesprochen.', model: 'p:m', passthrough: false, rounds: 2, draftChars: 1612, trimmed: false,
    })
    const replaced = JSON.parse(mergeVoiceNoteMetadata(JSON.stringify(withScript), NOTE))
    expect(replaced.voiceNoteScript).toBeUndefined()
  })

  it('survives metadata that is not a JSON object', () => {
    expect(JSON.parse(mergeVoiceNoteMetadata('not json at all', NOTE)).voiceNote).toEqual(NOTE)
    expect(JSON.parse(mergeVoiceNoteMetadata('[1,2,3]', NOTE)).voiceNote).toEqual(NOTE)
    expect(JSON.parse(mergeVoiceNoteMetadata(null, NOTE)).voiceNote).toEqual(NOTE)
  })
})

describe('readVoiceNoteMetadata', () => {
  it('reads a stored note back and ignores everything else', () => {
    expect(readVoiceNoteMetadata(mergeVoiceNoteMetadata(null, NOTE))).toEqual(NOTE)
    expect(readVoiceNoteMetadata(null)).toBeNull()
    expect(readVoiceNoteMetadata('{"files":[]}')).toBeNull()
    expect(readVoiceNoteMetadata('{"voiceNote":{"url":""}}')).toBeNull()
    expect(readVoiceNoteMetadata('kaputt')).toBeNull()
  })
})

describe('VoiceNote variant field', () => {
  const storeSeam = (audio: Buffer, fileName: string) => ({
    kind: 'file' as const, originalName: fileName, storedName: fileName,
    relativePath: `2026/${fileName}`, urlPath: `/api/uploads/2026/${fileName}`,
    mimeType: 'audio/ogg', size: audio.length,
  })

  it('carries variant:full when the source was short enough to speak as-is', async () => {
    const created = await createVoiceNote('All gates are green.', {
      config: CONFIG,
      summarize: (raw, options) => summarizeForSpeech(raw, {
        ...options,
        complete: async () => ({ text: 'never called', model: 'x:y' }),
      }),
      synthesize: async () => toneWav(1),
      store: storeSeam,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
    })
    expect(created.voiceNote.variant).toBe('full')
    expect(created.script.passthrough).toBe(true)
  })

  it('carries variant:summary when a summary model rewrote the text', async () => {
    const longRaw = `Report. ${'This paragraph explains the run in great detail. '.repeat(60)}`
    const created = await createVoiceNote(longRaw, {
      config: CONFIG,
      summarize: (raw, options) => summarizeForSpeech(raw, {
        ...options,
        complete: async () => ({ text: 'Gates are green.', model: 'test:model' }),
      }),
      synthesize: async () => toneWav(1),
      store: storeSeam,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
    })
    expect(created.voiceNote.variant).toBe('summary')
    expect(created.script.passthrough).toBe(false)
  })

  it('carries variant:summary when the deterministic script had to cut the answer', async () => {
    const longRaw = `Report. ${'This paragraph explains the run in great detail. '.repeat(60)}`
    const created = await createVoiceNote(longRaw, {
      config: { ...CONFIG, rewrite: false },
      synthesize: async () => toneWav(1),
      store: storeSeam,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
    })
    expect(created.script.passthrough).toBe(true)
    expect(created.script.trimmed).toBe(true)
    expect(created.voiceNote.variant).toBe('summary')
  })

  it('speakVoiceNote always carries variant:full', async () => {
    const created = await speakVoiceNote('All gates are green.', {
      config: CONFIG,
      synthesize: async () => toneWav(1),
      store: storeSeam,
      now: () => new Date('2026-09-24T10:00:00.000Z'),
    })
    expect(created.voiceNote.variant).toBe('full')
  })

  it('readVoiceNoteMetadata returns a note without variant and keeps the field absent', () => {
    const oldNote: VoiceNote = {
      url: '/api/uploads/2026/voice-note-old.ogg',
      mimeType: 'audio/ogg',
      seconds: 5.0,
      spokenChars: 80,
      sourceChars: 400,
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Charon',
      createdAt: '2025-01-01T00:00:00.000Z',
    }
    const doc = mergeVoiceNoteMetadata(null, oldNote)
    const read = readVoiceNoteMetadata(doc)
    expect(read).not.toBeNull()
    expect(read!.url).toBe(oldNote.url)
    expect('variant' in read!).toBe(false)
  })
})

describe('voiceReplyHintFor', () => {
  it('returns the hint only while the switch is on', async () => {
    const { initDatabase } = await import('./database.js')
    const { setVoiceRepliesEnabled } = await import('./user-settings.js')
    const db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'alice', 'x', 'admin')").run()

    expect(voiceReplyHintFor(db, 1)).toBeNull()
    setVoiceRepliesEnabled(db, 1, true)
    expect(voiceReplyHintFor(db, 1)).toBe(VOICE_REPLY_TURN_HINT)
    // Never a system-prompt block, and unmistakable about what not to do.
    expect(VOICE_REPLY_TURN_HINT).toContain('<voice_reply>')
    expect(VOICE_REPLY_TURN_HINT.toLowerCase()).toContain('do not record')
    expect(voiceReplyHintFor(db, null)).toBeNull()
    expect(voiceReplyHintFor(db, 2)).toBeNull()
    db.close()
  })
})

describe('estimateVoiceNoteUsage', () => {
  it('prices a minute of audio at the introductory rate', () => {
    const usage = estimateVoiceNoteUsage({ spokenChars: 800, seconds: 60, now: new Date('2026-09-24') })
    expect(usage.promptTokens).toBe(200)
    expect(usage.completionTokens).toBe(2400)
    // 200 * 0.5/1M + 2400 * 6/1M = 0.0145 USD, i.e. ~1.4 ct per minute.
    expect(usage.estimatedCost).toBeCloseTo(0.0145, 5)
  })

  it('uses the doubled price from 2027 on', () => {
    const usage = estimateVoiceNoteUsage({ spokenChars: 800, seconds: 60, now: new Date('2027-01-02') })
    expect(usage.estimatedCost).toBeCloseTo(0.029, 5)
  })
})
