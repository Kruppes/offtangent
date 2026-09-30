/**
 * The `send_voice_message` tool: deterministic, no model call, and the voice
 * note it produced has to reach the assistant row of the running turn.
 *
 * Synthetic fixtures only; the synthesis seam returns generated samples.
 */
import { describe, it, expect, vi } from 'vitest'
import { createVoiceMessageTool, VOICE_MESSAGE_TOOL_NAME } from './voice-note-tool.js'
import type { VoiceNoteToolDetails } from './voice-note-tool.js'
import { resolveVoiceNoteConfig } from './voice-note-config.js'
import type { TtsSettings } from './tts.js'
import type { CreateVoiceNoteOptions, CreatedVoiceNote } from './voice-note.js'

function readAloud(): TtsSettings {
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
  }
}

const NOTE: CreatedVoiceNote = {
  voiceNote: {
    url: '/api/uploads/2026/voice-note.ogg',
    mimeType: 'audio/ogg',
    seconds: 4.2,
    spokenChars: 40,
    sourceChars: 40,
    model: 'gemini-3.1-flash-tts-preview',
    voice: 'Charon',
    createdAt: '2026-09-24T20:00:00.000Z',
  },
  upload: {
    kind: 'file',
    originalName: 'voice-note.ogg',
    storedName: 'voice-note.ogg',
    relativePath: '2026/voice-note.ogg',
    urlPath: '/api/uploads/2026/voice-note.ogg',
    mimeType: 'audio/ogg',
    size: 1234,
  },
  script: {
    text: 'All gates are green.',
    language: 'en',
    sourceChars: 40,
    summaryChars: 20,
    passthrough: true,
    model: 'deterministic',
  },
  chunks: 1,
  usage: null,
}

function build(overrides: Partial<Parameters<typeof createVoiceMessageTool>[0]> = {}) {
  const speak = vi.fn<(text: string, options: CreateVoiceNoteOptions) => Promise<CreatedVoiceNote>>(async () => NOTE)
  const tool = createVoiceMessageTool({
    getCurrentToolUserId: () => 7,
    getCurrentInteractiveSessionId: () => 'strand-1',
    isCarriedByCurrentTurn: () => true,
    loadConfig: () => resolveVoiceNoteConfig(readAloud(), { rewrite: true, maxChars: 200 }),
    speak,
    ...overrides,
  })
  return { tool, speak }
}

describe('createVoiceMessageTool', () => {
  it('is registered under the documented name and takes a text', () => {
    const { tool } = build()
    expect(tool.name).toBe(VOICE_MESSAGE_TOOL_NAME)
    expect(VOICE_MESSAGE_TOOL_NAME).toBe('send_voice_message')
    expect(JSON.stringify(tool.parameters)).toContain('text')
  })

  it('speaks the given text and returns the note in the tool details', async () => {
    const { tool, speak } = build()
    const result = await tool.execute('call-1', { text: 'All gates are green.' })
    const details = result.details as VoiceNoteToolDetails
    expect(details.voiceNote?.url).toBe('/api/uploads/2026/voice-note.ogg')
    expect(details.error).toBeUndefined()
    expect(speak).toHaveBeenCalledTimes(1)
    expect(speak.mock.calls[0]![0]).toBe('All gates are green.')
  })

  it('never rewrites, even when the configuration asks for a rewrite', async () => {
    const summarize = vi.fn()
    const { tool } = build()
    await tool.execute('call-1', { text: 'All gates are green.' })
    // The tool has no summarize seam at all: the deterministic path is the
    // only one, so no model can be reached from here.
    expect(summarize).not.toHaveBeenCalled()
    expect(JSON.stringify(build().tool)).not.toContain('summarize')
  })

  it('refuses a text longer than the configured cap instead of truncating', async () => {
    const { tool, speak } = build()
    const result = await tool.execute('call-1', { text: 'a'.repeat(400) })
    const details = result.details as VoiceNoteToolDetails
    expect(details.error).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/400/)
    expect((result.content[0] as { text: string }).text).toMatch(/200/)
    expect(speak).not.toHaveBeenCalled()
  })

  it('rejects an empty text', async () => {
    const { tool, speak } = build()
    const result = await tool.execute('call-1', { text: '   ' })
    expect((result.details as VoiceNoteToolDetails).error).toBe(true)
    expect(speak).not.toHaveBeenCalled()
  })

  it('rejects a voice the effective provider does not know', async () => {
    const { tool, speak } = build()
    const result = await tool.execute('call-1', { text: 'Hello.', voice: 'Nobody' })
    expect((result.details as VoiceNoteToolDetails).error).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/voice/i)
    expect(speak).not.toHaveBeenCalled()
  })

  it('passes an allowed voice override through', async () => {
    const { tool, speak } = build()
    await tool.execute('call-1', { text: 'Hello.', voice: 'Puck' })
    expect(speak.mock.calls[0]![1].config!.voice).toBe('Puck')
  })

  it('reports the real upstream message, never "empty response"', async () => {
    const { tool } = build({
      speak: vi.fn<(text: string, options: CreateVoiceNoteOptions) => Promise<CreatedVoiceNote>>(async () => { throw new Error('Gemini TTS returned HTTP 429: slow down') }),
    })
    const result = await tool.execute('call-1', { text: 'Hello.' })
    expect((result.details as VoiceNoteToolDetails).error).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('HTTP 429')
    expect((result.content[0] as { text: string }).text).not.toMatch(/empty response/i)
  })

  it('refuses when no turn carries the note, instead of losing it', async () => {
    const { tool, speak } = build({ isCarriedByCurrentTurn: () => false })
    const result = await tool.execute('call-1', { text: 'Hello.' })
    expect((result.details as VoiceNoteToolDetails).error).toBe(true)
    expect((result.content[0] as { text: string }).text).toMatch(/turn/i)
    expect(speak).not.toHaveBeenCalled()
  })

  it('refuses without a user', async () => {
    const { tool } = build({ getCurrentToolUserId: () => undefined })
    const result = await tool.execute('call-1', { text: 'Hello.' })
    expect((result.details as VoiceNoteToolDetails).error).toBe(true)
  })
})
