/**
 * The whole path a file takes out of a background task, with the real
 * TaskRunner in the middle: task row → execution context (userId + strand)
 * → `send_file_to_user` → delivery into the strand that started the task.
 * Only the LLM agent is a stub; it calls the tool the runner handed it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'

vi.mock('@earendil-works/pi-agent-core', () => ({
  Agent: vi.fn().mockImplementation((options: { initialState?: { tools?: AgentTool[] } }) => {
    const messages: unknown[] = []
    const tools = options.initialState?.tools ?? []
    return {
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {
        const sendFile = tools.find(t => t.name === 'send_file_to_user')
        if (!sendFile) throw new Error('the task agent has no send_file_to_user tool')
        await sendFile.execute('call-1', { path: 'release.apk', caption: 'Release 0.9.1' })
        messages.push({ role: 'assistant', content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: sent' }] })
      }),
      abort: vi.fn(),
      state: { get messages() { return messages } },
    }
  }),
}))

const { initDatabase, SessionManager, TaskRunner, TaskStore, createSendFileTool, getCurrentTaskExecutionContext } = await import('@axiom/core')
type CoreDatabase = import('@axiom/core').Database
type CoreProviderConfig = import('@axiom/core').ProviderConfig
type CoreSendFileDelivery = import('@axiom/core').SendFileDelivery
const { ChatEventBus } = await import('./chat-event-bus.js')
const { deliverTaskFile } = await import('./task-file-delivery.js')

const provider = {
  id: 'p1',
  name: 'test-provider',
  type: 'openai',
  providerType: 'openai',
  provider: 'openai',
  baseUrl: 'http://localhost:1234',
  apiKey: 'k',
  enabledModels: ['test-model'],
} as unknown as CoreProviderConfig

describe('a background task sending a file', () => {
  let db: CoreDatabase
  let dataDir: string
  let workspaceDir: string
  let previousEnv: { DATA_DIR?: string; WORKSPACE_DIR?: string }

  beforeEach(() => {
    previousEnv = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-task-send-file-'))
    workspaceDir = path.join(dataDir, 'workspace')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, 'release.apk'), 'apk-bytes')
    process.env.DATA_DIR = dataDir
    process.env.WORKSPACE_DIR = workspaceDir
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (7, 'alice', 'x', 'admin')").run()
  })

  afterEach(() => {
    db.close()
    process.env.DATA_DIR = previousEnv.DATA_DIR
    process.env.WORKSPACE_DIR = previousEnv.WORKSPACE_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('lands in the strand that triggered it, on the wire and in history', async () => {
    const bus = new ChatEventBus()
    const events: Array<Record<string, unknown>> = []
    bus.subscribe((event) => { events.push(event as unknown as Record<string, unknown>) })

    const sessionManager = new SessionManager({ db })
    // The strand the user talked in, and the task session hanging off it.
    const strand = sessionManager.getOrCreateSession('7', 'web', 'bob')
    const store = new TaskStore(db)

    const sendFileTool = createSendFileTool({
      getCurrentToolUserId: () => getCurrentTaskExecutionContext()?.userId ?? undefined,
      getCurrentInteractiveSessionId: () => getCurrentTaskExecutionContext()?.sessionId ?? null,
      deliverFile: (delivery: CoreSendFileDelivery) => {
        return deliverTaskFile({ db, chatEventBus: bus }, {
          userId: delivery.userId,
          sessionId: delivery.sessionId,
          agentId: getCurrentTaskExecutionContext()?.agentId ?? 'main',
          upload: delivery.upload,
          caption: delivery.caption,
        })
      },
    })

    const runner = new TaskRunner({
      db,
      buildModel: () => ({} as ReturnType<ConstructorParameters<typeof TaskRunner>[0]['buildModel']>),
      getApiKey: async () => 'k',
      tools: [sendFileTool],
      onTaskComplete: () => {},
      sessionManager,
      // Exactly what runtime-composition wires: user + strand from the lineage.
      resolveTaskOrigin: (task) => {
        const row = db.prepare('SELECT parent_session_id FROM sessions WHERE id = ?').get(task.sessionId) as { parent_session_id: string | null } | undefined
        return { userId: 7, sessionId: row?.parent_session_id ?? task.sessionId }
      },
    })

    try {
      const task = store.create({
        name: 'Build the APK',
        prompt: 'build it',
        triggerType: 'agent',
        agentId: 'bob',
      })
      await runner.startTask(task, provider, undefined, strand.id)
      await new Promise(r => setTimeout(r, 150))

      const finished = store.getById(task.id)!
      expect(finished.errorMessage).toBeNull()
      expect(finished.status).toBe('completed')

      const row = db.prepare(
        "SELECT session_id, user_id, agent_id, content, metadata FROM chat_messages WHERE role = 'assistant' AND metadata LIKE '%files%'"
      ).get() as { session_id: string; user_id: number; agent_id: string; content: string; metadata: string } | undefined
      expect(row, 'the file must be persisted on an assistant row').toBeDefined()
      expect(row!.session_id).toBe(strand.id)
      expect(row!.user_id).toBe(7)
      expect(row!.agent_id).toBe('bob')
      const meta = JSON.parse(row!.metadata) as { files: Array<{ originalName: string; caption?: string }> }
      expect(meta.files[0]!.originalName).toBe('release.apk')
      expect(meta.files[0]!.caption).toBe('Release 0.9.1')

      const attachmentEvents = events.filter(e => e.type === 'attachment')
      expect(attachmentEvents).toHaveLength(1)
      expect(attachmentEvents[0]).toMatchObject({ userId: 7, sessionId: strand.id, agentId: 'bob', source: 'task' })
    } finally {
      runner.dispose()
    }
  })
})
