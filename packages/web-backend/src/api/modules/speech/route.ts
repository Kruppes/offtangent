/**
 * /api/speech — spoken output for the companion app.
 *
 *   POST /api/speech/summary { messageId } | { text }
 *     -> 200 { text, language, sourceChars, summaryChars }
 *        400 { error: 'empty' | 'invalid_body' | 'invalid_message_id' | 'text_too_large' }
 *        404 { error: 'not_found' }
 *        502 { error: 'upstream' }
 *
 *   POST /api/speech/audio { messageId } | { text } (+ optional
 *     `format`: 'mp3' | 'wav' | 'opus' | 'flac' for the cloud voice)
 *     -> 200 audio bytes, Content-Type as produced (Ogg/Opus by default),
 *        headers X-Speech-Language: de|en and X-Speech-Summary-Chars: <n>
 *        400 { error: 'empty' | 'invalid_body' | 'invalid_message_id'
 *              | 'text_too_large' | 'invalid_format' | 'unsupported_format' }
 *        404 { error: 'not_found' }
 *        502 { error: 'upstream' }          summary model OR TTS service failed
 *        503 { error: 'tts_unconfigured' }  no local TTS URL in settings.json
 *
 *   POST /api/speech/voice-note { messageId }
 *     -> 200 { voiceNote: { url, mimeType, seconds, spokenChars, sourceChars,
 *                           model, voice, createdAt } }
 *        The note is stored on the message (`metadata.voiceNote`), so a second
 *        call returns the same object without speaking again.
 *        400 { error: 'empty' | 'invalid_body' | 'invalid_message_id' }
 *        404 { error: 'not_found' }        missing, foreign, or not an answer
 *        502 { error: 'upstream' }         rewrite or voice failed
 *        503 { error: 'tts_unconfigured' } no Gemini provider/key
 *
 *   GET  /api/speech/voice-replies -> 200 { enabled }
 *   PUT  /api/speech/voice-replies { enabled } -> 200 { enabled }
 *        Per-user switch for the automatic voice note after every answer.
 *
 * Both /summary and /audio answer with `X-Cache: hit | miss` when the disk
 * cache is on (W6b, `<DATA_DIR>/cache/speech`, `SPEECH_CACHE_MAX_MB`, default
 * 200). Body and the other headers are the same for a hit and a miss, except
 * that a cached clip always comes buffered (with Content-Length).
 *
 * Authentication is the ordinary `jwtMiddleware` every other app route uses.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import type { NextFunction, Response } from 'express'
import { jwtMiddleware, type AuthenticatedRequest } from '../../../auth.js'
import { createSpeechController } from './controller.js'
import { createSpeechService, type SpeechServiceOptions } from './service.js'

export interface SpeechRouterOptions {
  db: Database
  /** Test seam, handed straight to the service. */
  summarize?: SpeechServiceOptions['summarize']
  /** Test seam, handed straight to the service. */
  synthesize?: SpeechServiceOptions['synthesize']
  /** Test seam, handed straight to the service. */
  loadTtsConfig?: SpeechServiceOptions['loadTtsConfig']
  /** Test seam, handed straight to the service. */
  synthesizeCloud?: SpeechServiceOptions['synthesizeCloud']
  /** Test seam, handed straight to the service. */
  loadCloudTtsConfig?: SpeechServiceOptions['loadCloudTtsConfig']
  /** Test seam, handed straight to the service. */
  synthesizeCloudStream?: SpeechServiceOptions['synthesizeCloudStream']
  /** Test seam, handed straight to the service. */
  createVoiceNote?: SpeechServiceOptions['createVoiceNote']
  /** Announce a freshly created voice note (the WS frame). */
  onVoiceNote?: SpeechServiceOptions['onVoiceNote']
  /** Disk cache for /summary and /audio (W6b); absent = no disk cache. */
  cache?: SpeechServiceOptions['cache']
  /** Test seam, handed straight to the service. */
  summaryFingerprint?: SpeechServiceOptions['summaryFingerprint']
  /** Test seam, handed straight to the service. */
  voiceFingerprint?: SpeechServiceOptions['voiceFingerprint']
}

export function createSpeechRouter(options: SpeechRouterOptions): Router {
  const controller = createSpeechController(createSpeechService({
    db: options.db,
    summarize: options.summarize,
    synthesize: options.synthesize,
    loadTtsConfig: options.loadTtsConfig,
    synthesizeCloud: options.synthesizeCloud,
    synthesizeCloudStream: options.synthesizeCloudStream,
    loadCloudTtsConfig: options.loadCloudTtsConfig,
    createVoiceNote: options.createVoiceNote,
    onVoiceNote: options.onVoiceNote,
    cache: options.cache,
    summaryFingerprint: options.summaryFingerprint,
    voiceFingerprint: options.voiceFingerprint,
  }))

  const router = Router()
  router.use(jwtMiddleware)
  router.post('/summary', controller.summary)
  router.post('/audio', controller.audio)
  router.post('/voice-note', controller.voiceNote)
  router.get('/voice-replies', controller.getVoiceReplies)
  router.put('/voice-replies', controller.putVoiceReplies)

  // W7: read-aloud disk cache, admin only. Figures and "empty it"; neither
  // takes any input, so no request part can reach a path. Errors carry a
  // code, never a path or a message from the file system.
  const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'forbidden' })
      return
    }
    next()
  }
  const cache = options.cache ?? null
  const cacheView = () => cache
    ? { enabled: true, ...cache.stats() }
    : { enabled: false, entries: 0, bytes: 0, maxBytes: 0, hits: 0, misses: 0 }
  router.get('/cache', requireAdmin, (_req, res) => {
    try {
      res.json(cacheView())
    } catch (err) {
      console.error('[speech-cache] stats failed:', err)
      res.status(500).json({ error: 'internal' })
    }
  })
  router.delete('/cache', requireAdmin, (_req, res) => {
    try {
      const removed = cache ? cache.clear() : { entries: 0, bytes: 0 }
      res.json({ removedEntries: removed.entries, removedBytes: removed.bytes, ...cacheView() })
    } catch (err) {
      console.error('[speech-cache] clear failed:', err)
      res.status(500).json({ error: 'internal' })
    }
  })

  return router
}
