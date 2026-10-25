/**
 * Stage 3, companion K1: POST /api/device/clock/voice against a real database,
 * a real SessionManager, the real captures service (router path of the Android
 * app) and a real express app; only the STT, the router model and the turn
 * runner are stubs.
 *
 * Proven here:
 *   - gate order: network -> token/scope -> switch -> body -> STT; a failed
 *     gate never waits for the body and never reaches the STT (M3)
 *   - two switches: `captureSources.clock.enabled` (product, settings.json)
 *     AND `CLOCK_VOICE_ENABLED` (emergency stop); default off -> 404
 *   - 512 000 byte limit while streaming (413), 0.4 s minimum (no_speech),
 *     fixed 16 kHz, stall/total timeout (408), client abort
 *   - one recording at a time per device (E6), no per-minute/day limit
 *   - the transcript becomes a capture with source 'clock', kind voice,
 *     mode work, a clientMessageId from X-Clock-Exchange; the ROUTER files it
 *     (append into an existing strand, new strand, tray) -- no fixed strand
 *   - the turn gets the clock's style hint and its runner turn id comes back
 *   - phantom transcripts -> no_speech, no capture, no turn
 *   - neither the token nor the transcript is written to the console
 *   - token creation: default without clock:voice, explicit voice, unknown
 *     scope refused, existing rows untouched (M2)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, DEFAULT_CLOCK_STYLE_HINT } from '@axiom/core'
import type { AgentCore, Database, ResolvedRouterModel } from '@axiom/core'
import { createClockDeviceRouter } from './route.js'
import { ClockDeviceRegistry, ClockScopeError, CLOCK_DEFAULT_SCOPES, normaliseClockScopes, type ClockScope } from './registry.js'
import {
  CLOCK_VOICE_MAX_BYTES,
  CLOCK_VOICE_MIN_BYTES,
  CLOCK_VOICE_RATE,
  ClockVoiceRateLimiter,
  clockClientMessageId,
  clockVoiceEnabled,
  clockVoiceEnabledFromEnv,
  clockVoiceEnabledFromSettings,
  clockExchangeState,
  clockSaysNote,
  isPhantomTranscript,
} from './voice.js'
import type { TrackedTurnEvent } from './exchange.js'
import { createCapturesRouters } from '../captures/route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let sessionManager: SessionManager
let server: http.Server
let port: number
let gatedServer: http.Server
let gatedPort: number
let unwiredServer: http.Server
let unwiredPort: number
let tempDataDir: string
let previousDataDir: string | undefined
let userJwt: string

let enabled = true
let limiter = new ClockVoiceRateLimiter()
let busySessions: string[] = []
let turnSubscribers: Array<{ user: string; subscriber: (event: TrackedTurnEvent) => void }> = []

/** Emits a turn event like TurnRunner.emit does, to the user's subscribers. */
function emitTurn(event: TrackedTurnEvent, user = '1'): void {
  for (const s of [...turnSubscribers]) if (s.user === user) s.subscriber(event)
}

function answerTurn(turnId: string, text: string): void {
  emitTurn({ type: 'turn_start', turnId, sessionId: 's' })
  emitTurn({ type: 'chunk', turnId, chunk: { type: 'text', text } })
  emitTurn({ type: 'chunk', turnId, chunk: { type: 'done' } })
  emitTurn({ type: 'turn_end', turnId })
}
let transcribeCalls: Array<{ bytes: number; rate: number }> = []
let nextTranscript: string | Error = 'Wie wird das Wetter morgen?'
let transcribeDelayMs = 0
let turns: Array<Record<string, unknown>> = []
let turnCounter = 0
/** 'ids': the runner reports turn ids; 'none': it reports none; 'absent': no runner (review K0-K2, MAJOR-2). */
let runnerMode: 'ids' | 'none' | 'absent' = 'ids'
/** Split model answers, consumed in order; empty -> no split (review K0-K2, MAJOR-4). */
let splitAnswers: string[] = []
/** Router answers, consumed in order; empty -> {@link DEFAULT_ROUTE}. */
let nextAnswers: string[] = []
let routerCalls: string[] = []
let voiceToken: string
let voiceDeviceId: string
let plainToken: string

const DEFAULT_ROUTE = {
  action: 'new_strand',
  newStrand: { title: 'Wetter morgen', personaId: 'main', tags: [] },
  intent: 'ask',
  confidence: 0.9,
  rationale: 'weather question',
}

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

function route(answer: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(answer))
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tempDataDir, 'config', 'settings.json'), JSON.stringify(settings))
}

const TRANSCRIPT_MARKER = 'Wie wird das Wetter morgen?'

/** `seconds` of a 440 Hz tone as 16 bit LE mono PCM at 16 kHz. */
function pcm(seconds: number): Buffer {
  const samples = Math.round(CLOCK_VOICE_RATE * seconds)
  const buffer = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / CLOCK_VOICE_RATE) * 8000), i * 2)
  }
  return buffer
}

interface SendOptions {
  token?: string | null
  /** Sent in one go (with Content-Length unless `chunked`). */
  body?: Buffer
  chunked?: boolean
  /** Chunks written with `gapMs` pauses (chunked transfer). */
  chunks?: Buffer[]
  gapMs?: number
  /** Declared Content-Length while only `body` (fewer bytes) is sent and the request stays open. */
  declaredLength?: number
  /** Leave the request open after the body (slowloris). */
  hang?: boolean
  /** Destroy the client socket after this many ms. */
  abortAfterMs?: number
  headers?: Record<string, string>
  method?: string
  path?: string
  targetPort?: number
}

interface SendResult {
  status: number
  json: Record<string, unknown>
  /** ms from the request start to the response headers. */
  ms: number
}

