/**
 * `capture.defaultAgentId` (W6b): the persona a capture without `agentId`
 * lands at.
 *
 * Order proven here: explicit `agentId` in the request > the setting > the
 * previous fallback (`multiPersona.defaultAgentId`, here `main`). `'auto'`,
 * a missing setting and an id whose persona has disappeared all behave
 * exactly like before the setting existed. A request that names a strand
 * keeps that strand's persona.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Capture, Database, Decision, ResolvedRouterModel } from '@axiom/core'
import { createCapturesRouters } from './route.js'
import { captureDefaultAgent, withCaptureDefaultAgent } from './service.js'
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let turns: Array<{ sessionId: string; text: string }> = []
let routerCalls = 0

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-default-agent-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.mkdirSync(path.join(tempDataDir, 'agents', 'helper'), { recursive: true })

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
        turns.push({ sessionId: input.sessionId, text: input.text })
        return {}
      },
    }),
    routerChain: () => chain,
    // The router, when it is asked at all, always wants to append to the
    // newest strand — the exact mistake the forced destination prevents.
    routerComplete: async () => {
      routerCalls += 1
      const newest = db.prepare('SELECT id FROM sessions ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined
      const proposal = newest
        ? { action: 'append', strandId: newest.id, intent: 'ask', confidence: 0.95, tags: [], rationale: 'stub appends', alternatives: [] }
        : { action: 'new_strand', newStrand: { title: 'Router strand', personaId: 'main', tags: [] }, intent: 'ask', confidence: 0.95, tags: [], rationale: 'stub opens', alternatives: [] }
      return JSON.stringify(proposal)
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
  routerCalls = 0
  writeSettings(undefined)
})

function writeSettings(capture: Record<string, unknown> | undefined): void {
  const file = path.join(tempDataDir, 'config', 'settings.json')
  fs.writeFileSync(file, JSON.stringify(capture === undefined ? {} : { capture }))
}

async function api(method: string, url: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}


async function newStrandCapture(extra: Record<string, unknown> = {}): Promise<{ status: number; capture: Capture; strandAgent: string }> {
  const res = await api('POST', '/api/captures', { text: 'Synthetic note about a test fixture', source: 'web', destination: 'new_strand', ...extra })
  const capture = res.body.capture as Capture
  const decision = res.body.decision as Decision
  const row = db.prepare('SELECT agent_id FROM sessions WHERE id = ?').get(decision.strandId) as { agent_id: string }
  return { status: res.status, capture, strandAgent: row.agent_id }
}

describe('capture.defaultAgentId in the capture service', () => {
  it('keeps the previous behaviour without the setting (auto)', async () => {
    const r = await newStrandCapture()
    expect(r.status).toBe(201)
    expect(r.capture.agentId).toBe('main')
    expect(r.strandAgent).toBe('main')
  })

  it('keeps the previous behaviour with an explicit auto', async () => {
    writeSettings({ defaultAgentId: 'auto' })
    const r = await newStrandCapture()
    expect(r.capture.agentId).toBe('main')
    expect(r.strandAgent).toBe('main')
  })

  it('lands a capture without agentId at the configured persona', async () => {
    writeSettings({ defaultAgentId: 'helper' })
    const r = await newStrandCapture()
    expect(r.status).toBe(201)
    expect(r.capture.agentId).toBe('helper')
    expect(r.strandAgent).toBe('helper')
  })

  it('lets an explicit agentId in the request win over the setting', async () => {
    writeSettings({ defaultAgentId: 'helper' })
    const r = await newStrandCapture({ agentId: 'main' })
    expect(r.capture.agentId).toBe('main')
    expect(r.strandAgent).toBe('main')
  })

  it('falls back to the previous behaviour when the configured persona no longer exists', async () => {
    writeSettings({ defaultAgentId: 'gone-persona' })
    const r = await newStrandCapture()
    expect(r.capture.agentId).toBe('main')
    expect(r.strandAgent).toBe('main')
  })

  it('never overrides the persona of a strand the request names', async () => {
    const strand = sessionManager.createThread('1', 'main', 'Synthetic strand')
    writeSettings({ defaultAgentId: 'helper' })
    const res = await api('POST', '/api/captures', { text: 'Synthetic follow-up line', source: 'web', strandId: strand.id })
    expect(res.status).toBe(201)
    expect((res.body.capture as Capture).agentId).toBe('main')
    expect((res.body.decision as Decision).strandId).toBe(strand.id)
  })

  it('hands the configured persona to the router as hint when routing', async () => {
    writeSettings({ defaultAgentId: 'helper' })
    const res = await api('POST', '/api/captures', { text: 'Synthetic routed note', source: 'web' })
    expect(res.status).toBe(201)
    expect((res.body.capture as Capture).agentId).toBe('helper')
  })
})

describe('captureDefaultAgent / withCaptureDefaultAgent (pure order)', () => {
  const personas = () => ['main', 'helper']
  it('maps auto, empty and unknown ids to null and known ids to themselves', () => {
    expect(captureDefaultAgent(() => 'auto', personas)).toBeNull()
    expect(captureDefaultAgent(() => '', personas)).toBeNull()
    expect(captureDefaultAgent(() => 'unknown', personas)).toBeNull()
    expect(captureDefaultAgent(() => 'helper', personas)).toBe('helper')
    expect(captureDefaultAgent(() => 'main', personas)).toBe('main')
  })
  it('applies explicit > setting > previous fallback', () => {
    expect(withCaptureDefaultAgent({ agentId: 'main' }, () => 'helper').agentId).toBe('main')
    expect(withCaptureDefaultAgent({ agentId: null }, () => 'helper').agentId).toBe('helper')
    expect(withCaptureDefaultAgent({ agentId: null }, () => null).agentId).toBeNull()
    expect(withCaptureDefaultAgent({ agentId: null, strandId: 's1' }, () => 'helper').agentId).toBeNull()
  })
})
