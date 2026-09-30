/**
 * The protocol test of the global canvas: a real writer writes a real
 * revision, a real `/ws/chat` socket receives the frame, and the bytes of that
 * frame are the fixture both clients test against.
 *
 * ## Why a recorded fixture and not a hand written one
 *
 * The Android app and the web app must parse what the SERVER sends, not what a
 * document claims the server sends. A fixture written by hand drifts the
 * moment a field is renamed and both clients keep passing against their own
 * fiction. So this test captures the frame from the running server once
 * (`UPDATE_CANVAS_FIXTURE=1 npx vitest run …`) and from then on FAILS when the
 * server's frame no longer equals the committed file — which is the same file
 * the app's and the web client's tests load.
 *
 * The writer used here is `deliverTaskFile()`, the background-task path: no
 * turn, no LLM, no channel streaming chunks. That is the hardest case (the one
 * the clients could not see before) and it goes through exactly the same
 * `recordMessageArtifacts()` as an interactive turn.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import { initDatabase, SessionManager, saveUpload } from '@axiom/core'
import type { AgentCore, Database, UploadDescriptor } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'
import { ChatEventBus } from './chat-event-bus.js'
import { registerCanvasViewBroadcast } from './canvas-view-broadcast.js'
import { deliverTaskFile } from './task-file-delivery.js'

/** The one file both clients load. Relative to the repo root. */
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '../../../docs/protocol/canvas-view-updated.frame.json',
)

let db: Database
let server: http.Server
let port: number
let token: string
let bus: ChatEventBus
let tempDataDir: string
let previousDataDir: string | undefined
let unsubscribe: () => void
let wss: { clients: Set<WebSocket>; close: () => void }

const STRAND_ID = 'strand-canvas-live'

async function connect(auth: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${auth}`)
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  return ws
}

function collect(ws: WebSocket, ms: number): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  ws.on('message', data => frames.push(JSON.parse(data.toString()) as Record<string, unknown>))
  return new Promise(resolve => setTimeout(() => resolve(frames), ms))
}

function storeView(html: string, name: string, viewKey: string, title: string, note?: string): UploadDescriptor {
  const upload = saveUpload({
    buffer: Buffer.from(html, 'utf8'),
    originalName: name,
    mimeType: 'text/html; charset=utf-8',
    source: 'web',
    userId: 1,
    sessionId: STRAND_ID,
  })
  upload.viewKey = viewKey
  upload.viewTitle = title
  if (note) upload.viewNote = note
  return upload
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-canvas-live-'))
  process.env.DATA_DIR = tempDataDir

  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(1, 'admin', 'x', 'admin')
  const sessionManager = new SessionManager({ db, memoryDir: path.join(tempDataDir, 'memory'), timeoutMinutes: 0 })
  db.prepare("INSERT INTO sessions (id, user_id, agent_id, started_at) VALUES (?, 1, 'bob', datetime('now'))").run(STRAND_ID)
  const agentCore = {
    sendMessage: vi.fn(),
    abort: vi.fn(),
    getSessionManager: () => sessionManager,
    getPendingMessageCount: () => 0,
  } as unknown as AgentCore

  bus = new ChatEventBus()
  unsubscribe = registerCanvasViewBroadcast({ chatEventBus: bus })
  server = http.createServer(createApp({ db, getAgentCore: () => agentCore, chatEventBus: bus }))
  const chat = setupWebSocketChat(server, db, () => agentCore, undefined, bus)
  wss = chat.wss as unknown as { clients: Set<WebSocket>; close: () => void }
  await new Promise<void>((resolve) => server.listen(0, resolve))
  port = (server.address() as { port: number }).port
  token = generateAccessToken({ userId: 1, username: 'admin', role: 'admin' })
})

afterAll(() => {
  unsubscribe?.()
  for (const client of wss.clients) client.terminate()
  wss.close()
  server.close()
  db.close()
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  fs.rmSync(tempDataDir, { recursive: true, force: true })
})

describe('canvas_view_updated over /ws/chat', () => {
  it('records the frame of a real revision and keeps the client fixture in sync', async () => {
    const ws = await connect(token)
    const frames = collect(ws, 700)

    const result = deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 1,
      sessionId: STRAND_ID,
      agentId: 'analyst',
      upload: storeView(
        '<!doctype html><title>Wheel truing</title><h1>Front wheel</h1><p>Spoke 25 is the worst.</p>',
        'front-wheel.html',
        'front-wheel',
        'Wheel truing',
        'measure spoke 25 first',
      ),
    })
    expect(result.messageId).toBeGreaterThan(0)

    const received = await frames
    ws.close()

    const frame = received.find(f => f.type === 'canvas_view_updated')
    expect(frame, `no canvas_view_updated among ${received.map(f => f.type).join(', ')}`).toBeDefined()

    // Volatile fields (row ids, the generated artifact id) are replaced by
    // stable placeholders so the fixture is a contract about SHAPE and values
    // the clients branch on, not about one test run.
    const canvasView = frame!.canvasView as Record<string, unknown>
    const normalized = {
      ...frame,
      messageId: '<messageId>',
      canvasView: { ...canvasView, artifactId: '<artifactId>', messageId: '<messageId>' },
    }

    if (process.env.UPDATE_CANVAS_FIXTURE === '1') {
      fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true })
      fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(normalized, null, 2)}\n`)
    }

    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>
    expect(normalized).toEqual(fixture)

    // The values the clients actually branch on, asserted explicitly so a
    // "fixture updated, everything green" change still has to be deliberate.
    expect(canvasView.viewKey).toBe('front-wheel')
    expect(canvasView.revision).toBe(1)
    expect(canvasView.latestRevision).toBe(1)
    expect(canvasView.title).toBe('Wheel truing')
    expect(canvasView.note).toBe('measure spoke 25 first')
    expect(canvasView.kind).toBe('html')
    expect(typeof canvasView.artifactId).toBe('string')
  })

  it('counts a second write of the same key as revision 2', async () => {
    const ws = await connect(token)
    const frames = collect(ws, 700)

    deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 1,
      sessionId: STRAND_ID,
      agentId: 'analyst',
      upload: storeView(
        '<!doctype html><title>Wheel truing</title><h1>Front wheel</h1><p>Round again.</p>',
        'front-wheel.html',
        'front-wheel',
        'Wheel truing',
        'radial run-out down to 0.4 mm',
      ),
    })

    const received = await frames
    ws.close()
    const frame = received.find(f => f.type === 'canvas_view_updated')
    const canvasView = frame?.canvasView as Record<string, unknown> | undefined
    expect(canvasView?.revision).toBe(2)
    expect(canvasView?.latestRevision).toBe(2)
    expect(canvasView?.note).toBe('radial run-out down to 0.4 mm')
  })

  it('sends the frame only to sockets of the owning user', async () => {
    db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)').run(2, 'other', 'x', 'user')
    const stranger = await connect(generateAccessToken({ userId: 2, username: 'other', role: 'user' }))
    const strangerFrames = collect(stranger, 600)

    deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 1,
      sessionId: STRAND_ID,
      agentId: 'analyst',
      upload: storeView('<!doctype html><p>private</p>', 'front-wheel.html', 'front-wheel', 'Wheel truing'),
    })

    const received = await strangerFrames
    stranger.close()
    expect(received.filter(f => f.type === 'canvas_view_updated')).toHaveLength(0)
  })
})
