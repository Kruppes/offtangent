import { Router } from 'express'
import {
  decryptDeepgramApiKey,
  ensureConfigTemplates,
  listDeepgramModels,
  loadConfig,
} from '@axiom/core'
import type { DeepgramModelsList } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

type DeepgramKeyScope = 'stt' | 'tts'

/**
 * Read the (encrypted) Deepgram API key for the requested scope from
 * `settings.json` and return the decrypted plaintext. Empty string when
 * no key is configured.
 *
 * STT and TTS keep separate keys so the account dashboard cleanly attributes
 * usage to the right call site. Mirrors `loadDeepgramApiKey()` in core.
 */
function loadDeepgramApiKeyFromSettings(scope: DeepgramKeyScope): string {
  ensureConfigTemplates()
  const settings = loadConfig<{
    stt?: { deepgramApiKey?: string }
    tts?: { deepgramApiKey?: string }
  }>('settings.json')
  const raw = (scope === 'tts' ? settings.tts?.deepgramApiKey : settings.stt?.deepgramApiKey) ?? ''
  return raw ? decryptDeepgramApiKey(raw) : ''
}

/**
 * Routes that proxy Deepgram management endpoints. Currently only `/models`,
 * which the Settings UI uses to populate the STT/TTS model dropdowns instead
 * of hard-coding a stale list.
 *
 * Admin-only because the Deepgram API key lives in the same settings block
 * that other admin endpoints touch — we don't want regular users to discover
 * which models are available on a private Deepgram account.
 */
export function createDeepgramRouter(): Router {
  const router = Router()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * POST /api/deepgram/models
   *
   * Body: `{ scope?: 'stt' | 'tts', apiKey?: string, includeOutdated?: boolean }`
   *
   * Returns `{ stt: DeepgramModel[], tts: DeepgramModel[] }`.
   *
   * `scope` (default `'stt'`) selects which saved key to fall back to when
   * `apiKey` is omitted or still the masked sentinel — STT and TTS each have
   * their own Deepgram key so the refresh button next to either dropdown can
   * authenticate against the right account.
   *
   * `apiKey` lets the Settings UI test a freshly-typed (not yet saved) key
   * without forcing a save round-trip first. Values containing `•` are
   * treated as the "unchanged masked" sentinel and ignored, falling back to
   * the saved key for the requested scope.
   *
   * Returns 400 when neither source yields a usable key.
   *
   * POST instead of GET so the key never lands in URL/access logs.
   */
  router.post('/models', async (req: AuthenticatedRequest, res) => {
    try {
      const body = (req.body ?? {}) as {
        apiKey?: unknown
        scope?: unknown
        includeOutdated?: unknown
      }

      const scope: DeepgramKeyScope = body.scope === 'tts' ? 'tts' : 'stt'
      const inlineKey = typeof body.apiKey === 'string' ? body.apiKey : ''
      const usableInline = inlineKey && !inlineKey.includes('•') ? inlineKey : ''
      const apiKey = usableInline || loadDeepgramApiKeyFromSettings(scope)

      if (!apiKey) {
        const where = scope === 'tts' ? 'Text-to-Speech' : 'Speech-to-Text'
        res.status(400).json({
          error: `Deepgram API key is not configured for ${scope.toUpperCase()}. Set it in Settings → ${where}.`,
        })
        return
      }

      const includeOutdated = body.includeOutdated === true
      const models: DeepgramModelsList = await listDeepgramModels(apiKey, { includeOutdated })
      res.json(models)
    } catch (err) {
      const message = (err as Error).message
      // Surface auth failures distinctly so the UI can prompt for a new key.
      const status = /authentication failed/i.test(message) ? 401 : 502
      res.status(status).json({ error: message })
    }
  })

  return router
}
