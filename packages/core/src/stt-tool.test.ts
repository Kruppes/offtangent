import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import nodePath from 'node:path'

// Mock modules before importing the tool
vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: false, defaultAgentId: 'main' })),
  loadConfig: vi.fn(),
  ensureConfigTemplates: vi.fn(),
}))

vi.mock('./workspace.js', () => ({
  getWorkspaceDir: vi.fn(() => '/workspace'),
}))

vi.mock('./stt.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadSttSettings: vi.fn(),
    transcribeAudio: vi.fn(),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    default: {
      ...original.default as Record<string, unknown>,
      existsSync: vi.fn(),
      accessSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  }
})

import { createTranscribeAudioTool } from './stt-tool.js'
import { loadSttSettings, transcribeAudio } from './stt.js'

const mockLoadSttSettings = vi.mocked(loadSttSettings)
const mockTranscribeAudio = vi.mocked(transcribeAudio)
const mockExistsSync = vi.mocked(fs.existsSync)
const mockAccessSync = vi.mocked(fs.accessSync)
const mockReadFileSync = vi.mocked(fs.readFileSync)

// ── Tool creation ────────────────────────────────────────────────────

describe('createTranscribeAudioTool', () => {
  it('creates a tool with correct metadata', () => {
    const tool = createTranscribeAudioTool()
    expect(tool.name).toBe('transcribe_audio')
    expect(tool.label).toBe('Transcribe Audio')
    expect(tool.description).toBeTruthy()
    expect(tool.description).toContain('audio')
    expect(tool.description).toContain('speech-to-text')
    expect(tool.execute).toBeInstanceOf(Function)
  })

  it('has correct parameter schema', () => {
    const tool = createTranscribeAudioTool()
    const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] }
    expect(schema).toBeDefined()
    // Verify required and optional properties exist
    expect(schema.properties.path).toBeDefined()
    expect(schema.properties.language).toBeDefined()
    expect(schema.properties.rewrite).toBeDefined()
    expect(schema.required).toContain('path')
  })
})

// ── Execute — happy path ─────────────────────────────────────────────

describe('transcribe_audio execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('transcribes a valid mp3 file', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('fake-audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hello world, this is a transcription.' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'audio/recording.mp3' })

    expect(result.content[0].type).toBe('text')
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('Hello world, this is a transcription.')
    expect(result.details.path).toBe(nodePath.resolve('/workspace', 'audio/recording.mp3'))
    expect(result.details.filename).toBe('recording.mp3')
    expect(result.details.mimeType).toBe('audio/mpeg')
    expect(result.details.rewrite).toBe(false)

    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('fake-audio'), { language: undefined, filename: 'recording.mp3' })
  })

  it('transcribes a wav file with language parameter', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('fake-wav'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'Hallo Welt' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'audio.wav', language: 'de' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('Hallo Welt')
    expect(result.details.language).toBe('de')
    expect(result.details.mimeType).toBe('audio/wav')
    expect(mockTranscribeAudio).toHaveBeenCalledWith(Buffer.from('fake-wav'), { language: 'de', filename: 'audio.wav' })
  })

  it('passes rewrite flag in details when rewrite is requested and enabled', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: true, providerId: 'prov-1' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('fake-audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'um so like hello world', rewritten: 'hello world' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'test.ogg', rewrite: true })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('hello world')
    expect(result.details.rewrite).toBe(true)
  })

  it('does not set rewrite details when rewrite=false', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: true, providerId: 'prov-1' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('fake-audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'clean transcript' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'test.m4a', rewrite: false })

    expect(result.details.rewrite).toBe(false)
    expect(result.details.rewriteNote).toBeUndefined()
  })

  it('defaults rewrite to false when not specified', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('fake-audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'transcript text' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'test.flac' })

    expect(result.details.rewrite).toBe(false)
  })

  it('supports all audio extensions', async () => {
    const extensions = ['.mp3', '.wav', '.ogg', '.webm', '.m4a', '.flac']
    const expectedMimes = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac']

    for (let i = 0; i < extensions.length; i++) {
      vi.clearAllMocks()
      mockLoadSttSettings.mockReturnValue({
        enabled: true,
        provider: 'whisper-url',
        whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
        providerId: '',
        openaiModel: 'whisper-1',
      ollamaModel: '',
        deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
      })
      mockExistsSync.mockReturnValue(true)
      mockAccessSync.mockReturnValue(undefined)
      mockReadFileSync.mockReturnValue(Buffer.from('audio'))
      mockTranscribeAudio.mockResolvedValue({ transcript: 'text' })

      const tool = createTranscribeAudioTool()
      const result = await tool.execute('test-id', { path: `file${extensions[i]}` })

      expect(result.details.mimeType).toBe(expectedMimes[i])
      expect(result.details.error).toBeUndefined()
    }
  })
})

// ── Execute — error cases ────────────────────────────────────────────

describe('transcribe_audio error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error when STT is not enabled', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: false,
      provider: 'whisper-url',
      whisperUrl: '',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'test.mp3' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('not enabled')
    expect(result.details.error).toBe(true)
  })

  it('returns error when file does not exist', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(false)

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'nonexistent.mp3' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('File not found')
    expect(result.details.error).toBe(true)
  })

  it('returns error when file is not readable', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockImplementation(() => { throw new Error('EACCES') })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'protected.mp3' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('not readable')
    expect(result.details.error).toBe(true)
  })

  it('returns error for unsupported audio format', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'video.avi' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Unsupported audio format')
    expect(text).toContain('.avi')
    expect(text).toContain('.mp3')
    expect(result.details.error).toBe(true)
  })

  it('returns error when transcription fails', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('audio'))
    mockTranscribeAudio.mockRejectedValue(new Error('Whisper URL returned HTTP 500: Internal Server Error'))

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'bad.mp3' })

    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Error transcribing audio')
    expect(text).toContain('HTTP 500')
    expect(result.details.error).toBe(true)
  })

  it('handles absolute paths', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'transcript' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: '/tmp/audio.mp3' })

    expect(result.details.path).toBe('/tmp/audio.mp3')
    expect(result.details.error).toBeUndefined()
  })

  it('handles rewrite requested but rewrite not enabled in settings', async () => {
    mockLoadSttSettings.mockReturnValue({
      enabled: true,
      provider: 'whisper-url',
      whisperUrl: 'http://localhost:8000/v1/audio/transcriptions',
      providerId: '',
      openaiModel: 'whisper-1',
      ollamaModel: '',
      deepgramModel: 'nova-3',
      deepgramLanguage: '',
      rewrite: { enabled: false, providerId: '' },
    })
    mockExistsSync.mockReturnValue(true)
    mockAccessSync.mockReturnValue(undefined)
    mockReadFileSync.mockReturnValue(Buffer.from('audio'))
    mockTranscribeAudio.mockResolvedValue({ transcript: 'raw transcript' })

    const tool = createTranscribeAudioTool()
    const result = await tool.execute('test-id', { path: 'test.webm', rewrite: true })

    // When rewrite is not enabled in settings, should return raw transcript without rewrite
    const text = (result.content[0] as { type: 'text'; text: string }).text
    expect(text).toBe('raw transcript')
    expect(result.details.rewrite).toBe(false)
  })
})
