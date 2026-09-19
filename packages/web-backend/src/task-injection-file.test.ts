/**
 * A file the agent sends while answering a finished background task.
 *
 * This is the path the user hit: a task reports "APK built", the persona reacts
 * to that injection and calls `send_file_to_user` inside the reaction. Those
 * chunks never reach `TurnRunner` — they arrive on
 * `agentCore.setOnTaskInjectionChunk`, and the composition writes the assistant
 * row itself (`metadata.type === 'task_injection_response'`).
 *
 * Measured on the live database before this test existed: tool call 104428
 * (2026-09-15 07:56:26, `offtangent-0.9.1-subtask-tree.apk`, status `success`)
 * produced the assistant row 89533 at 07:56:37 whose metadata is
 * `{"type":"task_injection_response","telegramDelivered":false}` — no `files`,
 * no `attachment` frame, so the APK existed on disk and nowhere else.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createSendFileTool, initDatabase, parseUploadsMetadata } from '@axiom/core'
import type { Database, UploadDescriptor } from '@axiom/core'
import { createApp } from './app.js'
import { generateAccessToken } from './auth.js'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { TaskInjectionTranscript } from './task-injection-response.js'

const SESSION_ID = 'strand-that-ordered-the-build'
const USER_ID = 1
const AGENT_ID = 'bob'
const APK_BYTES = Buffer.alloc(64 * 1024, 9)

let tempDir: string
let db: Database
let server: http.Server
let baseUrl: string
let token: string
let bus: ChatEventBus
let events: ChatEvent[]
let sourceFile: string
let previousDataDir: string | undefined
let previousJwtSecret: string | undefined

/** Runs the injection the way `runtime-composition` runs it. */
async function runInjection(): Promise<{ rowId: number | null; frames: ChatEvent[] }> {
  const tool = createSendFileTool({
    getCurrentToolUserId: () => USER_ID,
    getCurrentInteractiveSessionId: () => SESSION_ID,
    // The composition reports a carrier here: a live persisting turn
    // (TurnRunner) resp. the streaming task injection writes the row.
    isCarriedByCurrentTurn: () => true,
  })
  const toolResult = await tool.execute('tc-apk', {
    path: sourceFile,
    filename: 'offtangent-0.9.1-subtask-tree.apk',
    caption: 'Subtask-Baum, frisch gebaut',
  }, {} as never)

  const transcript = new TaskInjectionTranscript()
  const chunks = [
    { type: 'tool_call_start' as const },
    { type: 'tool_call_end' as const, toolResult },
    { type: 'text' as const, text: '**Task fertig, APK ist oben.**' },
    { type: 'done' as const },
  ]

  for (const chunk of chunks) {
    const newUploads = transcript.record(chunk)
    for (const upload of newUploads) {
      bus.broadcast({
        type: 'attachment',
        userId: USER_ID,
        source: 'task',
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        attachment: upload,
      })
    }
  }

  const rowId = transcript.persist(db, { sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID })
  return { rowId, frames: events }
}

beforeEach(async () => {
  previousDataDir = process.env.DATA_DIR
  previousJwtSecret = process.env.JWT_SECRET
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offtangent-injection-file-'))
  process.env.DATA_DIR = tempDir
  process.env.JWT_SECRET = 'test-secret-for-injection-files'

  sourceFile = path.join(tempDir, 'built.apk')
  fs.writeFileSync(sourceFile, APK_BYTES)

  db = initDatabase(path.join(tempDir, 'history.db'))
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(USER_ID, 'admin', 'x', 'admin')
  db.prepare("INSERT INTO sessions (id, user_id, source, started_at, last_activity) VALUES (?, ?, 'web', ?, ?)")
    .run(SESSION_ID, String(USER_ID), Date.now(), Date.now())

  bus = new ChatEventBus()
  events = []
  bus.subscribe(event => { events.push(event) })

  server = http.createServer(createApp({ db }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  token = generateAccessToken({ userId: USER_ID, username: 'admin', role: 'admin' })
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = previousJwtSecret
})

describe('a file sent while reacting to a finished task', () => {
  it('is readable from GET /api/chat/history', async () => {
    await runInjection()

    const res = await fetch(`${baseUrl}/api/chat/history?session_id=${SESSION_ID}&since_id=0&limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = await res.json() as { messages: Array<{ role: string; content: string; metadata?: string }> }
    const assistant = body.messages.filter(m => m.role === 'assistant')
    expect(assistant).toHaveLength(1)

    const files = parseUploadsMetadata(assistant[0]!.metadata)
    expect(files.map(f => f.originalName)).toEqual(['offtangent-0.9.1-subtask-tree.apk'])
    expect(files[0]!.size).toBe(APK_BYTES.length)
    expect(files[0]!.caption).toBe('Subtask-Baum, frisch gebaut')

    // The row keeps what clients already read off an injection row.
    const meta = JSON.parse(assistant[0]!.metadata!) as { type: string; telegramDelivered: boolean }
    expect(meta.type).toBe('task_injection_response')
    expect(meta.telegramDelivered).toBe(false)
    expect(assistant[0]!.content).toBe('**Task fertig, APK ist oben.**')

    // And the bytes are reachable under the url the descriptor advertises.
    const download = await fetch(`${baseUrl}${files[0]!.urlPath}?token=${token}`)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer()).equals(APK_BYTES)).toBe(true)
  })

  it('reaches a live client as an `attachment` frame', async () => {
    await runInjection()

    const attachments = events.filter(e => e.type === 'attachment')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.sessionId).toBe(SESSION_ID)
    expect(attachments[0]!.agentId).toBe(AGENT_ID)
    expect(attachments[0]!.attachment?.originalName).toBe('offtangent-0.9.1-subtask-tree.apk')
  })

  it('writes a row for a reaction that is only a file, with no text at all', () => {
    const upload: UploadDescriptor = {
      kind: 'file',
      originalName: 'silent.apk',
      storedName: 'abc-silent.apk',
      relativePath: '2026/09/15/abc-silent.apk',
      urlPath: '/api/uploads/2026/09/15/abc-silent.apk',
      mimeType: 'application/octet-stream',
      size: 10,
    }
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'tool_call_end', toolResult: { details: { uploadedFile: upload } } })
    transcript.record({ type: 'done' })

    const rowId = transcript.persist(db, { sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID })
    expect(rowId).not.toBeNull()

    const row = db.prepare('SELECT content, metadata FROM chat_messages WHERE id = ?')
      .get(rowId) as { content: string; metadata: string }
    expect(row.content).toBe('')
    expect(parseUploadsMetadata(row.metadata).map(f => f.originalName)).toEqual(['silent.apk'])
  })

  it('still persists nothing when the reaction produced neither text nor file', () => {
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'done' })
    expect(transcript.persist(db, { sessionId: SESSION_ID, userId: USER_ID, agentId: AGENT_ID })).toBeNull()
  })

  // W4: the composition acks the durable injection row on `done` — but only
  // for a turn that did not blow up, otherwise the result would be marked
  // delivered while the agent never saw it.
  it('reports a clean reaction as not failed', () => {
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'text', text: 'on it' })
    transcript.record({ type: 'done' })
    expect(transcript.failed).toBe(false)
  })

  it('remembers that the reaction hit an error chunk', () => {
    const transcript = new TaskInjectionTranscript()
    transcript.record({ type: 'text', text: 'partial' })
    transcript.record({ type: 'error', text: 'provider 500' })
    transcript.record({ type: 'done' })
    expect(transcript.failed).toBe(true)
    // The partial answer is still persisted; only the ack is withheld.
    expect(transcript.responseText).toBe('partial')
  })
})
