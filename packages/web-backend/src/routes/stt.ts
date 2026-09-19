import { Router } from 'express'
import { loadConfig, ensureConfigTemplates, transcribeAudio, loadSttSettings, saveUpload, saveUploadFromFile } from '@axiom/core'
import type { UploadDescriptor } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { uploadSingle, readUploadedFile, cleanupRequestUploads } from '../uploads.js'

/**
 * A recording that has to be sent to a transcription API still has to fit into
 * memory once. Independent of the (much higher) attachment limit.
 */
const MAX_TRANSCRIBE_BYTES = 100 * 1024 * 1024

/** `keepAudio=1` (query or multipart field) asks for the recording to be kept. */
function wantsKeptAudio(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase())
}

export function createSttRouter(): Router {
  const router = Router()
  router.use(jwtMiddleware)

  /**
   * POST /api/stt/transcribe
   * Accepts a multipart audio file upload and returns a transcript.
   * Uses the configured STT provider (whisper-url, openai, ollama).
   *
   * With `keepAudio=1` (query string or multipart field) the recording is also
   * stored through the normal upload path and its descriptor comes back as
   * `audio`, so the caller can attach the spoken audio to the message that
   * carries the transcript (`POST /api/chat/message`, field `attachments`).
   * Without the flag nothing is written to disk, which is what Telegram and
   * the web client rely on.
   */
  router.post(
    '/transcribe',
    uploadSingle('file'),
    async (req: AuthenticatedRequest, res) => {
      try {
        const file = (req as AuthenticatedRequest & { file?: Express.Multer.File }).file
        if (!file || (!file.buffer && !file.path)) {
          res.status(400).json({ error: 'No audio file provided. Send a "file" field with multipart/form-data.' })
          return
        }

        let audio: Buffer
        try {
          audio = readUploadedFile(file, MAX_TRANSCRIBE_BYTES)
        } catch (err) {
          cleanupRequestUploads(req)
          res.status(413).json({ error: `Audio too large to transcribe: ${(err as Error).message}` })
          return
        }

        // Auto-resolve language from settings (unless "match" or "auto")
        ensureConfigTemplates()
        const settings = loadConfig<Record<string, unknown>>('settings.json')
        const settingsLanguage = (settings.language as string) ?? ''
        const autoLanguages = ['match', 'auto', '']
        const language = autoLanguages.includes(settingsLanguage.toLowerCase())
          ? undefined
          : settingsLanguage

        const result = await transcribeAudio(audio, { language, filename: file.originalname })
        const body: { transcript: string; rewritten?: string; audio?: UploadDescriptor } = {
          transcript: result.transcript,
        }
        if (result.rewritten !== undefined) {
          body.rewritten = result.rewritten
        }
        // Kept only after a successful transcription: a failed upload leaves no
        // file behind that no message would ever reference.
        const keepAudio = wantsKeptAudio(req.query.keepAudio) || wantsKeptAudio(req.body?.keepAudio)
        if (keepAudio) {
          body.audio = file.path
            ? saveUploadFromFile({
              sourcePath: file.path,
              originalName: file.originalname,
              mimeType: file.mimetype,
              source: 'web',
              userId: req.user?.userId ?? null,
            })
            : saveUpload({
              buffer: audio,
              originalName: file.originalname,
              mimeType: file.mimetype,
              source: 'web',
              userId: req.user?.userId ?? null,
            })
        } else {
          cleanupRequestUploads(req)
        }
        res.json(body)
      } catch (err) {
        cleanupRequestUploads(req)
        const message = (err as Error).message
        const status = message.includes('not enabled') ? 403 : 500
        res.status(status).json({ error: message })
      }
    },
  )

  /**
   * GET /api/stt/settings
   * Returns minimal STT settings so the frontend can check if STT is enabled.
   */
  router.get('/settings', (_req: AuthenticatedRequest, res) => {
    try {
      const settings = loadSttSettings()
      res.json({ enabled: settings.enabled })
    } catch {
      res.json({ enabled: false })
    }
  })

  return router
}
