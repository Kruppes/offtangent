/**
 * How an attachment is shown (W4b media viewer, P3).
 *
 * The backend decides by FILE EXTENSION whether an upload is served inline
 * (`INLINE_CONTENT_TYPES` in `web-backend/src/uploads.ts`); everything else
 * is `application/octet-stream` + `Content-Disposition: attachment`, which no
 * <audio>/<video>/<object> could show. So the viewer only offers what the
 * server will actually render inline: the extension must be on that list and
 * the declared mime type picks audio vs. video (a dictation `.webm` is audio).
 */

export type AttachmentMedia = 'image' | 'audio' | 'video' | 'pdf' | 'file'

/** Mirror of the inline extensions of `uploads.ts` that the viewer uses. */
export const INLINE_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.oga', '.ogg', '.opus', '.wav', '.flac', '.webm'] as const
export const INLINE_VIDEO_EXTENSIONS = ['.webm', '.mp4', '.m4v', '.mov'] as const
export const INLINE_PDF_EXTENSIONS = ['.pdf'] as const

export interface AttachmentLike {
  kind: string
  urlPath: string
  storedName?: string
  originalName?: string
  mimeType?: string
}

function extensionOf(name: string): string {
  const base = name.split('?')[0]!.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function attachmentMedia(attachment: AttachmentLike): AttachmentMedia {
  if (attachment.kind === 'image') return 'image'
  const ext = extensionOf(attachment.storedName || attachment.urlPath)
  const mime = (attachment.mimeType ?? '').toLowerCase()
  const audioExt = (INLINE_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
  const videoExt = (INLINE_VIDEO_EXTENSIONS as readonly string[]).includes(ext)
  if (audioExt && mime.startsWith('audio/')) return 'audio'
  if (videoExt && mime.startsWith('video/')) return 'video'
  // No (or a generic) mime type: the extension alone decides, video wins
  // for the ambiguous `.webm` only when the type says so.
  if (audioExt && !videoExt) return 'audio'
  if (videoExt && !audioExt) return 'video'
  if ((INLINE_PDF_EXTENSIONS as readonly string[]).includes(ext)) return 'pdf'
  return 'file'
}

/** A kept dictation is an audio file on a user message (keepAudio=1). */
export function isDictation(attachment: AttachmentLike, role: string | undefined): boolean {
  return role === 'user' && attachmentMedia(attachment) === 'audio'
}
