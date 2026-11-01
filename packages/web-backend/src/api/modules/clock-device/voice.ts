/**
 * Stage 3, the clock's voice route (B1, rebuilt for the companion as K1).
 *
 *   POST /api/device/clock/voice        raw PCM, 16 bit LE mono, 16 kHz fixed
 *        header X-Clock-Exchange: clk-<rev>-<ms>   (optional, idempotency)
 *     -> 200 { exchange_id, turn_id, transcript, intent, band, strand_id,
 *              strand_title, persona, parts, turn, state, idempotent }
 *        202 the same, state 'pending'   (agent core not up, capture is safe)
 *        400 bad_exchange_id
 *        401 unauthorized | 403 not_lan | forbidden_scope   (before anything)
 *        404 not_found       (switch off, the default; see clockVoiceEnabled)
 *        408 upload_timeout  (whole upload > 20 s, or the stream stalls)
 *        409 strand_busy     (from the captures service, should not happen:
 *                             the router path queues behind a busy strand)
 *        413 too_large       (> 512 000 bytes, checked while streaming)
 *        422 no_speech       (< 0.4 s of audio, empty or phantom transcript)
 *        429 rate_limited    (one recording at a time per device, E6)
 *        502 stt_failed | 503 agent_unavailable
 *   GET  /api/device/clock/voice/:exchangeId
 *     -> 200 { state: thinking|filed|needs_choice|pending|done|error, caption? }
 *        interim; K2 replaces it with the exchange tracker on the event bus.
 *
 * Order of the gates (review REVIEW-PLAN-v2, M3): network gate -> token and
 * scope `clock:voice` -> switch -> rate slot -> body -> STT -> capture. A
 * caller that fails an earlier gate never gets a byte of its body read and
 * never reaches the STT.
 *
 * Target strand (companion concept §1, decision E3): none of its own. The
 * transcript becomes a capture with `source 'clock'`, `kind 'voice'`, `mode
 * 'work'` through the same `CapturesService.createCapture` the Android app
 * uses: the router picks strand and persona, the turn gets every tool, the
 * source's style hint (`captureSources.clock.styleHint`, H2) is added
 * turn-locally. A low band stays in the tray (`needs_choice`), like in the app.
 *
 * Nothing in here logs the token or the transcript (review m2, proven by a
 * console spy in voice.test.ts).
 */
import crypto from 'node:crypto'
import type { NextFunction, Request, Response, Router } from 'express'
import { confidenceBand, declaresSelfNote, loadCaptureModeSettings, type Database } from '@axiom/core'
import { transcribeRawPcm } from '../../../routes/stt.js'
import { CaptureServiceError, type CaptureResult } from '../captures/service.js'
import type { CreateCaptureBody } from '../captures/schema.js'
import type { ClockDevice } from './registry.js'
import { ClockExchangeTracker, type ClockExchangePhase, type ClockTurnSource } from './exchange.js'

/** 16 kHz x 2 bytes x 16 s. */
export const CLOCK_VOICE_MAX_BYTES = 512_000
/** 0.4 s of 16 kHz 16 bit audio; below that the STT is not even asked. */
export const CLOCK_VOICE_MIN_BYTES = 12_800
/** The one format the firmware produces. Deliberately no `?rate=`. */
export const CLOCK_VOICE_RATE = 16_000
/** Whole upload, from the first gate passed to the last byte. */
export const CLOCK_VOICE_UPLOAD_TIMEOUT_MS = 20_000
/** A stream that sends nothing for this long is dropped (slowloris). */
export const CLOCK_VOICE_STALL_MS = 3_000
/** `source` of every clock capture; `captureSources.clock` belongs to it. */
export const CLOCK_VOICE_SOURCE = 'clock'

/**
 * True when `CLOCK_VOICE_ENABLED` is explicitly switched on. Default: off.
 * The hard emergency stop; see {@link clockVoiceEnabled} for the whole switch.
 */
export function clockVoiceEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CLOCK_VOICE_ENABLED ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'on' || value === 'yes'
}

// ---- phantom transcripts (review m3) -------------------------------------

/**
 * Lines Whisper style models invent on silence, noise or music. Compared after
 * normalisation (lower case, no punctuation, single spaces).
 */
