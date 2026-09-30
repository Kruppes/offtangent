/**
 * The voice-note pipeline over the CONFIGURED route: provider agnostic
 * synthesis, the deterministic (`rewrite: false`) script, and the cap.
 *
 * Every fixture is synthetic: the synthesis seam returns a generated WAV.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  VoiceNoteTooLongError,
  VoiceNoteUnconfiguredError,
  VoiceNoteUpstreamError,
  buildVoiceNoteScript,
  createVoiceNote,
  speakVoiceNote,
  synthesizeVoiceNoteAudio,
} from './voice-note.js'
import { resolveVoiceNoteConfig } from './voice-note-config.js'
import type { EffectiveVoiceNoteConfig } from './voice-note-config.js'
import type { VoiceNoteSynthesizer } from './voice-note.js'
import { wrapPcmInWav } from './ogg-opus.js'
import type { TtsSettings } from './tts.js'

const SAMPLE_RATE = 24_000

function readAloud(overrides: Partial<TtsSettings> = {}): TtsSettings {
  return {
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
    ...overrides,
  }
}

function config(overrides: Partial<EffectiveVoiceNoteConfig> = {}): EffectiveVoiceNoteConfig {
  return { ...resolveVoiceNoteConfig(readAloud()), ...overrides }
}

/** A WAV buffer of `seconds` of a 220 Hz tone, as a provider would return it. */
function wav(seconds: number, amplitude = 8000): Buffer {
  const frames = Math.round(SAMPLE_RATE * seconds)
  const pcm = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((i / SAMPLE_RATE) * 2 * Math.PI * 220) * amplitude), i * 2)
  }
  return wrapPcmInWav(pcm, SAMPLE_RATE, 1, 16)
}

describe('synthesizeVoiceNoteAudio (configured route)', () => {
  it('speaks over the effective gemini route and encodes Ogg/Opus', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: wav(1), contentType: 'audio/wav' }))
    const result = await synthesizeVoiceNoteAudio('Two short sentences. That is all.', {
      config: config(),
      synthesize,
    })
    expect(result.mimeType).toBe('audio/ogg')
    expect(result.audio.subarray(0, 4).toString('ascii')).toBe('OggS')
    expect(result.seconds).toBeCloseTo(1, 1)
    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(synthesize.mock.calls[0]![0].config.provider).toBe('gemini')
    expect(synthesize.mock.calls[0]![0].format).toBe('wav')
  })

  it('speaks over an openai-compatible route with the same code', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: wav(0.5), contentType: 'audio/wav' }))
    const route = resolveVoiceNoteConfig(readAloud({ provider: 'openai', providerId: 'provider-openai' }))
    const result = await synthesizeVoiceNoteAudio('Hello there.', { config: route, synthesize })
    expect(synthesize.mock.calls[0]![0].config.provider).toBe('openai')
    expect(synthesize.mock.calls[0]![0].config.model).toBe('gpt-4o-mini-tts')
    expect(result.mimeType).toBe('audio/ogg')
  })

  it('keeps a non-wav container and reports its mime type', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: Buffer.from('ID3fake-mp3'), contentType: 'audio/mpeg' }))
    const result = await synthesizeVoiceNoteAudio('Hello there.', {
      config: config({ provider: 'openai', format: 'mp3' }),
      synthesize,
    })
    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.audio.toString('ascii')).toContain('ID3')
  })

  it('joins chunks with the pause and keeps one duration', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: wav(1), contentType: 'audio/wav' }))
    const long = `${'Alpha beta gamma delta. '.repeat(80)}`
    const result = await synthesizeVoiceNoteAudio(long, { config: config(), synthesize })
    expect(result.chunks).toBeGreaterThan(1)
    expect(synthesize).toHaveBeenCalledTimes(result.chunks)
    expect(result.seconds).toBeGreaterThan(result.chunks - 0.5)
  })

  it('turns a missing provider or key into the unconfigured error (503)', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => {
      throw new Error('Gemini TTS provider is not configured. Add a Google provider…')
    })
    await expect(synthesizeVoiceNoteAudio('Hello.', { config: config(), synthesize }))
      .rejects.toBeInstanceOf(VoiceNoteUnconfiguredError)
  })

  it('turns a failing voice into the upstream error (502) with the real message', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => { throw new Error('HTTP 500: upstream exploded') })
    await expect(synthesizeVoiceNoteAudio('Hello.', { config: config(), synthesize }))
      .rejects.toThrow(/upstream exploded/)
    await expect(synthesizeVoiceNoteAudio('Hello.', { config: config(), synthesize }))
      .rejects.toBeInstanceOf(VoiceNoteUpstreamError)
  })
})

