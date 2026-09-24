/**
 * Capture mode „Kurzfrage" (U10a) over the real HTTP path.
 *
 * The mode exists for a device without a screen: a question is spoken into a
 * puck and the answer has to come back as speech, quickly, without anybody
 * picking a strand. What is proven here:
 *   - the router is never called (`calls` stays 0) and the capture is `filed`
 *     with intent `ask`, so a turn runs at once
 *   - the decision row says `model: 'quick-mode'` — a quick filing is
 *     countable and claims no confidence the server did not compute
 *   - the SECOND quick capture of the same source lands in the SAME strand
 *     (the one the first one created), and the third too
 *   - a different source gets its own strand, so a puck and a watch do not
 *     talk into each other's thread
 *   - an archived quick strand is not resurrected, the next capture opens a
 *     fresh one
 *   - the turn is started with the configured model AND with the turn-local
 *     thinking level plus the style hint of mode and source
 *   - an explicit client model pin outranks the configured one
 *   - a configured model that is not selectable costs no answer: the turn runs
 *     on the persona model
 *   - `mode: 'quick'` plus a `strandId` (the puck's follow-up) files into that
 *     strand and still answers in the mode's voice
 *   - `mode: 'work'`, what the puck sends otherwise, behaves exactly as before
 *     apart from the device hint: a working capture from the puck keeps the
 *     persona's model and thinking level and only gets the source style hint
 *     (nothing at all when that hint is blank)
 *   - the silence guard still wins: `* Musik *` is dismissed, no turn, no
 *     strand
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ModelSelection, ResolvedRouterModel, Thread, TurnRuntimeOverrides } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

interface StartedTurn {
  sessionId: string
  text: string
  turnModelOverride?: ModelSelection
  turnOverrides?: TurnRuntimeOverrides
}

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let turns: StartedTurn[] = []
let calls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

function writeSettings(quick: Record<string, unknown>, puckStyleHint = 'Halte es unter zwanzig Woertern.'): void {
  fs.writeFileSync(
    path.join(tempDataDir, 'config', 'settings.json'),
    JSON.stringify({ captureModes: { quick }, captureSources: { puck: { styleHint: puckStyleHint } } }, null, 2),
    'utf-8',
  )
}

function writeProviders(): void {
  fs.writeFileSync(
    path.join(tempDataDir, 'config', 'providers.json'),
    JSON.stringify({
      providers: [{
        id: 'fast', name: 'Fast', type: 'openai-compatible', baseUrl: 'https://example.invalid/v1',
        apiKey: '', enabledModels: ['tiny', 'other'], status: 'ok',
      }],
      activeProvider: 'fast',
      activeModel: 'other',
    }, null, 2),
    'utf-8',
  )
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-quick-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  writeProviders()
  writeSettings({ providerId: 'fast', modelId: 'tiny', thinkingLevel: 'off', styleHint: 'Antworte in zwei Saetzen.' })

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = express()
  app.use(express.json())
  const captures = createCapturesRouters({
    db,
    getAgentCore: () => agentCore,
    chatEventBus: new ChatEventBus(),
    getTurnRunner: () => ({
      startTurn: (input) => {
        turns.push({
          sessionId: input.sessionId,
          text: input.text,
          turnModelOverride: input.turnModelOverride,
          turnOverrides: input.turnOverrides,
        })
        return {}
      },
    }),
    routerChain: () => chain,
    routerComplete: async () => {
      calls += 1
      throw new Error('the quick mode must not call the router')
    },
  })
  app.use('/api/captures', captures.captures)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())))
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

beforeEach(() => {
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM captures; DELETE FROM router_decisions; DELETE FROM tags; DELETE FROM strand_tags; DELETE FROM strand_links; DELETE FROM now_set;')
  turns = []
  calls = 0
  writeSettings({ providerId: 'fast', modelId: 'tiny', thinkingLevel: 'off', styleHint: 'Antworte in zwei Saetzen.' })
})

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

async function quick(text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; capture: Capture; decision: Decision }> {
  const res = await api('POST', '/api/captures', { text, mode: 'quick', source: 'puck', ...extra })
  return { status: res.status, capture: res.body.capture as Capture, decision: res.body.decision as Decision }
}

describe('POST /api/captures with mode=quick', () => {
  it('files and answers without ever asking the router', async () => {
    const res = await quick('Wie weit ist es nach Graz?')

    expect(res.status).toBe(201)
    expect(calls).toBe(0)
    expect(res.capture.status).toBe('filed')
    expect(res.decision.intent).toBe('ask')
    expect(res.decision.action).toBe('new_strand')
    expect(res.decision.state).toBe('applied')

    const row = db.prepare('SELECT model, rationale, created_strand_id FROM router_decisions WHERE capture_id = ?')
      .get(res.capture.id) as { model: string; rationale: string; created_strand_id: string | null }
    expect(row.model).toBe('quick-mode')
    expect(row.rationale).toContain('Kurzfrage-Modus')
    expect(row.created_strand_id).toBe(res.capture.strandId)

    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe(res.capture.strandId)
  })

  it('reuses the strand of the previous quick capture from the same source', async () => {
    const first = await quick('Erste Frage?')
    const second = await quick('Zweite Frage?')
    const third = await quick('Dritte Frage?')

    expect(second.capture.strandId).toBe(first.capture.strandId)
    expect(third.capture.strandId).toBe(first.capture.strandId)
    expect(second.decision.action).toBe('append')
    expect(turns.map(t => t.sessionId)).toEqual([
      first.capture.strandId, first.capture.strandId, first.capture.strandId,
    ])

    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(1)
  })

  it('gives a different source its own strand', async () => {
    const puck = await quick('Frage vom Puck?')
    const watch = await api('POST', '/api/captures', { text: 'Frage von der Uhr?', mode: 'quick', source: 'watch' })
    const watchCapture = watch.body.capture as Capture

    expect(watch.status).toBe(201)
    expect(watchCapture.strandId).not.toBe(puck.capture.strandId)
    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(2)
  })

  it('opens a fresh strand when the quick strand was archived', async () => {
    const first = await quick('Frage eins?')
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(first.capture.strandId)

    const second = await quick('Frage zwei?')
    expect(second.capture.strandId).not.toBe(first.capture.strandId)
    expect(second.decision.action).toBe('new_strand')
  })

  it('uses the configured strand title and the default persona', async () => {
    writeSettings({ providerId: '', modelId: '', thinkingLevel: 'off', styleHint: '', strandTitle: 'Zurufe' })
    const res = await quick('Titelprobe?')
    const strand = sessionManager.getThread('1', res.capture.strandId!) as Thread
    expect(strand.title).toBe('Zurufe')
    expect(strand.agentId).toBe('main')
  })

  it('runs the turn with the configured model and the turn-local thinking level and style', async () => {
    writeSettings({ providerId: 'fast', modelId: 'tiny', thinkingLevel: 'medium', styleHint: 'Antworte in zwei Saetzen.' })
    await quick('Womit faerbt man Wolle?')

    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnModelOverride).toEqual({ providerId: 'fast', modelId: 'tiny' })
    expect(turns[0]!.turnOverrides?.thinkingLevel).toBe('medium')
    // Mode hint first, source hint second: both are in force, neither replaces
    // the other.
    expect(turns[0]!.turnOverrides?.styleHint).toBe('Antworte in zwei Saetzen. Halte es unter zwanzig Woertern.')
    // The style instruction is NOT part of what gets stored as the message.
    expect(turns[0]!.text).toBe('Womit faerbt man Wolle?')
    const stored = db.prepare('SELECT content FROM chat_messages WHERE role = ?').get('user') as { content: string }
    expect(stored.content).toBe('Womit faerbt man Wolle?')
  })

  it('lets an explicit client pin outrank the configured model', async () => {
    const res = await quick('Welches Modell?', { modelProviderId: 'fast', modelId: 'other' })
    expect(res.status).toBe(201)
    expect(turns[0]!.turnModelOverride).toEqual({ providerId: 'fast', modelId: 'other' })
  })

  it('falls back to the persona model when the configured pair is gone', async () => {
    writeSettings({ providerId: 'fast', modelId: 'deleted-model', thinkingLevel: 'low', styleHint: '' })
    const res = await quick('Trotzdem eine Antwort?')

    expect(res.status).toBe(201)
    expect(res.capture.status).toBe('filed')
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnModelOverride).toBeUndefined()
    expect(turns[0]!.turnOverrides?.thinkingLevel).toBe('low')
  })

  it('lets a named strand outrank the quick strand but keeps the delivery', async () => {
    // What puck firmware 0.9.0 sends for a follow-up: mode quick AND the
    // strand of the answer it is following up on, plus intent ask. The strand
    // is one the puck itself opened, which is the only kind a device may name
    // (capture guard `explicit_strand_not_allowed`).
    const first = await quick('Wie weit ist es nach Graz?')
    const strand = { id: first.capture.strandId! }
    turns = []
    const res = await api('POST', '/api/captures', {
      text: 'Und wie lange dauert das?', mode: 'quick', source: 'puck', strandId: strand.id, intent: 'ask',
    })

    expect(res.status).toBe(201)
    expect(calls).toBe(0)
    const capture = res.body.capture as Capture
    expect(capture.strandId).toBe(strand.id)
    expect(capture.status).toBe('filed')
    expect(turns).toHaveLength(1)
    expect(turns[0]!.sessionId).toBe(strand.id)
    // The strand decided where, the mode still decided how.
    expect(turns[0]!.turnModelOverride).toEqual({ providerId: 'fast', modelId: 'tiny' })
    expect(turns[0]!.turnOverrides?.styleHint).toBe('Antworte in zwei Saetzen. Halte es unter zwanzig Woertern.')
  })

  it('treats mode work — what the puck sends otherwise — exactly like no mode', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Ein Thema')
    const res = await api('POST', '/api/captures', {
      text: 'Noch ein Gedanke dazu', mode: 'work', source: 'web', strandId: strand.id,
    })

    expect(res.status).toBe(201)
    const capture = res.body.capture as Capture
    expect(capture.strandId).toBe(strand.id)
    // No mode is stored for `work`, and no turn overrides are attached.
    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(capture.id) as { metadata: string | null }
    expect(JSON.parse(row.metadata ?? '{}').mode).toBeUndefined()
    expect(turns[0]?.turnOverrides).toBeUndefined()
  })

  it('gives a working puck capture the device hint but not the mode model', async () => {
    // U10a point 4: work stays work (persona model, persona thinking level),
    // but the answer is still read out on a device without a screen, so the
    // source hint travels with it.
    // The strand is one the puck itself opened (a quick capture), the only
    // kind a device may name — the explicit-target guard is untouched here.
    const first = await quick('Wie weit ist es nach Graz?')
    turns = []
    const res = await api('POST', '/api/captures', {
      text: 'Wie gehen wir die Bremsen an?', mode: 'work', source: 'puck', strandId: first.capture.strandId!, intent: 'ask',
    })

    expect(res.status).toBe(201)
    expect(calls).toBe(0)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnModelOverride).toBeUndefined()
    expect(turns[0]!.turnOverrides?.styleHint).toBe('Halte es unter zwanzig Woertern.')
    expect(turns[0]!.turnOverrides?.thinkingLevel).toBeUndefined()
  })

  it('leaves a working puck capture alone when the source hint is empty', async () => {
    const first = await quick('Wie weit ist es nach Graz?')
    turns = []
    writeSettings({ providerId: 'fast', modelId: 'tiny', thinkingLevel: 'off', styleHint: 'Antworte in zwei Saetzen.' }, '   ')
    const res = await api('POST', '/api/captures', {
      text: 'Und die Belaege?', mode: 'work', source: 'puck', strandId: first.capture.strandId!, intent: 'ask',
    })

    expect(res.status).toBe(201)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnOverrides).toBeUndefined()
  })

  it('rejects an unknown mode', async () => {
    const res = await api('POST', '/api/captures', { text: 'Was denn nun?', mode: 'turbo' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('invalid_mode')
    expect((res.body.error as string)).toContain('work, quick')
  })

  it('still discards a silent recording, mode or not', async () => {
    const res = await quick('* Musik *')

    expect(res.status).toBe(201)
    expect(res.capture.status).toBe('dismissed')
    expect(turns).toEqual([])
    expect(calls).toBe(0)
    const strands = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    expect(strands.n).toBe(0)
  })
})
