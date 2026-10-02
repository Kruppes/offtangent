import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { INLINE_AUDIO_EXTENSIONS, INLINE_PDF_EXTENSIONS, INLINE_VIDEO_EXTENSIONS, attachmentMedia, isDictation } from './attachmentMedia'

const uploads = readFileSync(path.resolve(__dirname, '../../../web-backend/src/uploads.ts'), 'utf8')
const inlineBlock = uploads.slice(uploads.indexOf('const INLINE_CONTENT_TYPES'), uploads.indexOf('}', uploads.indexOf('const INLINE_CONTENT_TYPES')))

function file(name: string, mimeType: string) {
  return { kind: 'file', urlPath: `/api/uploads/2026/01/01/abc-${name}`, storedName: `abc-${name}`, originalName: name, mimeType }
}

describe('attachment media kind', () => {
  it('only offers extensions the backend serves inline (pinned against uploads.ts)', () => {
    for (const ext of [...INLINE_AUDIO_EXTENSIONS, ...INLINE_VIDEO_EXTENSIONS, ...INLINE_PDF_EXTENSIONS]) {
      expect(inlineBlock).toContain(`'${ext}':`)
    }
    expect(inlineBlock).toContain("'.pdf': 'application/pdf'")
  })

  it('classifies images, audio, video, pdf and plain files', () => {
    expect(attachmentMedia({ kind: 'image', urlPath: '/api/uploads/a.png' })).toBe('image')
    expect(attachmentMedia(file('tone.wav', 'audio/wav'))).toBe('audio')
    expect(attachmentMedia(file('clip.mp4', 'video/mp4'))).toBe('video')
    expect(attachmentMedia(file('doc.pdf', 'application/pdf'))).toBe('pdf')
    expect(attachmentMedia(file('app.apk', 'application/octet-stream'))).toBe('file')
  })

  it('splits the ambiguous .webm by mime type', () => {
    expect(attachmentMedia(file('recording.webm', 'audio/webm'))).toBe('audio')
    expect(attachmentMedia(file('screen.webm', 'video/webm'))).toBe('video')
  })

  it('never previews a type the server would only send as a download', () => {
    expect(attachmentMedia(file('tone.aac', 'audio/aac'))).toBe('file')
    expect(attachmentMedia(file('movie.mkv', 'video/x-matroska'))).toBe('file')
    expect(attachmentMedia(file('page.html', 'text/html'))).toBe('file')
    expect(attachmentMedia(file('fake.pdf.exe', 'application/pdf'))).toBe('file')
  })

  it('falls back to the extension without a mime type', () => {
    expect(attachmentMedia(file('tone.mp3', ''))).toBe('audio')
    expect(attachmentMedia(file('clip.mov', ''))).toBe('video')
  })

  it('treats an audio file on a user message as a kept dictation', () => {
    expect(isDictation(file('recording.webm', 'audio/webm'), 'user')).toBe(true)
    expect(isDictation(file('recording.webm', 'audio/webm'), 'assistant')).toBe(false)
    expect(isDictation(file('doc.pdf', 'application/pdf'), 'user')).toBe(false)
  })
})
