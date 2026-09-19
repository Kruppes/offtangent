import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSendFileTool, getCurrentTaskExecutionContext, initDatabase, runWithTaskExecutionContext } from '@axiom/core'
import type { Database, SendFileDelivery, UploadDescriptor } from '@axiom/core'
import { ChatEventBus, type ChatEvent } from './chat-event-bus.js'
import { deliverTaskFile } from './task-file-delivery.js'

const upload: UploadDescriptor = {
  kind: 'file',
  originalName: 'offtangent-0.9.1-release.apk',
  storedName: 'abc123-offtangent-0.9.1-release.apk',
  relativePath: '2026/09/14/abc123-offtangent-0.9.1-release.apk',
  urlPath: '/api/uploads/2026/09/14/abc123-offtangent-0.9.1-release.apk',
  mimeType: 'application/octet-stream',
  size: 5_459_816,
}

describe('deliverTaskFile', () => {
  let db: Database
  let bus: ChatEventBus
  let events: ChatEvent[]

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'alice', 'x', 'admin')").run()
    bus = new ChatEventBus()
    events = []
    bus.subscribe((event) => { events.push(event) })
  })

  it('persists the file on an assistant row of the triggering strand and broadcasts it', () => {
    const result = deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 3,
      sessionId: 'strand-that-started-the-task',
      agentId: 'bob',
      upload,
    })

    expect(result.messageId).toBeGreaterThan(0)

    const row = db.prepare(
      'SELECT session_id, user_id, role, content, metadata, agent_id FROM chat_messages WHERE id = ?'
    ).get(result.messageId) as { session_id: string; user_id: number; role: string; content: string; metadata: string; agent_id: string }
    expect(row.session_id).toBe('strand-that-started-the-task')
    expect(row.user_id).toBe(3)
    expect(row.role).toBe('assistant')
    expect(row.agent_id).toBe('bob')
    const meta = JSON.parse(row.metadata) as { files: UploadDescriptor[] }
    expect(meta.files).toHaveLength(1)
    expect(meta.files[0]!.relativePath).toBe(upload.relativePath)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'attachment',
      userId: 3,
      source: 'task',
      sessionId: 'strand-that-started-the-task',
      agentId: 'bob',
    })
    expect(events[0]!.attachment?.relativePath).toBe(upload.relativePath)
    // The frame names the row it was persisted on, so a live client renders
    // the file as that row instead of appending the card to the last answer.
    expect(events[0]!.messageId).toBe(result.messageId)
  })

  it('carries the caption on the persisted descriptor and on the broadcast frame', () => {
    const result = deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 3,
      sessionId: 'strand-1',
      agentId: 'main',
      upload,
      caption: 'Release 0.9.1, versionCode 17',
    })

    const row = db.prepare('SELECT metadata FROM chat_messages WHERE id = ?').get(result.messageId) as { metadata: string }
    const meta = JSON.parse(row.metadata) as { files: UploadDescriptor[] }
    expect(meta.files[0]!.caption).toBe('Release 0.9.1, versionCode 17')
    expect(events[0]!.attachment?.caption).toBe('Release 0.9.1, versionCode 17')
  })

  it('refuses to deliver without a strand instead of dropping the file silently', () => {
    expect(() => deliverTaskFile({ db, chatEventBus: bus }, {
      userId: 3,
      sessionId: null,
      agentId: 'main',
      upload,
    })).toThrow(/strand/i)
    expect(events).toHaveLength(0)
  })

  it('persists the row even without a chat event bus', () => {
    const result = deliverTaskFile({ db, chatEventBus: null }, {
      userId: 3,
      sessionId: 'strand-2',
      agentId: 'main',
      upload,
    })
    expect(result.messageId).toBeGreaterThan(0)
    expect(result.broadcast).toBe(false)
  })
})

/**
 * The background half of `send_file_to_user`, wired exactly as
 * `runtime-composition.ts` wires it: identity from the task execution
 * context, delivery through `deliverTaskFile`. That the composition registers
 * this tool for tasks is asserted in `bootstrap/runtime-composition.test.ts`;
 * that the task runner binds the context is asserted in
 * `core/src/task-runner.test.ts`.
 */
