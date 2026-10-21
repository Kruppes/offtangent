/**
 * Who wrote the title of a strand a capture opens (`sessions.title_source`).
 *
 * Only the router model's own title is 'ai'. A title cut from the capture is
 * 'derived', a title the user typed is 'manual'. Proven for every path that
 * creates a strand from a capture:
 *   - router `new_strand` (high band) -> 'ai'
 *   - low-confidence guard: the model's own new_strand alternative -> 'ai',
 *     no alternative (title derived from the text) -> 'derived'
 *   - a guarded decision confirmed later keeps its source (stored on the row)
 *   - router failure -> fallback decision, applied by hand without a title ->
 *     'derived'; applied with a typed title -> 'manual'
 *   - `destination: 'new_strand'` with `strandTitle` -> 'manual', without ->
 *     'derived'
 *   - quick mode -> 'derived'
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
import { ChatEventBus } from '../../../chat-event-bus.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined
let nextAnswers: string[] = []

const chain: ResolvedRouterModel[] = [
  { spec: 'stub', threshold: null, providerId: 'p', providerName: 'P', modelId: 'stub', composite: 'p:stub' },
]

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-captures-title-source-'))
  process.env.DATA_DIR = tempDataDir
  fs.mkdirSync(path.join(tempDataDir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(tempDataDir, 'config', 'providers.json'), JSON.stringify({
    providers: [{
      id: 'fast', name: 'Fast', type: 'openai-compatible', baseUrl: 'https://example.invalid/v1',
      apiKey: '', enabledModels: ['tiny'], status: 'ok',
    }],
    activeProvider: 'fast', activeModel: 'tiny',
  }), 'utf-8')
  fs.writeFileSync(path.join(tempDataDir, 'config', 'settings.json'), JSON.stringify({
    captureModes: { quick: { providerId: 'fast', modelId: 'tiny', thinkingLevel: 'off', styleHint: 'Kurz.' } },
  }), 'utf-8')

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
    getTurnRunner: () => ({ startTurn: () => ({}) }),
    routerChain: () => chain,
    getNowSetMode: () => 'manual',
    routerComplete: async () => {
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
  nextAnswers = []
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

function strandOf(capture: Capture): { title: string; title_source: string | null } {
  return db.prepare('SELECT title, title_source FROM sessions WHERE id = ?').get(capture.strandId!) as { title: string; title_source: string | null }
}

async function capture(body: Record<string, unknown>): Promise<{ capture: Capture; decision: Decision }> {
  const res = await api('POST', '/api/captures', body)
  expect(res.status).toBeLessThan(300)
  return { capture: res.body.capture as Capture, decision: res.body.decision as Decision }
}

describe('title_source of strands opened by a capture', () => {
  it("marks the router model's own new_strand title as 'ai'", async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Dach Angebot Nord', personaId: 'main', tags: [] }, confidence: 0.9 })
    const { capture: c, decision } = await capture({ text: 'roofer quote for the north side' })
    expect(c.status).toBe('filed')
    expect(decision.titleSource).toBe('ai')
    expect(strandOf(c)).toEqual({ title: 'Dach Angebot Nord', title_source: 'ai' })
  })

  it("low-confidence guard: the model's alternative title is 'ai' and survives a later confirm", async () => {
    const target = sessionManager.createThread('1', 'main', 'Fremder Strand')
    answer({
      action: 'append', strandId: target.id, confidence: 0.5,
      alternatives: [{ action: 'new_strand', title: 'Kanarienvogel Deploy', confidence: 0.4, reason: 'neu' }],
    })
    const { capture: c, decision } = await capture({ text: 'and the canary?' })
    expect(c.strandId).not.toBe(target.id)
    expect(decision.titleSource).toBe('ai')
    expect(strandOf(c)).toEqual({ title: 'Kanarienvogel Deploy', title_source: 'ai' })

    const confirm = await api('POST', `/api/captures/${c.id}/apply`, {})
    expect(confirm.status).toBe(200)
    expect(strandOf(confirm.body.capture as Capture).title_source).toBe('ai')
  })

  it("low-confidence guard without a model title derives one: 'derived'", async () => {
    const target = sessionManager.createThread('1', 'main', 'Fremder Strand')
    answer({ action: 'append', strandId: target.id, confidence: 0.5, alternatives: [] })
    const { capture: c, decision } = await capture({ text: 'Die Strand Zuordnung ist lueckenhaft' })
    expect(c.strandId).not.toBe(target.id)
    expect(decision.titleSource).toBe('derived')
    expect(strandOf(c).title_source).toBe('derived')
  })

  it("router failure: the fallback title applied by hand is 'derived', a typed title 'manual'", async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    nextAnswers.push('nonsense', 'still nonsense')
    const failed = await capture({ text: 'router is drunk today' })
    expect(failed.capture.status).toBe('failed')
    expect(failed.decision.titleSource).toBe('derived')
    const applied = await api('POST', `/api/captures/${failed.capture.id}/apply`, { action: 'new_strand' })
    expect(applied.status).toBe(200)
    expect(strandOf(applied.body.capture as Capture).title_source).toBe('derived')

    nextAnswers.push('nonsense', 'still nonsense')
    const again = await capture({ text: 'router is drunk again' })
    const typed = await api('POST', `/api/captures/${again.capture.id}/apply`, { action: 'new_strand', title: 'Mein Titel' })
    expect(typed.status).toBe(200)
    expect(strandOf(typed.body.capture as Capture)).toEqual({ title: 'Mein Titel', title_source: 'manual' })
  })

  it("an unsorted router proposal applied with its own title stays 'ai', a new title is 'manual'", async () => {
    sessionManager.createThread('1', 'main', 'Existing')
    answer({ action: 'new_strand', newStrand: { title: 'Maybe', personaId: 'main', tags: [] }, confidence: 0.2, alternatives: [] })
    const first = await capture({ text: 'random thought' })
    expect(first.capture.status).toBe('unsorted')
    const same = await api('POST', `/api/captures/${first.capture.id}/apply`, { action: 'new_strand', title: 'Maybe' })
    expect(strandOf(same.body.capture as Capture)).toEqual({ title: 'Maybe', title_source: 'ai' })

    answer({ action: 'new_strand', newStrand: { title: 'Maybe', personaId: 'main', tags: [] }, confidence: 0.2, alternatives: [] })
    const second = await capture({ text: 'another random thought' })
    const renamed = await api('POST', `/api/captures/${second.capture.id}/apply`, { action: 'new_strand', title: 'Chosen later' })
    expect(strandOf(renamed.body.capture as Capture)).toEqual({ title: 'Chosen later', title_source: 'manual' })
  })

  it("destination new_strand: the client's strandTitle is 'manual', the first line 'derived'", async () => {
    const named = await capture({ text: 'Artikel: Modellstart\n\nWas bedeutet das?', source: 'web', destination: 'new_strand', strandTitle: 'Modellstart' })
    expect(strandOf(named.capture)).toEqual({ title: 'Modellstart', title_source: 'manual' })

    const unnamed = await capture({ text: 'Erste Zeile als Titel\n\nRest', source: 'web', destination: 'new_strand' })
    expect(strandOf(unnamed.capture)).toEqual({ title: 'Erste Zeile als Titel', title_source: 'derived' })

    const blank = await capture({ text: 'Noch eine Frage hier', source: 'web', destination: 'new_strand', strandTitle: '   ' })
    expect(strandOf(blank.capture).title_source).toBe('derived')
  })

  it("quick mode opens its strand with a 'derived' title", async () => {
    const res = await capture({ text: 'Wie spaet ist es in Tokio?', mode: 'quick', source: 'puck' })
    expect(res.decision.model).toBe('quick-mode')
    expect(strandOf(res.capture).title_source).toBe('derived')
  })
})
