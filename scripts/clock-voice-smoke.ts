/**
 * Local smoke server for the clock voice route (stage 3, companion K1). NOT
 * for live use.
 *
 * Starts the real clock-device router and the real captures service (the one
 * `POST /api/captures` uses) on 127.0.0.1 with a throw-away in-memory
 * database, a real SessionManager and a settings.json in a temp DATA_DIR.
 * Stubs: the STT (fixed transcript, or the one set via POST /smoke/transcript),
 * the router model (answers from a queue: first append into "Wetter", then a
 * new strand) and the turn runner (records the turn, returns a turn id and,
 * K2, streams a canned answer to its TurnRunner.subscribe subscribers in
 * small chunks, so the long poll GET /voice/:id has something to follow).
 * Prints one JSON line with port and tokens, then serves until killed.
 *
 *   npx tsx scripts/clock-voice-smoke.ts [--env] [--settings]
 *
 * The switches are the REAL ones (no isEnabled override):
 *   --env       sets CLOCK_VOICE_ENABLED=1 for this process only
 *   --settings  writes captureSources.clock.enabled=true into the temp settings
 * Without both the route must answer 404 (default: both off).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, ResolvedRouterModel } from '@axiom/core'
import { createClockDeviceRouter } from '../packages/web-backend/src/api/modules/clock-device/route.js'
import { ClockDeviceRegistry } from '../packages/web-backend/src/api/modules/clock-device/registry.js'
import { createCapturesRouters } from '../packages/web-backend/src/api/modules/captures/route.js'
import { ChatEventBus } from '../packages/web-backend/src/chat-event-bus.js'

const envOn = process.argv.includes('--env')
const settingsOn = process.argv.includes('--settings')
if (envOn) process.env.CLOCK_VOICE_ENABLED = '1'
else delete process.env.CLOCK_VOICE_ENABLED

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clock-voice-smoke-'))
process.env.DATA_DIR = dataDir
fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
fs.writeFileSync(
  path.join(dataDir, 'config', 'settings.json'),
  JSON.stringify(settingsOn ? { captureSources: { clock: { enabled: true } } } : {}),
)

const db = initDatabase(':memory:')
db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('smoke', 'x', 'admin')
const sessions = new SessionManager({ db, memoryDir: path.join(dataDir, 'memory'), timeoutMinutes: 0 })
sessions.createThread('1', 'main', 'Einkauf')
const wetter = sessions.createThread('1', 'main', 'Wetter')
const registry = new ClockDeviceRegistry(db)
const voiceToken = registry.create(1, { name: 'Smoke', scopes: ['clock:state', 'clock:answer', 'clock:voice'] }).token
const plainToken = registry.create(1, { name: 'Smoke-alt' }).token

let turnNo = 0
type SmokeEvent = { type: string; turnId: string; sessionId?: string; chunk?: { type: string; text?: string } }
const subscribers = new Map<string, Set<(event: SmokeEvent) => void>>()
const emit = (user: string, event: SmokeEvent) => { for (const fn of subscribers.get(user) ?? []) fn(event) }
// A persona answer that follows the clock style (H2): one spoken core
// paragraph, then markdown for the app. Streamed in small pieces.
const ANSWER = 'Morgen wird es sonnig, bis 21 Grad. Am Abend frischt der Wind auf.\n\n'
  + '**Details:**\n- Wind aus West, 20 km/h\n- Regenrisiko 10 %\n\n[Quelle](https://example.invalid)'
const runner = {
  hasActiveTurnInSession: () => false,
  subscribe: (user: number | string, fn: (event: SmokeEvent) => void) => {
    const key = String(user)
    let set = subscribers.get(key)
    if (!set) { set = new Set(); subscribers.set(key, set) }
    set.add(fn)
    return () => { set!.delete(fn) }
  },
  startTurn: (input: Record<string, unknown>) => {
    turnNo++
    const turnId = `smoke-turn-${turnNo}`
    const user = String(input.userId ?? '1')
    const hint = (input.turnOverrides as { styleHint?: string } | undefined)?.styleHint
    process.stderr.write(`[smoke] turn ${turnNo} -> strand ${String(input.sessionId)} agent=${String(input.agentId)} inputMode=${String(input.inputMode)} styleHint=${hint ? 'clock' : 'none'}\n`)
    // Stream like a model: start after 300 ms, then 12 characters every 80 ms.
    const pieces = ANSWER.match(/[\s\S]{1,12}/g) ?? []
    setTimeout(() => {
      emit(user, { type: 'turn_start', turnId, sessionId: String(input.sessionId) })
      pieces.forEach((text, i) => setTimeout(() => emit(user, { type: 'chunk', turnId, chunk: { type: 'text', text } }), 80 * (i + 1)))
      setTimeout(() => {
        emit(user, { type: 'chunk', turnId, chunk: { type: 'done' } })
        emit(user, { type: 'turn_end', turnId })
      }, 80 * (pieces.length + 2))
    }, 300)
    return { turnId }
  },
}
let nextTranscript: string | null = null

// Router model stub: first question -> append into "Wetter", then new strands.
const routerAnswers = [
  { action: 'append', strandId: wetter.id, intent: 'ask', confidence: 0.9, rationale: 'weather' },
]
const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]
const agentCore = { getSessionManager: () => sessions } as unknown as AgentCore
const captures = createCapturesRouters({
  db,
  getAgentCore: () => agentCore,
  chatEventBus: new ChatEventBus(),
  getTurnRunner: () => runner as never,
  routerChain: () => chain,
  getNowSetMode: () => 'manual',
  splitComplete: async () => { throw new Error('no split in the smoke') },
  routerComplete: async () => {
    const next = routerAnswers.shift()
      ?? { action: 'new_strand', newStrand: { title: 'Smoke neu', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9, rationale: 'new topic' }
    process.stderr.write(`[smoke] router -> ${next.action}\n`)
    return JSON.stringify(next)
  },
} as never)

const app = express()
app.use(express.json())
app.use('/api/device/clock', createClockDeviceRouter({
  db,
  getInteractions: () => { throw new Error('not used in the smoke') },
  allowedCidrs: '127.0.0.1/32',
  voice: {
    // No isEnabled override: the real two switches (env + settings) decide.
    getCaptures: () => captures.service,
    getTurnRunner: () => runner as never,
    // STT mock: reports what it got instead of calling a provider.
    transcribe: async (pcm, rate) => {
      const transcript = nextTranscript ?? `Testfrage mit ${pcm.length} Bytes bei ${rate} Hertz`
      nextTranscript = null
      return { transcript }
    },
    // No H3 model in the smoke: the canned answer follows H2.
    shorten: null,
  },
}))
// Smoke-only: the STT mock returns this text for the next upload.
app.post('/smoke/transcript', (req, res) => {
  nextTranscript = typeof req.body?.text === 'string' ? req.body.text : null
  res.json({ ok: true })
})
// Smoke-only: the router stub answers the next capture with this decision.
app.post('/smoke/router', (req, res) => {
  if (req.body && typeof req.body === 'object') routerAnswers.push(req.body)
  res.json({ ok: true })
})
app.get('/smoke/turns', (_req, res) => { res.json({ turns: turnNo }) })
// Read-only debug views for the smoke script.
app.get('/smoke/captures', (_req, res) => {
  res.json(db.prepare('SELECT source, kind, status, strand_id, client_message_id FROM captures ORDER BY rowid').all())
})
app.get('/smoke/strands', (_req, res) => {
  res.json(db.prepare("SELECT id, title, agent_id FROM sessions WHERE type = 'interactive' ORDER BY rowid").all())
})

const server = http.createServer(app)
server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as { port: number }).port
  process.stdout.write(`${JSON.stringify({ port, voiceToken, plainToken, envOn, settingsOn, wetterId: wetter.id })}\n`)
})
const stop = () => { server.close(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
