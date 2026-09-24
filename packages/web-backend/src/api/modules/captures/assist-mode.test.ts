/**
 * Capture mode `assist` (puck assist waves, W1) over the real HTTP path.
 *
 * The mode exists for the case "say what you want, then type it somewhere":
 * the user dictates into a screenless device, the persona answers shortly and
 * puts the typable text into a `draft` block, the device types that text over
 * a BLE keyboard. What is proven here:
 *   - assist is ROUTED like any other capture: the router is called, there is
 *     no fixed strand and no mode model — the only thing the mode adds is the
 *     style instruction of the turn
 *   - that instruction is the configured `captureModes.assist.styleHint` plus
 *     the device hint of the source, exactly the way the quick mode composes
 *     its hints
 *   - the instruction is recomputed at turn start, so a hint edited after the
 *     capture arrived is the one that reaches the model
 *   - `work` and `quick` captures never see the assist hint
 *   - an empty assist hint leaves a web capture completely untouched
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager, DEFAULT_ASSIST_STYLE_HINT } from '@axiom/core'
import type { AgentCore, Capture, Database, ModelSelection, ResolvedRouterModel, TurnRuntimeOverrides } from '@axiom/core'
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
let nextAnswers: string[] = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

const PUCK_HINT = 'Halte es unter zwanzig Woertern.'

function writeSettings(captureModes: Record<string, unknown>, puckStyleHint = PUCK_HINT): void {
  fs.writeFileSync(
    path.join(tempDataDir, 'config', 'settings.json'),
    JSON.stringify({ captureModes, captureSources: { puck: { styleHint: puckStyleHint } } }, null, 2),
    'utf-8',
  )
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-assist-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  writeSettings({})

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
      const next = nextAnswers.shift()
      if (next === undefined) throw new Error('router stub has no answer')
      return next
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
  nextAnswers = []
  writeSettings({})
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

function answer(obj: Record<string, unknown>): void {
  nextAnswers.push(JSON.stringify(obj))
}

async function assist(text: string, extra: Record<string, unknown> = {}): Promise<{ status: number; capture: Capture }> {
  const res = await api('POST', '/api/captures', { text, mode: 'assist', source: 'puck', intent: 'ask', ...extra })
  return { status: res.status, capture: res.body.capture as Capture }
}

describe('capture mode assist', () => {
  it('routes like a normal capture and injects the draft instruction', async () => {
    // One existing strand, so the router really is asked: with no candidate at
    // all the core short-circuits to a synthetic new strand without a call,
    // and this test would prove nothing about the mode.
    sessionManager.createThread('1', 'main', 'Ein anderes Thema')
    answer({ action: 'new_strand', newStrand: { title: 'Mail an Mueller', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.86 })

    const res = await assist('Schreib mir eine kurze Mail an Herrn Mueller wegen des Liefertermins')

    expect(res.status).toBe(201)
    // The router ran: assist has no fixed strand, unlike the quick mode.
    expect(calls).toBe(1)
    expect(res.capture.strandId).toBeTruthy()
    expect(turns).toHaveLength(1)
    // The persona's own model writes the draft: no model pin from the mode.
    expect(turns[0]!.turnModelOverride).toBeUndefined()
    expect(turns[0]!.turnOverrides?.styleHint).toBe(`${DEFAULT_ASSIST_STYLE_HINT} ${PUCK_HINT}`)
    // Assist does not touch the thinking level, that stays the persona's.
    expect(turns[0]!.turnOverrides?.thinkingLevel).toBeUndefined()
  })

  it('carries the instruction the settings hold, not the shipped default', async () => {
    writeSettings({ assist: { styleHint: 'Nur der Entwurf, sonst nichts.' } })
    answer({ action: 'new_strand', newStrand: { title: 'Mail', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })

    await assist('Schreib eine Nachricht an Anna')

    expect(turns[0]!.turnOverrides?.styleHint).toBe(`Nur der Entwurf, sonst nichts. ${PUCK_HINT}`)
  })

  it('remembers the mode on the capture, so a later turn is still assisted', async () => {
    answer({ action: 'new_strand', newStrand: { title: 'Mail', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })
    const res = await assist('Schreib eine Nachricht an Anna')

    const row = db.prepare('SELECT metadata FROM captures WHERE id = ?').get(res.capture.id) as { metadata: string | null }
    expect(JSON.parse(row.metadata ?? '{}').mode).toBe('assist')
  })

  it('leaves a work capture and a quick capture without the assist hint', async () => {
    writeSettings({ quick: { styleHint: 'Antworte in zwei Saetzen.' }, assist: { styleHint: 'ASSIST-HINT' } })

    // work from the puck: device hint only.
    answer({ action: 'new_strand', newStrand: { title: 'Bremsen', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })
    await api('POST', '/api/captures', { text: 'Wie gehen wir die Bremsen an?', mode: 'work', source: 'puck', intent: 'ask' })
    expect(turns[0]!.turnOverrides?.styleHint).toBe(PUCK_HINT)
    expect(turns[0]!.turnOverrides?.styleHint).not.toContain('ASSIST-HINT')

    // quick from the puck: mode hint plus device hint, no router at all.
    turns = []
    const quick = await api('POST', '/api/captures', { text: 'Wie spaet ist es?', mode: 'quick', source: 'puck' })
    expect(quick.status).toBe(201)
    expect(turns[0]!.turnOverrides?.styleHint).toBe(`Antworte in zwei Saetzen. ${PUCK_HINT}`)
    expect(turns[0]!.turnOverrides?.styleHint).not.toContain('ASSIST-HINT')
  })

  it('adds nothing at all when the assist hint is cleared and the source has none', async () => {
    writeSettings({ assist: { styleHint: '' } }, '')
    answer({ action: 'new_strand', newStrand: { title: 'Mail', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.9 })

    await assist('Schreib eine Nachricht an Anna', { source: 'web' })

    expect(turns).toHaveLength(1)
    expect(turns[0]!.turnOverrides).toBeUndefined()
  })

  it('accepts assist as a mode and still rejects an unknown one', async () => {
    const bad = await api('POST', '/api/captures', { text: 'Was denn nun?', mode: 'turbo' })
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe('invalid_mode')
    expect(bad.body.error as string).toContain('assist')
  })
})
