import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the config layer so loadTtsSettings / loadTtsDeepgramApiKey work
// without touching the real on-disk settings.json. We override the return
// values per test via `loadConfigMock.mockReturnValueOnce(...)` below.
vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(),
}))

// Mock Deepgram so we can assert chunk count and avoid real HTTP.
vi.mock('./deepgram.js', async () => {
  const actual = await vi.importActual<typeof import('./deepgram.js')>('./deepgram.js')
  return {
    ...actual,
    decryptDeepgramApiKey: vi.fn((s: string) => s),
    synthesizeDeepgram: vi.fn(async (text: string) => Buffer.from(`audio:${text.length}`)),
  }
})

// Provider config isn't exercised by the Deepgram path (it uses its own
// `tts.deepgramApiKey`), but `synthesizeTts` imports the module eagerly so
// we stub the loader to a no-op file.
vi.mock('./provider-config.js', async () => {
  const actual = await vi.importActual<typeof import('./provider-config.js')>('./provider-config.js')
  return {
    ...actual,
    loadProvidersDecrypted: vi.fn(() => ({ providers: [] })),
    getApiKeyForProvider: vi.fn(async () => 'test-key'),
  }
})

// Gemini: mock the REST call, keep the real Ogg/Opus encoder so the test
// proves the whole PCM → container path.
vi.mock('./gemini-tts.js', async () => {
  const actual = await vi.importActual<typeof import('./gemini-tts.js')>('./gemini-tts.js')
  return {
    ...actual,
    synthesizeGeminiPcm: vi.fn(async (req: { text: string }) => ({
      samples: new Int16Array(2400).fill(1000), // 100 ms at 24 kHz
      sampleRate: 24_000,
      channels: 1 as const,
      _text: req.text,
    })),
  }
})

import { loadConfig } from './config.js'
import { synthesizeDeepgram } from './deepgram.js'
import { synthesizeGeminiPcm } from './gemini-tts.js'
import { loadProvidersDecrypted } from './provider-config.js'
import { chunkTextForTts, composeGeminiPrompt, loadTtsSettings, synthesizeTts, TtsFormatError } from './tts.js'
import type { TtsResponseFormat } from './contracts/settings.js'

const loadConfigMock = vi.mocked(loadConfig)
const synthesizeDeepgramMock = vi.mocked(synthesizeDeepgram)
const synthesizeGeminiPcmMock = vi.mocked(synthesizeGeminiPcm)
const loadProvidersMock = vi.mocked(loadProvidersDecrypted)

function settingsFor(responseFormat: TtsResponseFormat) {
  return {
    tts: {
      enabled: true,
      provider: 'deepgram',
      providerId: '',
      responseFormat,
      deepgramModel: 'aura-2-thalia-en',
      deepgramApiKey: 'dg_test',
    },
  }
}

function mockSettings(responseFormat: TtsResponseFormat) {
  // `synthesizeTts` calls loadConfig twice: once via loadTtsSettings and
  // once via loadTtsDeepgramApiKey. Return the same payload both times.
  loadConfigMock.mockImplementation(() => settingsFor(responseFormat) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  synthesizeDeepgramMock.mockImplementation(async (text: string) => Buffer.from(`audio:${text.length}`))
})