describe('send_file_to_user inside a background task', () => {
  let db: Database
  let bus: ChatEventBus
  let events: ChatEvent[]
  let dataDir: string
  let workspaceDir: string
  let previousEnv: { DATA_DIR?: string; WORKSPACE_DIR?: string }

  function buildTool() {
    return createSendFileTool({
      getCurrentToolUserId: () => getCurrentTaskExecutionContext()?.userId ?? undefined,
      getCurrentInteractiveSessionId: () => getCurrentTaskExecutionContext()?.sessionId ?? null,
      deliverFile: (delivery: SendFileDelivery) => {
        return deliverTaskFile({ db, chatEventBus: bus }, {
          userId: delivery.userId,
          sessionId: delivery.sessionId,
          agentId: getCurrentTaskExecutionContext()?.agentId ?? 'main',
          upload: delivery.upload,
          caption: delivery.caption,
        })
      },
    })
  }

  beforeEach(() => {
    previousEnv = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-file-'))
    workspaceDir = path.join(dataDir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true })
    process.env.DATA_DIR = dataDir
    process.env.WORKSPACE_DIR = workspaceDir

    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (3, 'alice', 'x', 'admin')").run()
    bus = new ChatEventBus()
    events = []
    bus.subscribe((event) => { events.push(event) })
  })

  afterEach(() => {
    process.env.DATA_DIR = previousEnv.DATA_DIR
    process.env.WORKSPACE_DIR = previousEnv.WORKSPACE_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('delivers the file into the strand that triggered the task', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'offtangent-0.9.1.apk'), 'apk-bytes')
    const tool = buildTool()

    const result = await runWithTaskExecutionContext(
      { provider: null, agentId: 'bob', taskId: 'task-1', userId: 3, sessionId: 'strand-that-started-the-task' },
      () => tool.execute('call-1', { path: 'offtangent-0.9.1.apk', caption: 'Release 0.9.1' }) as Promise<unknown>,
    ) as { details?: { error?: boolean; uploadedFile?: UploadDescriptor } }

    expect(result.details?.error).toBeFalsy()

    const row = db.prepare(
      "SELECT session_id, user_id, agent_id, metadata FROM chat_messages WHERE role = 'assistant'"
    ).get() as { session_id: string; user_id: number; agent_id: string; metadata: string }
    expect(row.session_id).toBe('strand-that-started-the-task')
    expect(row.user_id).toBe(3)
    expect(row.agent_id).toBe('bob')
    const meta = JSON.parse(row.metadata) as { files: UploadDescriptor[] }
    expect(meta.files[0]!.originalName).toBe('offtangent-0.9.1.apk')
    expect(meta.files[0]!.caption).toBe('Release 0.9.1')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'attachment', sessionId: 'strand-that-started-the-task', agentId: 'bob' })
    expect(events[0]!.attachment?.caption).toBe('Release 0.9.1')

    const storedPath = path.join(dataDir, 'uploads', meta.files[0]!.relativePath)
    expect(fs.readFileSync(storedPath, 'utf8')).toBe('apk-bytes')
  })

  it('still refuses outside any task context', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'x.txt'), 'x')
    const tool = buildTool()

    const result = await tool.execute('call-2', { path: 'x.txt' }) as { content: { text?: string }[]; details?: { error?: boolean } }

    expect(result.details?.error).toBe(true)
    expect(result.content.map(c => c.text ?? '').join('')).toMatch(/background contexts/i)
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_messages").get()).toMatchObject({ n: 0 })
  })

  it('reports an undeliverable file (task without a strand) as an error', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'y.txt'), 'y')
    const tool = buildTool()

    const result = await runWithTaskExecutionContext(
      { provider: null, agentId: 'main', taskId: 'task-2', userId: 3, sessionId: null },
      () => tool.execute('call-3', { path: 'y.txt' }) as Promise<unknown>,
    ) as { content: { text?: string }[]; details?: { error?: boolean } }

    expect(result.details?.error).toBe(true)
    expect(result.content.map(c => c.text ?? '').join('')).toMatch(/no strand/i)
    expect(events).toHaveLength(0)
  })
})