function send(options: SendOptions = {}): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const token = options.token === undefined ? voiceToken : options.token
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...(options.headers ?? {}) }
    if (token) headers.Authorization = `Bearer ${token}`
    if (options.declaredLength !== undefined) headers['Content-Length'] = String(options.declaredLength)
    else if (options.body && !options.chunked) headers['Content-Length'] = String(options.body.length)
    else if (options.chunks || options.chunked) headers['Transfer-Encoding'] = 'chunked'
    const started = Date.now()
    let settled = false
    const req = http.request({
      host: '127.0.0.1',
      port: options.targetPort ?? port,
      method: options.method ?? 'POST',
      path: options.path ?? '/api/device/clock/voice',
      headers,
    }, (res) => {
      const ms = Date.now() - started
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => {
        settled = true
        let json: Record<string, unknown> = {}
        try { json = JSON.parse(text) as Record<string, unknown> } catch { /* empty */ }
        resolve({ status: res.statusCode ?? 0, json, ms })
        req.destroy()
      })
    })
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
    if (options.abortAfterMs !== undefined) {
      setTimeout(() => {
        if (!settled) {
          settled = true
          req.destroy()
          resolve({ status: 0, json: {}, ms: Date.now() - started })
        }
      }, options.abortAfterMs)
    }
    const finish = () => {
      if (options.hang || options.declaredLength !== undefined) return
      req.end()
    }
    if (options.chunks) {
      const queue = [...options.chunks]
      const next = () => {
        if (settled) return
        const chunk = queue.shift()
        if (!chunk) { finish(); return }
        req.write(chunk)
        setTimeout(next, options.gapMs ?? 0)
      }
      next()
    } else {
      if (options.body) req.write(options.body)
      finish()
    }
  })
}

async function waitFor(check: () => boolean, ms = 2000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return check()
}


function captureRows(): Array<{ id: string; source: string; kind: string; status: string; strand_id: string | null; client_message_id: string | null; text: string }> {
  return db.prepare(
    'SELECT id, source, kind, status, strand_id, client_message_id, text FROM captures ORDER BY rowid',
  ).all() as never
}

/** A strand titled "Uhr" would be the B1/B2 fixed strand; K1 has none. */
function uhrStrands(userId = 1): Array<{ id: string }> {
  return db.prepare(
    "SELECT id FROM sessions WHERE type = 'interactive' AND session_user = ? AND title = 'Uhr'",
  ).all(String(userId)) as Array<{ id: string }>
}

function makeApp(voice: boolean, allowedCidrs: string): express.Express {
  const app = express()
  app.use(express.json())
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore
  const runner = {
    subscribe: (user: number | string, subscriber: (event: TrackedTurnEvent) => void) => {
      const entry = { user: String(user), subscriber }
      turnSubscribers.push(entry)
      return () => { turnSubscribers = turnSubscribers.filter(s => s !== entry) }
    },
    hasActiveTurnInSession: (_user: string | number, id: string) => busySessions.includes(id),
    startTurn: (input: Record<string, unknown>) => {
      turns.push(input)
      turnCounter += 1
      return runnerMode === 'none' ? {} : { turnId: `turn-${turnCounter}` }
    },
  }
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => (runnerMode === 'absent' ? null : runner) as never,
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    // No topic split unless a test queues split answers (a voice capture is split-eligible).
    splitComplete: async () => {
      const next = splitAnswers.shift()
      if (next === undefined) throw new Error('no split in this test')
      return next
    },
    routerComplete: async (_spec: unknown, prompt: unknown) => {
      routerCalls.push(typeof prompt === 'string' ? prompt : JSON.stringify(prompt))
      return nextAnswers.shift() ?? JSON.stringify(DEFAULT_ROUTE)
    },
  } as never)
  app.use('/api/captures', captures.captures)
  app.use('/api/device/clock', createClockDeviceRouter({
    db,
    getInteractions: () => { throw new Error('not used') },
    allowedCidrs,
    voice: voice
      ? {
          isEnabled: () => enabled,
          getCaptures: () => captures.service,
          getTurnRunner: () => runner,
          transcribe: async (audio, rate) => {
            transcribeCalls.push({ bytes: audio.length, rate })
            if (transcribeDelayMs) await new Promise(r => setTimeout(r, transcribeDelayMs))
            if (nextTranscript instanceof Error) throw nextTranscript
            return { transcript: nextTranscript }
          },
          // Delegate so every test can start with a fresh limiter.
          limiter: {
            acquire: (id: string) => limiter.acquire(id),
            release: (id: string) => limiter.release(id),
            isRunning: (id: string) => limiter.isRunning(id),
          } as unknown as ClockVoiceRateLimiter,
          upload: { stallMs: 300, timeoutMs: 1500 },
        }
      : undefined,
  }))
  return app
}

async function listen(app: express.Express): Promise<[http.Server, number]> {
  const s = http.createServer(app)
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
  return [s, (s.address() as { port: number }).port]
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-clock-voice-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  writeSettings({})
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'alice', 'x', 'admin')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  ;[server, port] = await listen(makeApp(true, '127.0.0.1/32'))
  // Default allowlist (no loopback): the network gate refuses this peer.
  ;[gatedServer, gatedPort] = await listen(makeApp(true, '10.0.0.0/8'))
  ;[unwiredServer, unwiredPort] = await listen(makeApp(false, '127.0.0.1/32'))
  userJwt = generateAccessToken({ userId: 1, username: 'alice', role: 'admin' })
})

