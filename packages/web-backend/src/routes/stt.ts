import { Router, raw } from 'express'
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

/**
 * Raw PCM the puck streams while it is still recording: 16 kHz mono, signed
 * 16 bit little endian. The rate may be overridden per request, the rest is
 * fixed - it is the one format the device produces.
 */
const RAW_DEFAULT_RATE = 16000
const RAW_MIN_RATE = 8000
const RAW_MAX_RATE = 48000
/** A quarter of a second of audio; below that there is nothing to transcribe. */
const RAW_MIN_BYTES = 8000

/**
 * Builds a canonical 44 byte WAV header for mono 16 bit PCM. The device cannot
 * write one itself while it streams: when the first byte goes out nobody knows
 * yet how long the recording will be, and the two size fields of a WAV header
 * sit at the very front. So the device sends the samples and the server puts
 * the header in front of them, where the length is finally known.
 */
export function buildWavHeader(pcmBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcmBytes, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)        // PCM subchunk size
  header.writeUInt16LE(1, 20)         // format: PCM
  header.writeUInt16LE(1, 22)         // channels: mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)  // byte rate
  header.writeUInt16LE(2, 32)         // block align
  header.writeUInt16LE(16, 34)        // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcmBytes, 40)
  return header
}

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
   * POST /api/stt/transcribe-raw
   * Body: raw PCM (16 bit signed little endian, mono), `Content-Type:
   * application/octet-stream`, sent with `Transfer-Encoding: chunked` by a
   * device that starts uploading before it has stopped recording.
   * Query: `rate` (default 16000).
   *
   * Why this exists next to /transcribe: the multipart route needs a complete
   * file, and a complete file needs a WAV header, and a WAV header needs the
   * length of a recording that is still running. The puck (BLE keyboard
   * dictation) would otherwise have to wait for the speaker to stop before the
   * first byte can go out - measured at 12 s of upload for 20 s of speech on a
   * weak link. Here the bytes travel while they are spoken and the server
   * writes the header once the stream ends.
   *
   * Nothing is stored: this route has no keepAudio. It answers `transcript`
   * exactly like /transcribe does.
   */
  router.post(
    '/transcribe-raw',
    raw({ type: () => true, limit: MAX_TRANSCRIBE_BYTES }),
    async (req: AuthenticatedRequest, res) => {
      try {
        const body: unknown = req.body
        if (!Buffer.isBuffer(body) || body.length < RAW_MIN_BYTES) {
          res.status(400).json({
            error: `Raw audio too short: send at least ${RAW_MIN_BYTES} bytes of 16 bit PCM as application/octet-stream.`,
          })
          return
        }
        const wanted = Number.parseInt(String(req.query.rate ?? ''), 10)
        const rate = Number.isFinite(wanted) && wanted >= RAW_MIN_RATE && wanted <= RAW_MAX_RATE
          ? wanted
          : RAW_DEFAULT_RATE
        // An odd byte count would shift every sample by one byte; drop the tail.
        const pcm = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1)
        const wav = Buffer.concat([buildWavHeader(pcm.length, rate), pcm])

        ensureConfigTemplates()
        const settings = loadConfig<Record<string, unknown>>('settings.json')
        const settingsLanguage = (settings.language as string) ?? ''
        const autoLanguages = ['match', 'auto', '']
        const language = autoLanguages.includes(settingsLanguage.toLowerCase())
          ? undefined
          : settingsLanguage

        const result = await transcribeAudio(wav, { language, filename: 'stream.wav' })
        res.json({ transcript: result.transcript })
      } catch (err) {
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
