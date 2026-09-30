/**
 * The API contract of a forked strand (`fork_strand`, core/strand-fork.ts):
 * the list carries `parentStrandId` / `forkedAt` on every strand, the detail
 * adds the parent title and the direct children. This is what the app needs
 * for a back-link chip and a children list, so it is pinned here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { forkStrand, initDatabase, SessionManager } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { createStrandsRouters } from './route.js'
import { generateAccessToken } from '../../../auth.js'

let db: Database
let server: http.Server
let baseUrl: string
let token: string
let sessionManager: SessionManager
let tempDataDir: string
let previousDataDir: string | undefined

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-fork-routes-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')

  sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  const agentCore = { getSessionManager: () => sessionManager } as unknown as AgentCore

  const app = express()
  app.use(express.json())
  const routers = createStrandsRouters({
    db,
    getAgentCore: () => agentCore,
    getNowSetMode: () => 'manual',
  })
  app.use('/api/strands', routers.strands)

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
  db.exec('DELETE FROM chat_messages; DELETE FROM sessions; DELETE FROM strand_links;')
})

async function api(method: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${url}`, { method, headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} }
}

describe('fork lineage over the strands API', () => {
  it('carries parentStrandId and forkedAt in the list', async () => {
    const parent = sessionManager.createThread('1', 'main', 'Gmail integration')
    const fork = forkStrand({
      db, sessions: sessionManager, userId: 1, parentStrandId: parent.id,
      title: 'Privacy: Gmail-Scopes', seed: 'Nebenpfad Datenschutz.',
    })

    const list = await api('GET', '/api/strands')
    expect(list.status).toBe(200)
    const strands = list.body.strands as { id: string; parentStrandId: string | null; forkedAt: string | null }[]
    const child = strands.find(s => s.id === fork.strandId)!
    const root = strands.find(s => s.id === parent.id)!
    expect(child.parentStrandId).toBe(parent.id)
    expect(child.forkedAt).toBe(fork.forkedAt)
    expect(root.parentStrandId).toBeNull()
    expect(root.forkedAt).toBeNull()
  })

  it('adds the parent title and the direct children to the detail', async () => {
    const parent = sessionManager.createThread('1', 'main', 'Gmail integration')
    const first = forkStrand({
      db, sessions: sessionManager, userId: 1, parentStrandId: parent.id, title: 'Privacy', seed: 'Eins.',
    })
    const second = forkStrand({
      db, sessions: sessionManager, userId: 1, parentStrandId: parent.id, title: 'Retention', seed: 'Zwei.',
    })
    const nested = forkStrand({
      db, sessions: sessionManager, userId: 1, parentStrandId: first.strandId, title: 'Scopes', seed: 'Drei.',
    })

    const parentDetail = await api('GET', `/api/strands/${parent.id}`)
    expect(parentDetail.body.strand).toMatchObject({
      parentStrandId: null,
      parentStrandTitle: null,
      childStrandIds: [first.strandId, second.strandId],
    })

    const childDetail = await api('GET', `/api/strands/${first.strandId}`)
    expect(childDetail.body.strand).toMatchObject({
      parentStrandId: parent.id,
      parentStrandTitle: 'Gmail integration',
      forkedAt: first.forkedAt,
      childStrandIds: [nested.strandId],
    })
  })

  it('keeps the lineage id when the parent is gone and reports no title', async () => {
    const parent = sessionManager.createThread('1', 'main', 'Gmail integration')
    const fork = forkStrand({
      db, sessions: sessionManager, userId: 1, parentStrandId: parent.id, title: 'Privacy', seed: 'Nebenpfad.',
    })
    db.prepare('DELETE FROM sessions WHERE id = ?').run(parent.id)

    const detail = await api('GET', `/api/strands/${fork.strandId}`)
    expect(detail.status).toBe(200)
    expect(detail.body.strand).toMatchObject({
      parentStrandId: parent.id,
      parentStrandTitle: null,
      childStrandIds: [],
    })
  })
})
