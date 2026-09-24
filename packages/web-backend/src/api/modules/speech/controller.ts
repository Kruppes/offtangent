import { pipeline } from 'node:stream/promises'
import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseSpeechSummaryBody } from './schema.js'
import { SpeechServiceError, type SpeechService } from './service.js'

export interface SpeechController {
  summary: (req: AuthenticatedRequest, res: Response) => Promise<void>
  audio: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

export function createSpeechController(service: SpeechService): SpeechController {
  return {
    async summary(req, res) {
      const parsed = parseSpeechSummaryBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      try {
        res.json(await service.summary(req.user!.userId, parsed.value))
      } catch (err) {
        if (err instanceof SpeechServiceError) {
          // The body is exactly the contract the app builds against: one
          // `error` code, no prose the client would have to parse.
          res.status(err.status).json({ error: err.code })
          return
        }
        console.error('[speech-summary] Failed to build the spoken summary:', err)
        res.status(500).json({ error: 'internal' })
      }
    },

    async audio(req, res) {
      // Same body contract as /summary — one parser, so the two endpoints can
      // never drift apart in what they accept.
      const parsed = parseSpeechSummaryBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }
      try {
        const result = await service.audio(req.user!.userId, parsed.value, {
          accept: req.get('accept'),
        })
        res.setHeader('Content-Type', result.contentType)
        res.setHeader('X-Speech-Language', result.language)
        res.setHeader('X-Speech-Summary-Chars', String(result.summaryChars))
        if (result.source) res.setHeader('X-Tts-Source', result.source)
        // So a browser client can read the headers above at all.
        res.setHeader(
          'Access-Control-Expose-Headers',
          'X-Speech-Language, X-Speech-Summary-Chars, X-Tts-Source',
        )
        res.setHeader('Cache-Control', 'no-store')
        if (result.stream) {
          // No Content-Length: the length is unknown while the voice is still
          // speaking, and waiting for it would undo the streaming.
          res.status(200)
          res.flushHeaders()
          await pipeline(result.stream, res)
          return
        }
        res.setHeader('Content-Length', String(result.audio!.length))
        res.status(200).send(result.audio)
      } catch (err) {
        if (res.headersSent) {
          console.warn('[speech-audio] stream aborted after headers:', err)
          res.destroy()
          return
        }
        if (err instanceof SpeechServiceError) {
          res.status(err.status).json({ error: err.code })
          return
        }
        console.error('[speech-audio] Failed to build the spoken audio:', err)
        res.status(500).json({ error: 'internal' })
      }
    },
  }
}
