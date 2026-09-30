/**
 * The full outgoing-file path, end to end, against a temporary on-disk
 * database: the REAL `send_file_to_user` tool runs inside a REAL ws-chat turn,
 * the socket is closed, and the file is then read back through the REAL
 * `GET /api/chat/history` endpoint.
 *
 * Why this exists next to `ws-chat.test.ts` (which already asserts the row):
 * that test feeds a hand-written descriptor into a mocked agent core and looks
 * at the DB directly. It cannot tell whether the tool produces what the
 * persister stores, nor whether the history endpoint hands it back. This one
 * closes both gaps, so "the card came from the live frame" and "the card came
 * from history" stop being indistinguishable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocket } from 'ws'
import {
  createSendFileTool,
  initDatabase,
  parseUploadsMetadata,
  serializeUploadsMetadata,
  saveUpload,
} from '@axiom/core'
import type { AgentCore, Database, ResponseChunk } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { setupWebSocketChat } from './ws-chat.js'

const TEST_SECRET = 'test-secret-for-outgoing-files'
const SESSION_ID = 'session-outgoing-file'
const USER_ID = 1
const APK_BYTES = Buffer.from('PK\u0003\u0004 pretend this is an apk', 'utf8')

let tempDir: string
let dbPath: string
let db: Database
let server: http.Server
let baseUrl: string
let port: number
let token: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined
let sourceFile: string

type SendFileTool = ReturnType<typeof createSendFileTool>

function toolResultOf(tool: SendFileTool, params: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve(tool.execute('tc-1', params, {} as never)) as Promise<unknown>
}

function connect(): Promise<{
  ws: WebSocket
  next: () => Promise<Record<string, unknown>>
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat?token=${token}`)
    const queue: Record<string, unknown>[] = []
    let pending: ((msg: Record<string, unknown>) => void) | null = null
    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>
      if (pending) {
        const resolveNext = pending
        pending = null
        resolveNext(parsed)
      } else {
        queue.push(parsed)
      }
    })
    ws.on('error', reject)
    ws.on('open', () => resolve({
      ws,
      next: () => queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise((res) => { pending = res }),
    }))
  })
}

async function fetchJson(pathname: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${pathname}`, { headers: { Authorization: `Bearer ${token}` } })
  return await res.json() as Record<string, unknown>
}

beforeAll(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-outgoing-file-'))
  process.env.DATA_DIR = tempDir
  process.env.JWT_SECRET = TEST_SECRET

  // A real file on disk, the way an agent would leave a built artifact behind.
  sourceFile = path.join(tempDir, 'offtangent-test-release.apk')
  fs.writeFileSync(sourceFile, APK_BYTES)

  // A temporary ON-DISK database, deliberately not `:memory:`, so the history
  // read goes through the same storage a deployment uses.
  dbPath = path.join(tempDir, 'history.db')
  db = initDatabase(dbPath)
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(USER_ID, 'admin', 'x', 'admin')
  db.prepare("INSERT INTO sessions (id, user_id, source, started_at, last_activity) VALUES (?, ?, 'web', ?, ?)")
    .run(SESSION_ID, String(USER_ID), Date.now(), Date.now())

  const sendFileTool = createSendFileTool({
    getCurrentToolUserId: () => USER_ID,
    getCurrentInteractiveSessionId: () => SESSION_ID,
    // The composition reports a carrier here: a live persisting turn
    // (TurnRunner) resp. the streaming task injection writes the row.
    isCarriedByCurrentTurn: () => true,
  })

  const agentCore = {
    sendMessage: async function* (): AsyncGenerator<ResponseChunk> {
      yield { type: 'tool_call_start', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolArgs: { path: sourceFile } }
      const toolResult = await toolResultOf(sendFileTool, {
        path: sourceFile,
        filename: 'offtangent-test.apk',
        caption: 'the build you asked for',
      })
      yield { type: 'tool_call_end', toolName: 'send_file_to_user', toolCallId: 'tc-1', toolResult }
      yield { type: 'text', text: 'Here is the build.' }
      yield { type: 'done' }
    },
    abort: () => {},
    resetSession: () => {},
    getSessionManager: () => ({
      assertSessionAccess: (_userId: string, sessionId: string) => ({ id: sessionId }),
      getOrCreateSession: () => ({
        id: SESSION_ID, userId: String(USER_ID), source: 'web',
        startedAt: Date.now(), lastActivity: Date.now(), messageCount: 0,
        summaryWritten: false, restored: false,
      }),
    }),
  } as unknown as AgentCore

  const app = createApp({ db })
  server = http.createServer(app)
  setupWebSocketChat(server, db, agentCore)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  baseUrl = `http://127.0.0.1:${port}`
  token = generateAccessToken({ userId: USER_ID, username: 'admin', role: 'admin' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

describe('a file sent by the agent survives the turn', () => {
  it('is readable from GET /api/chat/history after the socket that saw it is gone', async () => {
    const { ws, next } = await connect()
    await next() // authenticated

    ws.send(JSON.stringify({ type: 'message', content: 'send me the build', sessionId: SESSION_ID }))

    let liveAttachment: Record<string, unknown> | null = null
    for (let i = 0; i < 20; i++) {
      const frame = await next()
      if (frame.type === 'attachment') liveAttachment = frame.attachment as Record<string, unknown>
      if (frame.type === 'done') break
    }

    // The live path still works — this is the frame the running client renders.
    expect(liveAttachment).not.toBeNull()
    expect(liveAttachment!.originalName).toBe('offtangent-test.apk')

    // The connection that saw the frame is gone. Anything found below came out
    // of the database.
    await new Promise<void>((resolve) => { ws.on('close', () => resolve()); ws.close() })

    const body = await fetchJson(`/api/chat/history?session_id=${SESSION_ID}&since_id=0&limit=100`)
    const rows = body.messages as Array<{ role: string; content: string; metadata?: string }>
    const assistantRows = rows.filter(r => r.role === 'assistant')
    expect(assistantRows).toHaveLength(1)

    const files = parseUploadsMetadata(assistantRows[0]!.metadata)
    expect(files).toHaveLength(1)
    const file = files[0]!
    expect(file.originalName).toBe('offtangent-test.apk')
    expect(file.size).toBe(APK_BYTES.length)
    expect(file.kind).toBe('file')
    expect(file.caption).toBe('the build you asked for')
    expect(assistantRows[0]!.content).toBe('Here is the build.')

    // The bytes behind the persisted descriptor are the bytes of the source
    // file, and they are reachable under the URL the descriptor advertises.
    const stored = path.join(tempDir, 'uploads', file.relativePath)
    expect(fs.readFileSync(stored).equals(APK_BYTES)).toBe(true)
    const download = await fetch(`${baseUrl}${file.urlPath}?token=${token}`)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer()).equals(APK_BYTES)).toBe(true)
  })

  it('stores the outgoing descriptor in the same shape an incoming upload uses', () => {
    const incoming = saveUpload({
      buffer: APK_BYTES,
      originalName: 'user-upload.apk',
      mimeType: 'application/vnd.android.package-archive',
      source: 'web',
      userId: USER_ID,
      sessionId: SESSION_ID,
    })
    db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(SESSION_ID, USER_ID, 'user', 'here, take this', serializeUploadsMetadata([incoming]), 'main')

    const rows = db.prepare(
      `SELECT role, metadata FROM chat_messages WHERE session_id = ? AND role != 'tool'
         AND metadata LIKE '%"files"%' ORDER BY id`
    ).all(SESSION_ID) as Array<{ role: string; metadata: string }>

    const shapes = rows.map(r => ({
      role: r.role,
      keys: Object.keys(JSON.parse(r.metadata) as Record<string, unknown>),
      fileKeys: parseUploadsMetadata(r.metadata).map(f => Object.keys(f).sort().join(',')),
    }))

    expect(shapes.map(s => s.role)).toEqual(['assistant', 'user'])
    // One envelope key for both directions: `files`.
    expect(shapes.every(s => s.keys.join(',') === 'files')).toBe(true)
    // Outgoing carries exactly the incoming descriptor plus `caption`, which
    // only `send_file_to_user` can produce.
    const outgoingFields = shapes[0]!.fileKeys[0]!.split(',')
    const incomingFields = shapes[1]!.fileKeys[0]!.split(',')
    expect(incomingFields.every(f => outgoingFields.includes(f))).toBe(true)
    expect(outgoingFields.filter(f => !incomingFields.includes(f))).toEqual(['caption'])
  })
})
