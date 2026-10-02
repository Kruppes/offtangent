import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SPEECH_AUDIO_PATH, SPEECH_SUMMARY_PATH, SPEECH_VOICE_NOTE_PATH,
  isOwnUploadPath, readVoiceNote, speechErrorKind, speechRequestBody, uploadSrc,
} from './speech'

const backend = path.resolve(__dirname, '../../../web-backend/src')
const route = readFileSync(path.join(backend, 'api/modules/speech/route.ts'), 'utf8')
const app = readFileSync(path.join(backend, 'app.ts'), 'utf8')
const schema = readFileSync(path.join(backend, 'api/modules/speech/schema.ts'), 'utf8')

describe('speech contract (pinned against the backend router, not a fake)', () => {
  it('uses the literal paths', () => {
    expect(SPEECH_AUDIO_PATH).toBe('/api/speech/audio')
    expect(SPEECH_SUMMARY_PATH).toBe('/api/speech/summary')
    expect(SPEECH_VOICE_NOTE_PATH).toBe('/api/speech/voice-note')
  })

  it('the backend mounts exactly these routes as POST', () => {
    expect(app).toContain("app.use('/api/speech', createSpeechRouter(")
    expect(route).toContain("router.post('/audio', controller.audio)")
    expect(route).toContain("router.post('/summary', controller.summary)")
    expect(route).toContain("router.post('/voice-note', controller.voiceNote)")
  })

  it('sends { messageId } for a stored message and { text } otherwise', () => {
    expect(speechRequestBody(42, 'ignored')).toEqual({ messageId: 42 })
    expect(speechRequestBody(undefined, 'Hello')).toEqual({ text: 'Hello' })
    expect(speechRequestBody(0, 'Hello')).toEqual({ text: 'Hello' })
    expect(speechRequestBody(1.5, 'Hello')).toEqual({ text: 'Hello' })
    // The parser reads exactly these two keys.
    expect(schema).toContain('const rawId = body.messageId')
    expect(schema).toContain('const rawText = body.text')
  })

  it('maps the documented error codes', () => {
    expect(speechErrorKind(503, 'tts_unconfigured')).toBe('unconfigured')
    expect(speechErrorKind(502, 'upstream')).toBe('upstream')
    expect(speechErrorKind(400, 'empty')).toBe('empty')
    expect(speechErrorKind(400, 'text_too_large')).toBe('tooLarge')
    expect(speechErrorKind(404, 'not_found')).toBe('notFound')
    expect(speechErrorKind(null)).toBe('network')
    expect(speechErrorKind(500, 'internal')).toBe('generic')
    for (const code of ['tts_unconfigured', 'upstream', 'not_found', 'text_too_large']) expect(route).toContain(code)
  })
})

describe('voice note metadata', () => {
  const note = { url: '/api/uploads/2026/01/01/abc-voice.wav', mimeType: 'audio/wav', seconds: 12.3, spokenChars: 200, sourceChars: 900, model: 'm', voice: 'v', createdAt: '2026-01-01T10:00:00.000Z', variant: 'summary' }

  it('accepts a stored note and drops fields the UI does not need', () => {
    expect(readVoiceNote(note)).toEqual({ url: note.url, mimeType: 'audio/wav', seconds: 12.3, spokenChars: 200, sourceChars: 900, createdAt: note.createdAt, variant: 'summary' })
  })

  it('refuses anything that is not our own upload store', () => {
    expect(readVoiceNote({ ...note, url: 'https://evil.example/a.wav' })).toBeNull()
    expect(readVoiceNote({ ...note, url: '//evil.example/a.wav' })).toBeNull()
    expect(readVoiceNote({ ...note, url: '/api/uploads/../secrets' })).toBeNull()
    expect(readVoiceNote({ ...note, url: 'javascript:alert(1)' })).toBeNull()
    expect(readVoiceNote(null)).toBeNull()
    expect(isOwnUploadPath('/api/uploads//evil.example')).toBe(false)
  })

  it('tolerates a missing duration', () => {
    expect(readVoiceNote({ url: note.url })?.seconds).toBe(0)
  })

  it('builds tokenised upload urls', () => {
    expect(uploadSrc('https://ot.example', note.url, 'jwt')).toBe('https://ot.example/api/uploads/2026/01/01/abc-voice.wav?token=jwt')
    expect(uploadSrc('', note.url, null, true)).toBe('/api/uploads/2026/01/01/abc-voice.wav?download=1')
  })
})

describe('voice note on a history row', () => {
  it('reads metadata.voiceNote of an answer (also one the app created) and ignores it on user rows', async () => {
    const { mapHistoryRows } = await import('~/composables/useChat')
    type Row = Parameters<typeof mapHistoryRows>[0][number]
    const voiceNote = { url: '/api/uploads/2026/01/01/abc-voice.wav', mimeType: 'audio/wav', seconds: 9, spokenChars: 120, sourceChars: 300, createdAt: '2026-01-01T10:00:00Z' }
    // Sorted by id: the question (id 1) comes first.
    const [question, answer] = mapHistoryRows([
      { id: 2, role: 'assistant', content: 'Answer', metadata: JSON.stringify({ voiceNote }), timestamp: '2026-01-01T10:00:00Z', session_id: 's' },
      { id: 1, role: 'user', content: 'Question', metadata: JSON.stringify({ voiceNote }), timestamp: '2026-01-01T09:59:00Z', session_id: 's' },
    ].reverse() as Row[])
    expect(question!.voiceNote).toBeUndefined()
    expect(answer!.voiceNote).toMatchObject({ url: voiceNote.url, seconds: 9 })
  })

  it('the backend persists it under exactly that metadata key', () => {
    const core = readFileSync(path.resolve(__dirname, '../../../core/src/voice-note.ts'), 'utf8')
    expect(core).toContain('const parsed = JSON.parse(existing) as { voiceNote?: unknown }')
    expect(core).toContain('const note = parsed?.voiceNote')
    const runner = readFileSync(path.join(backend, 'api/modules/speech/voice-note-runner.ts'), 'utf8')
    expect(runner).toContain('const existing = readVoiceNoteMetadata(target.metadata)')
    // The socket frame the client folds in: type `voice_note` with `messageId` + `voiceNote`.
    expect(app).toContain("type: 'voice_note',")
    expect(app).toContain('voiceNote: frame.voiceNote,')
  })
})