describe('buildVoiceNoteScript', () => {
  it('runs the rewrite when the configuration asks for it', async () => {
    const summarize = vi.fn(async () => ({
      text: 'Spoken.', language: 'en' as const, sourceChars: 20, summaryChars: 7,
      passthrough: false, model: 'p:m',
    }))
    const script = await buildVoiceNoteScript('# Heading\n\nSome written answer.', {
      config: config({ rewrite: true }),
      summarize,
    })
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(script.text).toBe('Spoken.')
  })

  it('makes zero model calls when rewrite is off', async () => {
    const summarize = vi.fn()
    const source = [
      '# Heading',
      '',
      'The build is green. See https://example.invalid/report for details.',
      '',
      '```bash',
      'npm run build',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n')
    const script = await buildVoiceNoteScript(source, { config: config({ rewrite: false }), summarize })
    expect(summarize).not.toHaveBeenCalled()
    expect(script.model).toBe('deterministic')
    expect(script.text).toContain('The build is green')
    expect(script.text).not.toContain('npm run build')
    expect(script.text).not.toContain('example.invalid')
    expect(script.text).not.toContain('#')
    expect(script.text).not.toContain('|')
  })

  it('caps the deterministic text at maxChars on a sentence boundary', async () => {
    const summarize = vi.fn()
    const source = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota. Kappa lambda mu.'
    const script = await buildVoiceNoteScript(source, {
      config: config({ rewrite: false, maxChars: 40 }),
      summarize,
    })
    expect(summarize).not.toHaveBeenCalled()
    expect(script.text.length).toBeLessThanOrEqual(40)
    expect(script.text.endsWith('.')).toBe(true)
  })
})

describe('createVoiceNote', () => {
  it('reports the effective model and voice on the note', async () => {
    const note = await createVoiceNote('Short answer, spoken as it stands.', {
      config: config({ model: 'gemini-3.8-flash-lite-tts', voice: 'Charon', rewrite: false }),
      synthesize: async () => ({ audio: wav(0.4), contentType: 'audio/wav' }),
      store: (audio, fileName) => ({
        kind: 'file' as const,
        originalName: fileName,
        storedName: fileName,
        relativePath: `2026/${fileName}`,
        urlPath: `/api/uploads/${fileName}`,
        mimeType: 'audio/ogg',
        size: audio.length,
      }),
      now: () => new Date('2026-09-24T21:00:00.000Z'),
    })
    expect(note.voiceNote.model).toBe('gemini-3.8-flash-lite-tts')
    expect(note.voiceNote.voice).toBe('Charon')
    expect(note.voiceNote.mimeType).toBe('audio/ogg')
    expect(note.voiceNote.createdAt).toBe('2026-09-24T21:00:00.000Z')
  })
})

describe('speakVoiceNote', () => {
  const store = (audio: Buffer, fileName: string) => ({
    kind: 'file' as const,
    originalName: fileName,
    storedName: fileName,
    relativePath: `2026/${fileName}`,
    urlPath: `/api/uploads/${fileName}`,
    mimeType: 'audio/ogg',
    size: audio.length,
  })

  it('speaks exactly the given text without any model call', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: wav(0.3), contentType: 'audio/wav' }))
    const note = await speakVoiceNote('The release is out. Nothing else to do.', {
      config: config({ rewrite: true }),
      synthesize,
      store,
    })
    expect(synthesize.mock.calls[0]![0].text).toBe('The release is out. Nothing else to do.')
    expect(note.script.model).toBe('deterministic')
    expect(note.script.passthrough).toBe(true)
  })

  it('strips markdown before speaking', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>(async () => ({ audio: wav(0.3), contentType: 'audio/wav' }))
    await speakVoiceNote('**Done.** See `npm test`.', { config: config(), synthesize, store })
    expect(synthesize.mock.calls[0]![0].text).not.toContain('**')
    expect(synthesize.mock.calls[0]![0].text).not.toContain('`')
  })

  it('refuses a text over the cap instead of truncating it', async () => {
    const synthesize = vi.fn<VoiceNoteSynthesizer>()
    await expect(speakVoiceNote('a'.repeat(300), {
      config: config({ maxChars: 100 }),
      synthesize,
      store,
    })).rejects.toBeInstanceOf(VoiceNoteTooLongError)
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('refuses an empty text', async () => {
    await expect(speakVoiceNote('   ', { config: config(), store })).rejects.toThrow()
  })
})
