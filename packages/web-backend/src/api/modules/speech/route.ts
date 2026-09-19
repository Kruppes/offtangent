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
 * Authentication is the ordinary `jwtMiddleware` every other app route uses.
 */
import { Router } from 'express'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../../../auth.js'
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
}

export function createSpeechRouter(options: SpeechRouterOptions): Router {
  const controller = createSpeechController(createSpeechService({
    db: options.db,
    summarize: options.summarize,
    synthesize: options.synthesize,
    loadTtsConfig: options.loadTtsConfig,
    synthesizeCloud: options.synthesizeCloud,
    loadCloudTtsConfig: options.loadCloudTtsConfig,
  }))

  const router = Router()
  router.use(jwtMiddleware)
  router.post('/summary', controller.summary)
  router.post('/audio', controller.audio)

  return router
}