describe('synthesizeTts (Deepgram chunking)', () => {
  it('sends 2000-char opus input in a single Deepgram call (no concat-unsafe chunking)', async () => {
    mockSettings('opus')
    const text = 'a'.repeat(2000)
    await expect(synthesizeTts(text)).resolves.toMatchObject({ extension: 'ogg' })
    // opus pages don't survive naive Buffer.concat(), so even though the
    // internal chunker (1900-char limit) would split this, we must call
    // Deepgram exactly once for inputs ≤2000 chars.
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('sends 1901-char flac input in a single Deepgram call (boundary just past chunk limit)', async () => {
    mockSettings('flac')
    const text = 'a'.repeat(1901)
    await expect(synthesizeTts(text)).resolves.toMatchObject({ extension: 'flac' })
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('never chunks opus/flac at or below the Deepgram hard limit (regression)', async () => {
    // Same multi-sentence text that *does* split for mp3/wav. Proves
    // opus/flac follow the single-call path purely on encoding, not
    // length.
    const sentence = `${'word '.repeat(76).trim()}. `
    const text = sentence.repeat(5) // > 1900 chunk limit but ≤ 2000
    expect(text.length).toBeGreaterThan(1900)
    expect(text.length).toBeLessThanOrEqual(2000)

    mockSettings('opus')
    await synthesizeTts(text)
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)

    synthesizeDeepgramMock.mockClear()
    mockSettings('flac')
    await synthesizeTts(text)
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('rejects opus input strictly longer than 2000 chars', async () => {
    mockSettings('opus')
    const text = 'a'.repeat(2001)
    await expect(synthesizeTts(text)).rejects.toThrow(/2001 chars \(>2000\)/)
    expect(synthesizeDeepgramMock).not.toHaveBeenCalled()
  })

  it('rejects flac input strictly longer than 2000 chars with an actionable message', async () => {
    mockSettings('flac')
    const text = 'a'.repeat(5000)
    await expect(synthesizeTts(text)).rejects.toThrow(/`mp3` and `wav`/)
    expect(synthesizeDeepgramMock).not.toHaveBeenCalled()
  })

  it('chunks long mp3 input across multiple Deepgram calls and concatenates the audio', async () => {
    mockSettings('mp3')
    // Build a multi-sentence text well above 2000 chars so the chunker
    // splits on sentence boundaries rather than the hard slice path.
    const sentence = `${'word '.repeat(80).trim()}. `
    const text = sentence.repeat(8) // ~3300 chars
    const result = await synthesizeTts(text)
    expect(synthesizeDeepgramMock.mock.calls.length).toBeGreaterThan(1)
    expect(result.extension).toBe('mp3')
    // Each call returns Buffer.from(`audio:${chunk.length}`); the result
    // is the concatenation of all chunks' audio.
    const expectedLen = synthesizeDeepgramMock.mock.calls
      .map(([chunk]) => Buffer.byteLength(`audio:${(chunk as string).length}`))
      .reduce((a, b) => a + b, 0)
    expect(result.audio.length).toBe(expectedLen)
  })

  it('chunks long wav input and wraps the concatenated PCM in a WAV header', async () => {
    mockSettings('wav')
    const sentence = `${'word '.repeat(80).trim()}. `
    const text = sentence.repeat(8)
    const result = await synthesizeTts(text)
    expect(synthesizeDeepgramMock.mock.calls.length).toBeGreaterThan(1)
    expect(result.contentType).toBe('audio/wav')
    expect(result.extension).toBe('wav')
    // RIFF/WAVE magic — proves we wrapped the concatenated PCM rather
    // than handing back raw bytes.
    expect(result.audio.slice(0, 4).toString()).toBe('RIFF')
    expect(result.audio.slice(8, 12).toString()).toBe('WAVE')
  })

  it('passes short opus input through unchanged (single Deepgram call, no rejection)', async () => {
    mockSettings('opus')
    const text = 'short hello'
    await expect(synthesizeTts(text)).resolves.toMatchObject({ contentType: 'audio/opus' })
    expect(synthesizeDeepgramMock).toHaveBeenCalledTimes(1)
  })

  it('resamples the linear16 PCM when a WAV sample rate is requested', async () => {
    mockSettings('mp3')
    // 12 PCM bytes = 6 frames at 24 kHz; 16 kHz keeps 4 of them.
    synthesizeDeepgramMock.mockImplementation(async () => Buffer.alloc(12, 7))
    const result = await synthesizeTts('Hallo Welt.', { format: 'wav', sampleRate: 16_000 })
    expect(result.contentType).toBe('audio/wav')
    expect(result.sampleRate).toBe(16_000)
    expect(result.audio.readUInt32LE(24)).toBe(16_000)
    expect(result.audio.length).toBe(44 + 4 * 2)
    expect(synthesizeDeepgramMock.mock.calls[0]![2]).toMatchObject({ encoding: 'linear16' })
  })

  it('keeps the native rate when no sample rate is requested', async () => {
    mockSettings('wav')
    synthesizeDeepgramMock.mockImplementation(async () => Buffer.alloc(12, 7))
    const result = await synthesizeTts('Hallo Welt.')
    expect(result.audio.readUInt32LE(24)).toBe(24_000)
    expect(result.sampleRate).toBeUndefined()
    expect(result.audio.length).toBe(44 + 12)
  })
})

describe('synthesizeTts (Gemini)', () => {
  const googleProvider = {
    id: 'g-1', name: 'Google', provider: 'google', providerType: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'enc', enabled: true,
  }

  function mockGeminiSettings(overrides: Record<string, unknown> = {}) {
    loadConfigMock.mockImplementation(() => ({
      tts: {
        enabled: true,
        provider: 'gemini',
        providerId: '',
        responseFormat: 'opus',
        geminiModel: 'gemini-3.1-flash-tts-preview',
        geminiVoice: 'Charon',
        geminiStyle: '',
        ...overrides,
      },
    }) as never)
    loadProvidersMock.mockReturnValue({ providers: [googleProvider] } as never)
  }

  it('returns Ogg/Opus built from the PCM Gemini delivered', async () => {
    mockGeminiSettings()
    const result = await synthesizeTts('Hallo Welt.')
    expect(result.contentType).toBe('audio/ogg')
    expect(result.extension).toBe('ogg')
    expect(result.audio.toString('ascii', 0, 4)).toBe('OggS')
    expect(result.audio.toString('ascii', 28, 36)).toBe('OpusHead')
    expect(synthesizeGeminiPcmMock).toHaveBeenCalledTimes(1)
    expect(synthesizeGeminiPcmMock.mock.calls[0]![0]).toMatchObject({
      text: 'Hallo Welt.',
      model: 'gemini-3.1-flash-tts-preview',
      voice: 'Charon',
      apiKey: 'test-key',
    })
  })

  it('returns WAV when the format is wav', async () => {
    mockGeminiSettings({ responseFormat: 'wav' })
    const result = await synthesizeTts('Hallo Welt.')
    expect(result.contentType).toBe('audio/wav')
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF')
    expect(result.audio.readUInt32LE(24)).toBe(24_000)
    expect(result.audio.length).toBe(44 + 2400 * 2)
  })

  it('refuses mp3 and flac with a hint instead of silently changing the format', async () => {
    mockGeminiSettings({ responseFormat: 'mp3' })
    await expect(synthesizeTts('x')).rejects.toThrow(/opus.*wav.*requested `mp3`/s)
    await expect(synthesizeTts('x')).rejects.toBeInstanceOf(TtsFormatError)
    expect(synthesizeGeminiPcmMock).not.toHaveBeenCalled()
  })

  it('lets a per-request format override the saved opus setting', async () => {
    mockGeminiSettings({ responseFormat: 'opus' })
    const result = await synthesizeTts('Hallo Welt.', { format: 'wav' })
    expect(result.contentType).toBe('audio/wav')
    expect(result.extension).toBe('wav')
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF')
    expect(result.audio.readUInt32LE(24)).toBe(24_000)
    expect(result.sampleRate).toBeUndefined()
  })

  it('refuses a per-request format the provider cannot build', async () => {
    mockGeminiSettings({ responseFormat: 'wav' })
    await expect(synthesizeTts('x', { format: 'mp3' })).rejects.toBeInstanceOf(TtsFormatError)
    expect(synthesizeGeminiPcmMock).not.toHaveBeenCalled()
  })

  it('resamples WAV to the requested rate and reports it back', async () => {
    mockGeminiSettings({ responseFormat: 'opus' })
    const result = await synthesizeTts('Hallo Welt.', { format: 'wav', sampleRate: 16_000 })
    expect(result.contentType).toBe('audio/wav')
    expect(result.sampleRate).toBe(16_000)
    // RIFF header: rate at byte 24, byte rate at 28, block align 32, bits 34.
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF')
    expect(result.audio.toString('ascii', 8, 12)).toBe('WAVE')
    expect(result.audio.readUInt32LE(24)).toBe(16_000)
    expect(result.audio.readUInt16LE(22)).toBe(1)
    expect(result.audio.readUInt16LE(34)).toBe(16)
    expect(result.audio.readUInt32LE(28)).toBe(16_000 * 2)
    // 100 ms of 24 kHz mono becomes 1600 frames at 16 kHz.
    expect(result.audio.length).toBe(44 + 1600 * 2)
  })

  it('ignores the sample rate for opus and for an out-of-range value', async () => {
    mockGeminiSettings({ responseFormat: 'opus' })
    const opus = await synthesizeTts('Hallo Welt.', { sampleRate: 16_000 })
    expect(opus.contentType).toBe('audio/ogg')
    expect(opus.sampleRate).toBeUndefined()

    const wav = await synthesizeTts('Hallo Welt.', { format: 'wav', sampleRate: 96_000 })
    expect(wav.audio.readUInt32LE(24)).toBe(24_000)
    expect(wav.sampleRate).toBeUndefined()
  })

  it('does not resample when the requested rate is already the native one', async () => {
    mockGeminiSettings({ responseFormat: 'wav' })
    const result = await synthesizeTts('Hallo Welt.', { sampleRate: 24_000 })
    expect(result.audio.readUInt32LE(24)).toBe(24_000)
    expect(result.sampleRate).toBeUndefined()
  })

  it('prepends the style hint and honours a per-call voice override', async () => {
    mockGeminiSettings({ geminiStyle: 'Sprich ruhig und deutlich:' })
    await synthesizeTts('Hallo Welt.', { voice: 'Kore' })
    expect(synthesizeGeminiPcmMock.mock.calls[0]![0]).toMatchObject({
      text: 'Sprich ruhig und deutlich:\n\nHallo Welt.',
      voice: 'Kore',
    })
  })

  it('lays unsaved settings over the stored ones for a single call', async () => {
    mockGeminiSettings({ enabled: false, geminiVoice: 'Charon', geminiStyle: '' })
    const result = await synthesizeTts('Hallo Welt.', {
      settings: { enabled: true, geminiVoice: 'Kore', geminiStyle: 'Fluestere:', responseFormat: 'wav' },
    })
    // The override switched TTS on, picked the voice/style and the container.
    expect(result.contentType).toBe('audio/wav')
    expect(synthesizeGeminiPcmMock.mock.calls[0]![0]).toMatchObject({
      text: 'Fluestere:\n\nHallo Welt.',
      voice: 'Kore',
    })
    // Nothing was written back: the stored settings still say disabled/Charon.
    expect(loadTtsSettings()).toMatchObject({ enabled: false, geminiVoice: 'Charon' })
  })

  it('splits long texts into paragraph-sized chunks and joins the PCM', async () => {
    mockGeminiSettings({ responseFormat: 'wav' })
    const sentence = `${'Wort '.repeat(60).trim()}. `
    const text = sentence.repeat(12) // ~3600 chars → 3 chunks of ≤1500
    const result = await synthesizeTts(text)
    expect(synthesizeGeminiPcmMock).toHaveBeenCalledTimes(3)
    for (const call of synthesizeGeminiPcmMock.mock.calls) {
      expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(1500)
    }
    expect(result.audio.length).toBe(44 + 3 * 2400 * 2)
  })

  it('finds the Google provider by type when no providerId is set', async () => {
    mockGeminiSettings()
    loadProvidersMock.mockReturnValue({ providers: [
      { id: 'o-1', name: 'OpenAI', provider: 'openai', providerType: 'openai', baseUrl: 'https://api.openai.com' },
      googleProvider,
    ] } as never)
    await synthesizeTts('x')
    expect(synthesizeGeminiPcmMock).toHaveBeenCalledTimes(1)
  })

  it('explains what to configure when no Google provider exists', async () => {
    mockGeminiSettings()
    loadProvidersMock.mockReturnValue({ providers: [] } as never)
    await expect(synthesizeTts('x')).rejects.toThrow(/Settings → Providers/)
  })
})

describe('chunkTextForTts / composeGeminiPrompt', () => {
  it('keeps short text whole and splits long text at sentence ends', () => {
    expect(chunkTextForTts('Kurz.', 100)).toEqual(['Kurz.'])
    const chunks = chunkTextForTts('Eins zwei drei. Vier fünf sechs! Sieben acht neun? Zehn.', 20)
    expect(chunks).toEqual(['Eins zwei drei.', 'Vier fünf sechs!', 'Sieben acht neun?', 'Zehn.'])
  })

  it('leaves the text alone without a style hint', () => {
    expect(composeGeminiPrompt('', 'Text')).toBe('Text')
    expect(composeGeminiPrompt('  ', 'Text')).toBe('Text')
    expect(composeGeminiPrompt('Flüstere:', 'Text')).toBe('Flüstere:\n\nText')
  })
})