const PHANTOM_TRANSCRIPTS = [
  'untertitel der amara org community',
  'untertitel im auftrag des zdf',
  'untertitelung des zdf',
  'untertitel von stephanie geiges',
  'vielen dank fürs zuschauen',
  'vielen dank für ihre aufmerksamkeit',
  'danke fürs zuschauen',
  'bis zum nächsten mal',
  'tschüss',
  'thank you for watching',
  'thanks for watching',
  'thank you',
  'subtitles by the amara org community',
  'musik',
  'music',
  'applaus',
]

function normaliseTranscript(text: string): string {
  return text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * True when a transcript is not worth a turn: empty, fewer than two letters,
 * or one of the typical phantom lines (optionally in brackets, e.g. "[Musik]").
 */
export function isPhantomTranscript(text: string): boolean {
  const letters = (text.match(/\p{L}/gu) ?? []).length
  if (letters < 2) return true
  const normalised = normaliseTranscript(text)
  return PHANTOM_TRANSCRIPTS.includes(normalised)
}

// ---- body reading (review M3) ----------------------------------------------

export class ClockVoiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface ReadPcmOptions {
  maxBytes: number
  timeoutMs: number
  stallMs: number
}

/**
 * Reads the request body chunk by chunk and stops as soon as a limit is hit:
 * more than `maxBytes` (413), the whole upload slower than `timeoutMs` or a
 * pause longer than `stallMs` (408), the client going away (499-ish, no
 * answer possible). The body is never buffered past `maxBytes`.
 */
export function readPcmBody(req: Request, options: ReadPcmOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    let stallTimer: NodeJS.Timeout | null = null

    const cleanup = () => {
      clearTimeout(totalTimer)
      if (stallTimer) clearTimeout(stallTimer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
      req.off('close', onClose)
    }
    const fail = (error: ClockVoiceError) => {
      if (settled) return
      settled = true
      cleanup()
      // Stop the stream: no further bytes are read into memory.
      req.pause()
      reject(error)
    }
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => fail(new ClockVoiceError(408, 'upload_timeout', 'Upload stalled')), options.stallMs)
    }
    const onData = (chunk: Buffer) => {
      size += chunk.length
      if (size > options.maxBytes) {
        fail(new ClockVoiceError(413, 'too_large', `Audio larger than ${options.maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
      armStall()
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onError = () => fail(new ClockVoiceError(400, 'aborted', 'Upload failed'))
    const onAborted = () => fail(new ClockVoiceError(400, 'aborted', 'Upload aborted by the client'))
    const onClose = () => {
      if (!req.complete) fail(new ClockVoiceError(400, 'aborted', 'Upload aborted by the client'))
    }
    const totalTimer = setTimeout(
      () => fail(new ClockVoiceError(408, 'upload_timeout', `Upload took longer than ${options.timeoutMs} ms`)),
      options.timeoutMs,
    )

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      fail(new ClockVoiceError(413, 'too_large', `Audio larger than ${options.maxBytes} bytes`))
      return
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
    req.on('close', onClose)
    armStall()
  })
}
// ---- rate limit: one recording at a time per device (companion E6) --------
//
// B1 also had 6 per minute and 60 per day. The companion concept (§5, E6)
// drops both: they restrict the owner without protecting anything the token
// gate does not already protect. What stays is the single slot, against a
// loop in the firmware and a double click. In RAM, forgotten on restart.

export class ClockVoiceRateLimiter {
  private readonly running = new Set<string>()

  /** Takes the device's single slot, or returns why not. */
  acquire(deviceId: string): { ok: true } | { ok: false; reason: 'running' } {
    if (this.running.has(deviceId)) return { ok: false, reason: 'running' }
    this.running.add(deviceId)
    return { ok: true }
  }

  release(deviceId: string): void {
    this.running.delete(deviceId)
  }

  isRunning(deviceId: string): boolean {
    return this.running.has(deviceId)
  }
}

// ---- switch (companion K1) -------------------------------------------------

/**
 * `captureSources.clock.enabled` from `settings.json`, read per request so a
 * change applies without a restart. Missing, corrupt or anything but `true`
 * counts as off.
 */
export function clockVoiceEnabledFromSettings(): boolean {
  try {
    return loadCaptureModeSettings().captureSources.clock.enabled === true
  } catch {
    return false
  }
}

/**
 * The route answers only when BOTH switches are on: the product switch
 * `captureSources.clock.enabled` and the environment variable
 * `CLOCK_VOICE_ENABLED`, which stays as the hard emergency stop. Default: off.
 */
export function clockVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return clockVoiceEnabledFromEnv(env) && clockVoiceEnabledFromSettings()
}

// ---- exchange id -> clientMessageId (companion §1.2) -----------------------

/** Header the clock sends with every upload: `clk-<rev>-<ms>`. */
export const CLOCK_EXCHANGE_HEADER = 'x-clock-exchange'
const EXCHANGE_PATTERN = /^[A-Za-z0-9._:-]{1,48}$/

/**
 * The capture's `clientMessageId` for the exchange id the clock sent:
 * `clock:<8 hex of the device id>:<exchange id>` (at most 63 characters, the
 * alphabet of `normalizeClientMessageId`). The device part keeps two clocks of
 * one user from ever sharing an id. `undefined` when the header is absent (no
 * idempotency, older firmware), `null` when it is malformed.
 */
export function clockClientMessageId(deviceId: string, raw: unknown): string | null | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !EXCHANGE_PATTERN.test(value)) return null
  const device = crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 8)
  return `clock:${device}:${value}`
}

// ---- capture path ----------------------------------------------------------

/**
 * The slice of the captures service this module needs: the very instance
 * `POST /api/captures` uses (app.ts), so a spoken question takes the router
 * path of the Android app step for step.
 */
export interface ClockCaptureCreator {
  createCapture: (userId: number, body: CreateCaptureBody) => Promise<CaptureResult>
}

/**
 * What the upload answers in `state`. `error` (review K0-K2, MAJOR-2): a
 * question was stored, but no answer turn runs for it (no runner, or the
 * runner reported no turn id); the clock must not say "Notiert".
 */
export type ClockExchangeState = 'thinking' | 'filed' | 'needs_choice' | 'pending' | 'error'

/** Long-poll wait of `GET /voice/:exchangeId?wait=` (companion K2). */
export const CLOCK_VOICE_POLL_DEFAULT_MS = 25_000
export const CLOCK_VOICE_POLL_MAX_MS = 30_000

export interface ClockVoiceOptions {
  db: Database
  /** The app's captures service; null while the agent core is not up. */
  getCaptures: () => ClockCaptureCreator | null
  /**
   * Follows the answer turns for `GET /voice/:exchangeId` (K2). Without one
   * the routes build their own from `getTurnRunner`.
   */
  tracker?: ClockExchangeTracker
  /** The TurnRunner the default tracker subscribes to. */
  getTurnRunner?: () => ClockTurnSource | null
  /** H3 (E2 fallback): short spoken version from a small model; see exchange.ts. */
  shorten?: ((text: string, maxChars: number, strandId?: string | null) => Promise<string | null>) | null
  /** Defaults to {@link clockVoiceEnabled} (env AND settings), read per request. */
  isEnabled?: () => boolean
  /** STT; defaults to the shared raw PCM path of `/api/stt/transcribe-raw`. */
  transcribe?: (pcm: Buffer, rate: number) => Promise<{ transcript: string }>
  limiter?: ClockVoiceRateLimiter
  upload?: Partial<ReadPcmOptions>
}

interface ClockRequest extends Request {
  clockDevice?: ClockDevice
}

/**
 * True when the client connection is gone. Not `req.destroyed`: a request
 * whose body was read to the end is auto-destroyed by Node although the
 * client still waits for the answer. The socket and the response tell.
 */
export function clientGone(req: Request, res: Response): boolean {
  return res.destroyed || res.writableEnded || Boolean(res.socket?.destroyed ?? req.socket?.destroyed)
}

function sendError(res: Response, error: ClockVoiceError): void {
  if (res.headersSent) return
  res.status(error.status).json({ error: error.message, code: error.code })
}

/** `state` of an exchange, from what the captures service did with it. */
export function clockExchangeState(result: CaptureResult): ClockExchangeState {
  if (result.routingPending) return 'pending'
  // Only part 0 is spoken (§1.4). A turn of a later part does not make the
  // exchange `thinking` (review K0-K2, MAJOR-4).
  if (result.turnIds?.some(t => t.partIndex === 0)) return 'thinking'
  const status = result.capture.status
  if (status === 'unsorted' || status === 'failed') return 'needs_choice'
  // Part 0 of a split stayed in the tray (low band) while another part was filed.
  const first = result.parts?.find(part => part.index === 0)?.decision ?? result.decision
  if (first.state === 'proposed') return 'needs_choice'
  // "Notiert" only for a real note (review K0-K2, MAJOR-2). A filed question
  // always starts its turn on the router path (a sub-high append becomes a
  // new strand, which answers); without one the runner was missing or
  // reported no turn id, and the clock says so instead of "Notiert".
  if (first.intent === 'ask') return 'error'
  return 'filed'
}

/**
 * Registers the voice routes on `router`. `gates` are the network gate and the
 * token check with scope `clock:voice`, in that order; they run before the
 * switch so that a stranger learns nothing, not even whether voice exists.
 */
export function registerClockVoiceRoutes(
  router: Router,
  gates: Array<(req: Request, res: Response, next: NextFunction) => void>,
  options: ClockVoiceOptions,
): void {
  const { db } = options
  const isEnabled = options.isEnabled ?? (() => clockVoiceEnabled())
  const transcribe = options.transcribe ?? transcribeRawPcm
  const limiter = options.limiter ?? new ClockVoiceRateLimiter()
  const upload: ReadPcmOptions = {
    maxBytes: options.upload?.maxBytes ?? CLOCK_VOICE_MAX_BYTES,
    timeoutMs: options.upload?.timeoutMs ?? CLOCK_VOICE_UPLOAD_TIMEOUT_MS,
    stallMs: options.upload?.stallMs ?? CLOCK_VOICE_STALL_MS,
  }
  const tracker = options.tracker ?? new ClockExchangeTracker({ getTurnSource: () => options.getTurnRunner?.() ?? null })

  const switchGate = (_req: Request, res: Response, next: NextFunction) => {
    if (!isEnabled()) {
      res.status(404).json({ error: 'Not found', code: 'not_found' })
      return
    }
    next()
  }

  const strandInfo = (strandId: string | null): { title: string | null; agentId: string | null } => {
    if (!strandId) return { title: null, agentId: null }
    const row = db.prepare('SELECT title, agent_id FROM sessions WHERE id = ?').get(strandId) as
      { title: string | null; agent_id: string | null } | undefined
    return { title: row?.title ?? null, agentId: row?.agent_id ?? null }
  }

  router.post('/voice', ...gates, switchGate, async (req: ClockRequest, res: Response) => {
    const device = req.clockDevice!
    // Before the slot and the body: a malformed exchange id is the firmware's
    // bug, and a retry with the same id would fail the same way.
    const clientMessageId = clockClientMessageId(device.id, req.headers[CLOCK_EXCHANGE_HEADER])
    if (clientMessageId === null) {
      res.set('Connection', 'close')
      res.on('finish', () => req.destroy())
      res.status(400).json({ error: 'Invalid exchange id', code: 'bad_exchange_id' })
      return
    }
    const slot = limiter.acquire(device.id)
    if (!slot.ok) {
      // The body is not read; the connection closes after the answer.
      res.set('Connection', 'close')
      res.on('finish', () => req.destroy())
      res.status(429).json({ error: 'A voice request of this device is still running', code: 'rate_limited', reason: slot.reason })
      return
    }
    // Open tracker.watch() of this request, ended in `finally` (MINOR-2).
    let watched = false
    try {
      // Cheap check before the upload: without the captures service (agent
      // core not up) neither the body nor the STT is worth it.
      if (!options.getCaptures()) throw new ClockVoiceError(503, 'agent_unavailable', 'Agent core not available')

      const body = await readPcmBody(req, upload)
      if (body.length < CLOCK_VOICE_MIN_BYTES) throw new ClockVoiceError(422, 'no_speech', 'Nothing heard')
      // An odd byte count would shift every sample by one byte; drop the tail.
      const pcm = body.length % 2 === 0 ? body : body.subarray(0, body.length - 1)

      let transcript: string
      try {
        transcript = ((await transcribe(pcm, CLOCK_VOICE_RATE)).transcript ?? '').trim()
      } catch (err) {
        // Log the kind of failure only: a provider message may quote what it
        // heard, so neither the message nor the audio is ever written.
        const kind = err instanceof Error ? err.name : typeof err
        console.warn(`[clock-voice] STT failed for device ${device.id} (${kind})`)
        throw new ClockVoiceError(502, 'stt_failed', 'Speech recognition failed')
      }
      if (isPhantomTranscript(transcript)) throw new ClockVoiceError(422, 'no_speech', 'Nothing heard')

      // The clock hung up during the STT (review B1, m-1): nobody is left to
      // show the answer, so no capture is created (no cost, nothing filed).
      if (clientGone(req, res)) return

      const captures = options.getCaptures()
      if (!captures) throw new ClockVoiceError(503, 'agent_unavailable', 'Agent core not available')

      // Exactly the body `POST /api/captures` builds for the Android app,
      // with source `clock`: the router picks strand and persona, the turn
      // gets every tool, the source's style hint (`captureSources.clock`)
      // is added turn-locally by the captures service.
      // Subscribe before the turn exists (K2): its first chunks are parked
      // until the exchange is registered below.
      tracker.watch(device.userId)
      watched = true
      let result: CaptureResult
      try {
        result = await captures.createCapture(device.userId, {
          text: transcript,
          clientMessageId: clientMessageId ?? null,
          agentId: null,
          strandId: null,
          kind: 'voice',
          source: CLOCK_VOICE_SOURCE,
          attachments: [],
          // E3 (§4.4): a capture the user calls a note gets no turn on the
          // clock but "Notiert: <title>". The router itself never yields a
          // note (ROUTED_INTENT), so the user's own word decides, stated as
          // an explicit intent (SPEC 4.1).
          intent: clockSaysNote(transcript) ? 'note' : null,
          mode: 'work',
        })
      } catch (err) {
        if (err instanceof CaptureServiceError) {
          // Status and code only: the message may name a strand title.
          throw new ClockVoiceError(err.status, err.code, 'Capture failed')
        }
        throw err
      }

      const { capture, decision } = result
      const strand = strandInfo(capture.strandId)
      const known = tracker.has(capture.id)
      // A repeat of a known exchange answers what the first upload answered.
      const first = known && !result.created ? tracker.firstAnswer(capture.id) : null
      const state = (first?.initialState as ClockExchangeState | null | undefined) ?? clockExchangeState(result)
      if (!known) {
        // A repeat whose first exchange the tracker no longer knows (restart,
        // 15 min) cannot follow its turn: it ends at once, the answer is in
        // the strand.
        const lost = !result.created && (state === 'thinking' || state === 'error')
        const unavailable = result.created && state === 'error'
        tracker.register({
          exchangeId: capture.id,
          deviceId: device.id,
          userId: device.userId,
          strandId: capture.strandId,
          strandTitle: strand.title,
          persona: strand.agentId ?? capture.agentId ?? decision.personaId ?? null,
          turnIds: lost ? [] : result.turnIds ?? [],
          phase: lost ? 'error' : phaseOf(state),
          error: lost ? 'exchange_lost' : unavailable ? 'turn_unavailable' : null,
          moreParts: (result.parts ?? [])
            .filter(part => part.index > 0)
            .map(part => ({ title: strandInfo(part.decision.strandId ?? null).title })),
          queue: result.turn?.queued
            ? { position: result.turn.position, blockedByTitle: result.turn.blockedBy?.title ?? null }
            : null,
          initialState: state,
        })
      }
      const view = tracker.view(capture.id, 0, device.privacy)
      const turnId = result.turnIds?.find(t => t.partIndex === 0)?.turnId ?? first?.turnId ?? null
      const band = confidenceBand(decision.confidence)
      const turn = result.turn
        ? {
            queued: result.turn.queued,
            position: result.turn.position,
            // A strand title may be private (privacy mode).
            blocked_by_title: device.privacy ? null : result.turn.blockedBy?.title ?? null,
          }
        : null
      res.set('Cache-Control', 'no-store')
      // Privacy mode of the device (review B1, M-1): no plain text on the
      // clock, like the labels and question texts of stages 1/2. That covers
      // the transcript and the strand title.
      res.status(result.routingPending ? 202 : 200).json({
        exchange_id: capture.id,
        turn_id: turnId,
        transcript: device.privacy ? '' : transcript,
        intent: decision.intent,
        band,
        strand_id: capture.strandId,
        strand_title: device.privacy ? null : strand.title,
        // The persona that answers: the one of the strand the capture landed
        // in (an append names no persona of its own).
        persona: strand.agentId ?? capture.agentId ?? decision.personaId ?? null,
        parts: result.partCount ?? 1,
        turn,
        state,
        // The tracker's view of the exchange (K2): the long-poll starts here.
        phase: view?.state ?? null,
        error: view?.error ?? null,
        cursor: 0,
        idempotent: !result.created,
      })
    } catch (err) {
      const error = err instanceof ClockVoiceError
        ? err
        : new ClockVoiceError(500, 'internal', 'Voice request failed')
      if (!(err instanceof ClockVoiceError)) console.error(`[clock-voice] Request of device ${device.id} failed`)
      if (error.code === 'too_large' || error.code === 'upload_timeout') {
        // The rest of the body is not read; close the connection after the
        // answer so the socket is not kept busy by the remaining bytes.
        res.set('Connection', 'close')
        res.on('finish', () => req.destroy())
      }
      if (error.code !== 'aborted') sendError(res, error)
    } finally {
      // Registered turns keep the subscription alive on their own; a failed
      // or abandoned upload drops it here (review K0-K2, MINOR-2).
      if (watched) tracker.unwatch(device.userId)
      limiter.release(device.id)
    }
  })

  /**
   * Text back-channel of an exchange (K2, companion §2.3): a long poll with a
   * cursor. `cursor` is the number of characters of the spoken text the
   * clock already has; the answer carries `text_delta` from there and the new
   * `cursor`. `state` is the phase the clock knows: the poll waits (up to
   * `wait` ms) until there is new text, the phase changed or the exchange is
   * terminal. A repeated poll with the same cursor returns the same delta.
   */
  router.get('/voice/:exchangeId', ...gates, switchGate, async (req: ClockRequest, res: Response) => {
    const device = req.clockDevice!
    const exchangeId = String(req.params.exchangeId)
    res.set('Cache-Control', 'no-store')
    if (!tracker.ownedBy(exchangeId, device.id)) {
      res.status(404).json({ error: 'Unknown exchange', code: 'unknown_exchange' })
      return
    }
    const cursor = parseNonNegativeInt(req.query.cursor, 0)
    const waitMs = Math.min(parseNonNegativeInt(req.query.wait, CLOCK_VOICE_POLL_DEFAULT_MS), CLOCK_VOICE_POLL_MAX_MS)
    const knownState = typeof req.query.state === 'string' && req.query.state ? req.query.state : null
    if (waitMs > 0) {
      const abort = new AbortController()
      const onClose = () => abort.abort()
      res.on('close', onClose)
      try {
        await tracker.waitForChange(exchangeId, cursor, knownState, waitMs, abort.signal)
      } finally {
        res.off('close', onClose)
      }
      if (clientGone(req, res)) return
    }
    const view = tracker.view(exchangeId, cursor, device.privacy)
    if (!view) {
      res.status(404).json({ error: 'Unknown exchange', code: 'unknown_exchange' })
      return
    }
    res.json(view)
  })
}

function parseNonNegativeInt(raw: unknown, fallback: number): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return fallback
  return Number(value)
}

/**
 * Does a spoken capture call itself a note? The core phrases ("nur als
 * Notiz", "note to self", ...) plus a leading "Notiz", the way a memo is
 * dictated ("Notiz: Milch kaufen").
 */
export function clockSaysNote(transcript: string): boolean {
  if (declaresSelfNote(transcript)) return true
  return /^\s*(notiz|note)\b[\s,:.-]/i.test(transcript)
}

/** The tracker phase of an exchange that starts without a turn. */
function phaseOf(state: ClockExchangeState): ClockExchangePhase {
  if (state === 'needs_choice') return 'needs_choice'
  if (state === 'pending') return 'pending'
  if (state === 'thinking') return 'thinking'
  if (state === 'error') return 'error'
  return 'noted'
}