afterAll(async () => {
  for (const s of [server, gatedServer, unwiredServer]) {
    s.closeAllConnections()
    await new Promise<void>(resolve => s.close(() => resolve()))
  }
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set; DELETE FROM sessions; DELETE FROM clock_devices;')
  writeSettings({})
  enabled = true
  limiter = new ClockVoiceRateLimiter()
  busySessions = []
  transcribeCalls = []
  nextTranscript = TRANSCRIPT_MARKER
  transcribeDelayMs = 0
  turns = []
  turnCounter = 0
  runnerMode = 'ids'
  splitAnswers = []
  nextAnswers = []
  routerCalls = []
  // One unrelated strand, so the router really asks its model: with no
  // strand at all it opens a derived one without a model call (medium band).
  sessionManager.createThread('1', 'main', 'Einkauf')
  const registry = new ClockDeviceRegistry(db)
  const voice = registry.create(1, { name: 'TC002', scopes: ['clock:state', 'clock:answer', 'clock:voice'] })
  voiceToken = voice.token
  voiceDeviceId = voice.device.id
  plainToken = registry.create(1, { name: 'Alt' }).token
})

// ---------------------------------------------------------------------------
describe('switches (captureSources.clock.enabled AND CLOCK_VOICE_ENABLED)', () => {
  it('env: off unless explicitly switched on', () => {
    expect(clockVoiceEnabledFromEnv({})).toBe(false)
    expect(clockVoiceEnabledFromEnv({ CLOCK_VOICE_ENABLED: '' })).toBe(false)
    expect(clockVoiceEnabledFromEnv({ CLOCK_VOICE_ENABLED: '0' })).toBe(false)
    expect(clockVoiceEnabledFromEnv({ CLOCK_VOICE_ENABLED: 'false' })).toBe(false)
    expect(clockVoiceEnabledFromEnv({ CLOCK_VOICE_ENABLED: '1' })).toBe(true)
    expect(clockVoiceEnabledFromEnv({ CLOCK_VOICE_ENABLED: 'true' })).toBe(true)
  })

  it('settings: off by default, on only with an explicit true', () => {
    writeSettings({})
    expect(clockVoiceEnabledFromSettings()).toBe(false)
    writeSettings({ captureSources: { clock: { enabled: 'yes' } } })
    expect(clockVoiceEnabledFromSettings()).toBe(false)
    writeSettings({ captureSources: { clock: { enabled: true } } })
    expect(clockVoiceEnabledFromSettings()).toBe(true)
    fs.writeFileSync(path.join(tempDataDir, 'config', 'settings.json'), '{ corrupt')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(clockVoiceEnabledFromSettings()).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('needs BOTH: settings on + env off is off, env on + settings off is off', () => {
    writeSettings({ captureSources: { clock: { enabled: true } } })
    expect(clockVoiceEnabled({})).toBe(false)
    expect(clockVoiceEnabled({ CLOCK_VOICE_ENABLED: '1' })).toBe(true)
    writeSettings({ captureSources: { clock: { enabled: false } } })
    expect(clockVoiceEnabled({ CLOCK_VOICE_ENABLED: '1' })).toBe(false)
  })

  it('answers 404 with the switch off, without reading the body or calling the STT', async () => {
    enabled = false
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('not_found')
    const poll = await send({ method: 'GET', path: '/api/device/clock/voice/cap-1' })
    expect(poll.status).toBe(404)
    expect(transcribeCalls).toHaveLength(0)
    expect(turns).toHaveLength(0)
    expect(captureRows()).toHaveLength(0)
  })

  it('answers 404 when the router is not wired for voice', async () => {
    const res = await send({ body: pcm(1), targetPort: unwiredPort })
    expect(res.status).toBe(404)
  })

  it('checks the token BEFORE the switch: a stranger cannot even learn the route exists', async () => {
    enabled = false
    expect((await send({ token: null, body: pcm(1) })).status).toBe(401)
    expect((await send({ token: plainToken, body: pcm(1) })).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
describe('gates before the body (M3)', () => {
  it('refuses a missing / foreign / unknown token with 401', async () => {
    expect((await send({ token: null, body: pcm(1) })).status).toBe(401)
    expect((await send({ token: userJwt, body: pcm(1) })).status).toBe(401)
    expect((await send({ token: 'otc_doesnotexist', body: pcm(1) })).status).toBe(401)
    expect(transcribeCalls).toHaveLength(0)
  })

  it('refuses a token without clock:voice with 403 forbidden_scope', async () => {
    const res = await send({ token: plainToken, body: pcm(1) })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('forbidden_scope')
    expect(transcribeCalls).toHaveLength(0)
  })

  it('refuses a peer outside the allowlist with 403 not_lan, also with a valid token', async () => {
    const res = await send({ body: pcm(1), targetPort: gatedPort })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('not_lan')
    expect(transcribeCalls).toHaveLength(0)
  })

  it('refuses a forwarded request (tunnel/proxy header) with 403 not_lan', async () => {
    const res = await send({ body: pcm(1), headers: { 'X-Forwarded-For': '192.168.1.202' } })
    expect(res.status).toBe(403)
  })

  it('answers an auth failure without waiting for the body (body never read, no STT)', async () => {
    // Declares 400 kB, sends 1 kB and keeps the request open: a server that
    // read the body first would sit until the stall timeout.
    for (const token of [null, plainToken]) {
      const res = await send({ token, body: Buffer.alloc(1000), declaredLength: 400_000 })
      expect([401, 403]).toContain(res.status)
      expect(res.ms).toBeLessThan(250)
    }
    const lan = await send({ body: Buffer.alloc(1000), declaredLength: 400_000, targetPort: gatedPort })
    expect(lan.status).toBe(403)
    expect(lan.ms).toBeLessThan(250)
    expect(transcribeCalls).toHaveLength(0)
    expect(turns).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
describe('body limits (M3)', () => {
  it('refuses a declared Content-Length above 512 000 bytes at once with 413', async () => {
    const res = await send({ body: Buffer.alloc(1000), declaredLength: CLOCK_VOICE_MAX_BYTES + 2 })
    expect(res.status).toBe(413)
    expect(res.json.code).toBe('too_large')
    expect(res.ms).toBeLessThan(250)
    expect(transcribeCalls).toHaveLength(0)
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
  })

  it('stops a chunked stream as soon as it passes 512 000 bytes (413, no STT)', async () => {
    const chunk = Buffer.alloc(32_000)
    const res = await send({ chunks: Array.from({ length: 20 }, () => chunk), gapMs: 5 })
    expect(res.status).toBe(413)
    expect(transcribeCalls).toHaveLength(0)
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
  })

  it('accepts exactly 512 000 bytes', async () => {
    const res = await send({ body: Buffer.alloc(CLOCK_VOICE_MAX_BYTES, 1) })
    expect(res.status).toBe(200)
    expect(transcribeCalls).toEqual([{ bytes: CLOCK_VOICE_MAX_BYTES, rate: 16_000 }])
  })

  it('answers no_speech below 0.4 s (12 800 bytes) without calling the STT', async () => {
    const res = await send({ body: Buffer.alloc(CLOCK_VOICE_MIN_BYTES - 2) })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('no_speech')
    expect(transcribeCalls).toHaveLength(0)
    expect(turns).toHaveLength(0)
  })

  it('always transcribes at 16 kHz; a ?rate= is ignored', async () => {
    const res = await send({ body: pcm(1), path: '/api/device/clock/voice?rate=48000' })
    expect(res.status).toBe(200)
    expect(transcribeCalls[0].rate).toBe(16_000)
  })

  it('drops an odd trailing byte', async () => {
    await send({ body: Buffer.concat([pcm(1), Buffer.from([7])]) })
    expect(transcribeCalls[0].bytes % 2).toBe(0)
  })

  it('drops a stalled upload (slowloris) with 408 and frees the slot', async () => {
    const res = await send({ chunks: [Buffer.alloc(4000)], hang: true })
    expect(res.status).toBe(408)
    expect(res.json.code).toBe('upload_timeout')
    expect(res.ms).toBeGreaterThanOrEqual(250)
    expect(transcribeCalls).toHaveLength(0)
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
  })

  it('drops a trickling upload that never ends at the total timeout (408)', async () => {
    // 200 ms gaps stay under the 300 ms stall limit; the 1.5 s total cuts it.
    const res = await send({ chunks: Array.from({ length: 40 }, () => Buffer.alloc(100)), gapMs: 200 })
    expect(res.status).toBe(408)
    expect(res.ms).toBeGreaterThanOrEqual(1400)
    expect(res.ms).toBeLessThan(2500)
    expect(transcribeCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
describe('the transcript becomes a capture with source clock (K1)', () => {
  it('creates a capture source clock / kind voice, the router files it and the turn starts with the clock style', async () => {
    const res = await send({ body: pcm(1), headers: { 'X-Clock-Exchange': 'clk-1-1000' } })
    expect(res.status).toBe(200)
    const rows = captureRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: 'clock', kind: 'voice', status: 'filed', text: TRANSCRIPT_MARKER })
    expect(rows[0].client_message_id).toBe(clockClientMessageId(voiceDeviceId, 'clk-1-1000'))
    // The router saw the transcript and decided (no fixed strand).
    expect(routerCalls).toHaveLength(1)
    expect(routerCalls[0]).toContain(TRANSCRIPT_MARKER)
    const strand = db.prepare('SELECT title, agent_id FROM sessions WHERE id = ?').get(rows[0].strand_id) as { title: string; agent_id: string }
    expect(strand).toEqual({ title: 'Wetter morgen', agent_id: 'main' })
    expect(uhrStrands()).toHaveLength(0)
    // One turn, in the router's strand, with every tool (no tool policy) and the clock's style hint.
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: rows[0].strand_id, agentId: 'main', inputMode: 'voice' })
    expect(String(turns[0].text)).toContain(TRANSCRIPT_MARKER)
    expect((turns[0].turnOverrides as { styleHint?: string } | undefined)?.styleHint).toBe(DEFAULT_CLOCK_STYLE_HINT)
    expect(turns[0]).not.toHaveProperty('toolPolicy')
    // The answer of the route.
    expect(res.json).toMatchObject({
      exchange_id: rows[0].id,
      turn_id: 'turn-1',
      transcript: TRANSCRIPT_MARKER,
      intent: 'ask',
      band: 'high',
      strand_id: rows[0].strand_id,
      strand_title: 'Wetter morgen',
      persona: 'main',
      state: 'thinking',
      idempotent: false,
    })
  })

  it('appends into an existing strand when the router says so, like the app', async () => {
    const strand = sessionManager.createThread('1', 'coder', 'Deploy')
    route({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, rationale: 'deploy' })
    nextTranscript = 'Ist der Deploy gruen?'
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ strand_id: strand.id, strand_title: 'Deploy', persona: 'coder', state: 'thinking' })
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: strand.id, agentId: 'coder' })
    expect(captureRows()[0]).toMatchObject({ source: 'clock', strand_id: strand.id, status: 'filed' })
  })

  it('a low-confidence capture lands in the tray: no turn, state needs_choice', async () => {
    route({ action: 'new_strand', newStrand: { title: 'Irgendwas', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.2, rationale: 'unclear' })
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json.state).toBe('needs_choice')
    expect(res.json.band).toBe('low')
    expect(res.json.turn_id).toBeNull()
    expect(turns).toHaveLength(0)
    expect(captureRows()[0]).toMatchObject({ source: 'clock', status: 'unsorted', strand_id: null })
  })

  it('a capture the model calls a note is still answered, like in the app (no silent note category)', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Einkaufsliste')
    route({ action: 'append', strandId: strand.id, intent: 'note', confidence: 0.9, rationale: 'shopping' })
    nextTranscript = 'Milch kaufen'
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ state: 'thinking', strand_id: strand.id, turn_id: 'turn-1' })
    expect(turns).toHaveLength(1)
  })

  it('is idempotent per exchange id: a retry returns the same capture, no second router call or turn', async () => {
    const first = await send({ body: pcm(1), headers: { 'X-Clock-Exchange': 'clk-7-42' } })
    const again = await send({ body: pcm(1), headers: { 'X-Clock-Exchange': 'clk-7-42' } })
    expect(again.status).toBe(200)
    expect(again.json.exchange_id).toBe(first.json.exchange_id)
    expect(again.json.idempotent).toBe(true)
    expect(again.json.state).toBe('thinking')
    expect(again.json.turn_id).toBe('turn-1')
    expect(captureRows()).toHaveLength(1)
    expect(routerCalls).toHaveLength(1)
    expect(turns).toHaveLength(1)
  })

  it('without exchange header every upload is its own capture', async () => {
    await send({ body: pcm(1) })
    await send({ body: pcm(1) })
    expect(captureRows()).toHaveLength(2)
    expect(captureRows().every(r => r.client_message_id === null)).toBe(true)
  })

  it('refuses a malformed exchange id with 400 before the body and the STT', async () => {
    const res = await send({ body: pcm(1), headers: { 'X-Clock-Exchange': 'bad id with spaces' } })
    expect(res.status).toBe(400)
    expect(res.json.code).toBe('bad_exchange_id')
    expect(transcribeCalls).toHaveLength(0)
    expect(captureRows()).toHaveLength(0)
  })

  it('clientMessageId: device-bound, at most 63 chars, absent/malformed told apart', () => {
    const a = clockClientMessageId('dev-a', 'clk-1-1')
    const b = clockClientMessageId('dev-b', 'clk-1-1')
    expect(a).toMatch(/^clock:[0-9a-f]{8}:clk-1-1$/)
    expect(a).not.toBe(b)
    expect(clockClientMessageId('dev-a', 'x'.repeat(48))!.length).toBeLessThanOrEqual(63)
    expect(clockClientMessageId('dev-a', undefined)).toBeUndefined()
    expect(clockClientMessageId('dev-a', '')).toBeUndefined()
    expect(clockClientMessageId('dev-a', 'x'.repeat(49))).toBeNull()
    expect(clockClientMessageId('dev-a', 'a/b')).toBeNull()
  })

  it('uses a style hint from settings (captureSources.clock.styleHint), empty means none', async () => {
    writeSettings({ captureSources: { clock: { enabled: true, styleHint: 'Kurz bitte.' } } })
    await send({ body: pcm(1) })
    expect((turns[0].turnOverrides as { styleHint?: string }).styleHint).toBe('Kurz bitte.')
    writeSettings({ captureSources: { clock: { enabled: true, styleHint: '' } } })
    await send({ body: pcm(1) })
    expect((turns[1].turnOverrides as { styleHint?: string } | undefined)?.styleHint).toBeUndefined()
  })

  it('privacy mode hides transcript and strand title on the clock, the capture keeps the full text', async () => {
    new ClockDeviceRegistry(db).setPrivacy(1, voiceDeviceId, true)
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json.transcript).toBe('')
    expect(res.json.strand_title).toBeNull()
    expect(JSON.stringify(res.json)).not.toContain(TRANSCRIPT_MARKER)
    expect(JSON.stringify(res.json)).not.toContain('Wetter morgen')
    expect(captureRows()[0].text).toBe(TRANSCRIPT_MARKER)
  })

  it('a busy router strand queues the turn and reports the queue', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Lang')
    busySessions = [strand.id]
    route({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, rationale: 'busy' })
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json.strand_id).toBe(strand.id)
    expect(turns).toHaveLength(1)
  })

  it('never creates a strand "Uhr" across several questions', async () => {
    for (let i = 0; i < 3; i++) await send({ body: pcm(1) })
    expect(uhrStrands()).toHaveLength(0)
    expect(captureRows().map(r => r.source)).toEqual(['clock', 'clock', 'clock'])
  })
})

// ---------------------------------------------------------------------------
describe('one recording at a time per device (E6)', () => {
  it('a second request meanwhile gets 429, the slot frees afterwards', async () => {
    const slow = send({ chunks: Array.from({ length: 5 }, () => pcm(0.2)), gapMs: 100 })
    await waitFor(() => limiter.isRunning(voiceDeviceId))
    const second = await send({ body: pcm(1) })
    expect(second.status).toBe(429)
    expect(second.json.reason).toBe('running')
    expect((await slow).status).toBe(200)
    expect(limiter.isRunning(voiceDeviceId)).toBe(false)
    expect((await send({ body: pcm(1) })).status).toBe(200)
  })

  it('another clock of the same user is not blocked', async () => {
    const other = new ClockDeviceRegistry(db).create(1, { name: 'Küche', scopes: ['clock:voice'] })
    const slow = send({ chunks: Array.from({ length: 5 }, () => pcm(0.2)), gapMs: 100 })
    await waitFor(() => limiter.isRunning(voiceDeviceId))
    expect((await send({ body: pcm(1), token: other.token })).status).toBe(200)
    expect((await slow).status).toBe(200)
  })

  it('has no per-minute limit any more: ten in a row all pass', async () => {
    for (let i = 0; i < 10; i++) expect((await send({ body: pcm(0.5) })).status).toBe(200)
    expect(transcribeCalls).toHaveLength(10)
  })

  it('limiter: one slot per device', () => {
    const l = new ClockVoiceRateLimiter()
    expect(l.acquire('a').ok).toBe(true)
    expect(l.acquire('a')).toEqual({ ok: false, reason: 'running' })
    expect(l.acquire('b').ok).toBe(true)
    l.release('a')
    expect(l.acquire('a').ok).toBe(true)
  })

  it('frees the slot when the client aborts mid-upload', async () => {
    const res = await send({ chunks: Array.from({ length: 20 }, () => pcm(0.1)), gapMs: 50, abortAfterMs: 150 })
    expect(res.status).toBe(0)
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
    expect(transcribeCalls).toHaveLength(0)
    expect((await send({ body: pcm(1) })).status).toBe(200)
  })

  it('frees the slot when the client goes away during the STT', async () => {
    transcribeDelayMs = 300
    await send({ body: pcm(1), abortAfterMs: 100 })
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
  })

  it('creates no capture when the client hung up during the STT (review B1, m-1)', async () => {
    transcribeDelayMs = 300
    const res = await send({ body: pcm(1), abortAfterMs: 100 })
    expect(res.status).toBe(0)
    expect(await waitFor(() => !limiter.isRunning(voiceDeviceId))).toBe(true)
    expect(transcribeCalls).toHaveLength(1)
    expect(captureRows()).toHaveLength(0)
    expect(turns).toHaveLength(0)
    transcribeDelayMs = 0
    expect((await send({ body: pcm(1) })).status).toBe(200)
    expect(turns).toHaveLength(1)
  })

  it('frees the slot after an STT error (502 stt_failed, no capture)', async () => {
    nextTranscript = new Error('provider down')
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(502)
    expect(res.json.code).toBe('stt_failed')
    expect(captureRows()).toHaveLength(0)
    expect(limiter.isRunning(voiceDeviceId)).toBe(false)
    nextTranscript = TRANSCRIPT_MARKER
    expect((await send({ body: pcm(1) })).status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
describe('phantom transcripts (m3)', () => {
  it.each([
    [''],
    ['   '],
    ['.'],
    ['Ä'],
    ['Untertitel der Amara.org-Community'],
    ['Vielen Dank fürs Zuschauen!'],
    ['[Musik]'],
    ['Thank you for watching.'],
  ])('%j -> no_speech, no turn', async (text) => {
    nextTranscript = text
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('no_speech')
    expect(turns).toHaveLength(0)
  })

  it('keeps real short questions', () => {
    expect(isPhantomTranscript('Wie spät ist es?')).toBe(false)
    expect(isPhantomTranscript('Ja')).toBe(false)
    expect(isPhantomTranscript('Danke dir, und was steht morgen an?')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
describe('GET /voice/:exchangeId: text back-channel, long poll with cursor (K2)', () => {
  const poll = (id: unknown, query = '', token?: string) =>
    send({ method: 'GET', path: `/api/device/clock/voice/${String(id)}${query}`, ...(token ? { token } : {}) })

  it('a question gets its answer as text over the long poll', async () => {
    const post = await send({ body: pcm(1) })
    expect(post.json).toMatchObject({ state: 'thinking', phase: 'thinking', cursor: 0, turn_id: 'turn-1' })
    const id = post.json.exchange_id
    const waiting = poll(id, '?cursor=0&state=thinking&wait=2000')
    setTimeout(() => answerTurn('turn-1', 'Morgen wird es sonnig.\n\nDetails: Hoch über Skandinavien.'), 50)
    const first = await waiting
    expect(first.status).toBe(200)
    expect(first.ms).toBeGreaterThanOrEqual(40)
    expect(first.json).toMatchObject({ exchange_id: id, state: 'done', text_delta: 'Morgen wird es sonnig.', spoken_done: true })
    expect(first.json.cursor).toBe('Morgen wird es sonnig.'.length)
    // Terminal: the next poll returns at once with an empty delta.
    const again = await poll(id, `?cursor=${String(first.json.cursor)}&state=done&wait=2000`)
    expect(again.ms).toBeLessThan(1000)
    expect(again.json).toMatchObject({ state: 'done', text_delta: '' })
  })

  it('is idempotent: the same cursor twice gives the same delta', async () => {
    const post = await send({ body: pcm(1) })
    answerTurn('turn-1', 'Ja. Das geht.')
    const a = await poll(post.json.exchange_id, '?cursor=0&wait=0')
    const b = await poll(post.json.exchange_id, '?cursor=0&wait=0')
    expect(a.json.text_delta).toBe('Ja. Das geht.')
    expect(b.json).toEqual(a.json)
    const tail = await poll(post.json.exchange_id, '?cursor=4&wait=0')
    expect(tail.json.text_delta).toBe('Das geht.')
    expect(tail.json.cursor).toBe(a.json.cursor)
  })

  it('a long poll without news ends after `wait` with the unchanged state', async () => {
    const post = await send({ body: pcm(1) })
    const res = await poll(post.json.exchange_id, '?cursor=0&state=thinking&wait=150')
    expect(res.ms).toBeGreaterThanOrEqual(140)
    expect(res.json).toMatchObject({ state: 'thinking', text_delta: '', cursor: 0 })
  })

  it('a note the user declares gets no turn: "Notiert: <title>"', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Einkaufsliste')
    route({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.9, rationale: 'shopping' })
    nextTranscript = 'Notiz: Milch kaufen'
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ state: 'filed', phase: 'noted', intent: 'note', turn_id: null })
    expect(turns).toHaveLength(0)
    const view = await poll(res.json.exchange_id, '?cursor=0&state=noted&wait=2000')
    expect(view.ms).toBeLessThan(1000)
    expect(view.json).toMatchObject({ state: 'noted', text_delta: 'Notiert: Einkaufsliste', spoken_done: true })
    expect(clockSaysNote('Das ist nur als Notiz gedacht')).toBe(true)
    expect(clockSaysNote('Notizbuch kaufen?')).toBe(false)
  })

  it('reports needs_choice for a tray capture without a turn', async () => {
    route({ action: 'new_strand', newStrand: { title: 'X', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.2, rationale: 'unclear' })
    const tray = await send({ body: pcm(1) })
    expect((await poll(tray.json.exchange_id, '?wait=0')).json).toMatchObject({ state: 'needs_choice', text_delta: 'Rückfrage in der App' })
  })

  // Review K0-K2, MAJOR-2: a stored question without a started turn is no note.
  it('the reviewer probe: a filed question without turn ids is an error, not "filed"', () => {
    const result = { created: true, capture: { status: 'filed' }, decision: { intent: 'ask' }, turnIds: [] }
    expect(clockExchangeState(result as never)).toBe('error')
    const note = { created: true, capture: { status: 'filed' }, decision: { intent: 'note' }, turnIds: [] }
    expect(clockExchangeState(note as never)).toBe('filed')
  })

  it.each([['none'], ['absent']] as const)('a question whose runner gives no turn (%s) ends as error, never "Notiert"', async (mode) => {
    runnerMode = mode
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ state: 'error', phase: 'error', error: 'turn_unavailable', turn_id: null, intent: 'ask' })
    const view = await poll(res.json.exchange_id, '?cursor=0&wait=2000')
    expect(view.ms).toBeLessThan(1000)
    expect(view.json).toMatchObject({ state: 'error', error: 'turn_unavailable', text_delta: '', spoken_done: true })
    expect(JSON.stringify(view.json)).not.toContain('Notiert')
  })

  it('a medium band question without runner is an error too, not "Notiert"', async () => {
    runnerMode = 'absent'
    const strand = sessionManager.createThread('1', 'main', 'Wetter')
    route({ action: 'append', strandId: strand.id, intent: 'ask', confidence: 0.75, rationale: 'weather' })
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ state: 'error', phase: 'error', error: 'turn_unavailable', turn_id: null })
  })

  // Review K0-K2, MINOR-2: the route's watch() subscription outlived a
  // turnless or finished exchange. User 2 has its own device, so the
  // subscriptions left by the other tests (user 1) do not count.
  it('the turn subscription ends with a turnless exchange and with the last turn', async () => {
    const own = new ClockDeviceRegistry(db).create(2, { name: 'TC002-b', scopes: ['clock:voice'] })
    const subs = () => turnSubscribers.filter(s => s.user === '2').length
    expect(subs()).toBe(0)
    runnerMode = 'none'
    const lost = await send({ body: pcm(1), token: own.token })
    expect(lost.json).toMatchObject({ state: 'error', error: 'turn_unavailable' })
    expect(subs()).toBe(0)

    runnerMode = 'ids'
    const res = await send({ body: pcm(1), token: own.token })
    expect(res.status).toBe(200)
    expect(subs()).toBe(1)
    answerTurn(String(res.json.turn_id), 'Morgen wird es sonnig.')
    expect(subs()).toBe(0)
    const view = await poll(String(res.json.exchange_id), '?cursor=0', own.token)
    expect(view.json).toMatchObject({ state: 'done', text_delta: 'Morgen wird es sonnig.' })
  })

  // Review K0-K2, MAJOR-4: part 0 low (tray), part 1 high with a turn.
  it('a split whose part 0 has no turn does not speak part 1', async () => {
    nextTranscript = 'Das Dach tropft seit dem Sturm. Ich brauche einen Dachdecker. Wie wird das Wetter am Montag? Ich will dann den Termin machen.'
    splitAnswers = [
      JSON.stringify({
        topics: [
          { id: 'A', title: 'Dach', sentenceIds: [1, 2] },
          { id: 'B', title: 'Wetter Montag', sentenceIds: [3, 4] },
        ],
        uncertain: [], splitConfidence: 0.93, rationale: 'two matters',
      }),
      'Das Dach tropft seit dem Sturm, ich brauche einen Dachdecker.',
      'Wie wird das Wetter am Montag, ich will dann den Termin machen?',
    ]
    route({ action: 'new_strand', newStrand: { title: 'Dach', personaId: 'main', tags: [] }, intent: 'note', confidence: 0.2, rationale: 'unclear' })
    route({ action: 'new_strand', newStrand: { title: 'Wetter Montag', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.95, rationale: 'weather' })
    const res = await send({ body: pcm(1) })
    expect(res.status).toBe(200)
    expect(res.json.parts).toBe(2)
    expect(turns).toHaveLength(1)
    expect(res.json).toMatchObject({ state: 'needs_choice', phase: 'needs_choice', turn_id: null })
    answerTurn('turn-1', 'Antwort des zweiten Teils.')
    const view = await poll(res.json.exchange_id, '?cursor=0&wait=0')
    expect(view.json).toMatchObject({ state: 'needs_choice', text_delta: 'Rückfrage in der App', answer_ready: true })
    expect(JSON.stringify(view.json)).not.toContain('zweiten Teils')
  })

  it('a repeated upload keeps the exchange: same id, the poll continues', async () => {
    const headers = { 'x-clock-exchange': 'ex-k2-1' }
    const first = await send({ body: pcm(1), headers })
    emitTurn({ type: 'chunk', turnId: 'turn-1', chunk: { type: 'text', text: 'Erster Satz. ' } })
    const again = await send({ body: pcm(1), headers })
    expect(again.json).toMatchObject({ exchange_id: first.json.exchange_id, idempotent: true })
    expect(turns).toHaveLength(1)
    const view = await poll(first.json.exchange_id, '?cursor=0&wait=0')
    expect(view.json).toMatchObject({ state: 'speaking', text_delta: 'Erster Satz.' })
  })

  it('keeps the text off the clock in privacy mode', async () => {
    const post = await send({ body: pcm(1) })
    answerTurn('turn-1', 'Geheime Antwort.')
    new ClockDeviceRegistry(db).setPrivacy(1, voiceDeviceId, true)
    const done = await poll(post.json.exchange_id, '?wait=0')
    expect(done.json).toMatchObject({ state: 'done', text_delta: '', strand_title: null })
  })

  it('marks a task the answer started as "from your question" in the clock state (E4)', async () => {
    const post = await send({ body: pcm(1) })
    emitTurn({ type: 'chunk', turnId: 'turn-1', chunk: { type: 'text', text: 'Ich starte das im Hintergrund. ' } })
    emitTurn({ type: 'chunk', turnId: 'turn-1', chunk: { type: 'tool_call_end', toolName: 'create_task', toolResult: { details: { taskId: 'task-k2' } } } })
    answerTurn('turn-1', '')
    const view = await poll(post.json.exchange_id, '?wait=0')
    expect(view.json.task_ids).toEqual(['task-k2'])
    // Owned like every user task: through the strand that started it.
    db.prepare(
      `INSERT INTO tasks (id, name, prompt, status, trigger_type, trigger_source_id, session_id, agent_id, completed_at)
       VALUES ('task-k2', 'Recherche', 'p', 'completed', 'user', ?, 'task-session-k2', 'main', datetime('now'))`,
    ).run(post.json.strand_id)
    db.prepare(
      `INSERT INTO sessions (id, user_id, agent_id, title, type, parent_session_id) VALUES ('task-session-k2', NULL, 'main', 'Task', 'task', ?)`,
    ).run(post.json.strand_id)
    const state = await send({ method: 'GET', path: '/api/device/clock/state' })
    expect(state.status).toBe(200)
    const event = (state.json.events as Array<Record<string, unknown>>).find(e => e.type === 'task_done')
    expect(event).toMatchObject({ from_question: true })
  })

  it('answers 404 for an unknown exchange and for the exchange of another clock, 403 without scope', async () => {
    const post = await send({ body: pcm(1) })
    expect((await poll('nope')).status).toBe(404)
    const other = new ClockDeviceRegistry(db).create(1, { name: 'Küche', scopes: ['clock:voice'] })
    expect((await poll(post.json.exchange_id, '', other.token)).status).toBe(404)
    expect((await poll(post.json.exchange_id, '', plainToken)).status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
describe('logging (m2)', () => {
  it('writes neither the token nor the transcript to the console, also on errors', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}))
    try {
      await send({ body: pcm(1) })
      await send({ body: pcm(1), token: 'otc_wrong' })
      nextTranscript = new Error(`provider down while hearing "${TRANSCRIPT_MARKER}"`)
      await send({ body: pcm(1) })
      nextTranscript = 'Vielen Dank fürs Zuschauen'
      await send({ body: pcm(1) })
      await send({ chunks: [Buffer.alloc(1000)], hang: true })
      const logged = spies.flatMap(s => s.mock.calls).map(args => args.map(a => String(a)).join(' ')).join('\n')
      expect(logged).not.toContain(voiceToken)
      expect(logged).not.toContain('otc_')
      expect(logged).not.toContain(TRANSCRIPT_MARKER)
      expect(logged).not.toContain('Zuschauen')
    } finally {
      spies.forEach(s => s.mockRestore())
    }
  })
})

// ---------------------------------------------------------------------------
describe('token scopes (M2)', () => {
  it('creates new tokens with clock:state + clock:answer only, without clock:voice', () => {
    const { device } = new ClockDeviceRegistry(db).create(1, { name: 'Neu' })
    expect(device.scopes).toEqual(['clock:state', 'clock:answer'])
    expect(CLOCK_DEFAULT_SCOPES).not.toContain('clock:voice')
  })

  it('grants clock:voice only when asked for explicitly', () => {
    const { device } = new ClockDeviceRegistry(db).create(1, { name: 'Neu', scopes: ['clock:state', 'clock:voice'] })
    expect(device.scopes).toEqual(['clock:state', 'clock:voice'])
  })

  it('refuses unknown, empty or malformed scopes', () => {
    expect(() => normaliseClockScopes(['clock:state', 'chat:write'])).toThrow(ClockScopeError)
    expect(() => normaliseClockScopes([])).toThrow(ClockScopeError)
    expect(() => normaliseClockScopes('clock:voice')).toThrow(ClockScopeError)
    expect(() => normaliseClockScopes([42])).toThrow(ClockScopeError)
    expect(() => new ClockDeviceRegistry(db).create(1, { name: 'X', scopes: ['admin'] })).toThrow(ClockScopeError)
  })

  it('leaves existing devices untouched (no auto upgrade to clock:voice)', () => {
    db.prepare(
      `INSERT INTO clock_devices (id, user_id, name, token_hash, scopes, privacy)
       VALUES ('clk_3078dbd56da9', 1, 'TC002', ?, 'clock:state clock:answer', 0)`,
    ).run('a'.repeat(64))
    new ClockDeviceRegistry(db).create(1, { name: 'Neu', scopes: ['clock:voice'] })
    const device = new ClockDeviceRegistry(db).get(1, 'clk_3078dbd56da9')!
    expect(device.scopes).toEqual(['clock:state', 'clock:answer'] satisfies ClockScope[])
  })

  async function postDevice(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/device/clock/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userJwt}` },
      body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }

  it('POST /devices: default without voice, explicit voice, unknown scope -> 400 invalid_scopes', async () => {
    const plain = await postDevice({ name: 'A' })
    expect(plain.status).toBe(201)
    expect((plain.json.device as { scopes: string[] }).scopes).toEqual(['clock:state', 'clock:answer'])
    const voice = await postDevice({ name: 'B', scopes: ['clock:state', 'clock:answer', 'clock:voice'] })
    expect(voice.status).toBe(201)
    expect((voice.json.device as { scopes: string[] }).scopes).toContain('clock:voice')
    const bad = await postDevice({ name: 'C', scopes: ['clock:voice', 'strands:write'] })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('invalid_scopes')
    const notArray = await postDevice({ name: 'D', scopes: 'clock:voice' })
    expect(notArray.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
