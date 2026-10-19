import { describe, expect, it, beforeEach } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { createRecallMessageTool } from './recall-message-tool.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { runWithTaskExecutionContext } from './task-execution-context.js'
import type { ProviderConfig } from './provider-config.js'

/**
 * Review finding 2 (lean_local B2): transcripts of lean local worker sessions
 * must not reach a non-local caller through recall_message or
 * read_chat_history; only the validated result stays visible.
 */

const RAW = 'KONTO-PRIVATE-RAW DE00 1234'

const localProvider = { id: 'l', name: 'Ollama', providerType: 'ollama', baseUrl: 'http://gpu-box.local:11434', enabledModels: ['qwen3.8:27b-mlx'], apiKey: '' } as unknown as ProviderConfig
const cloudProvider = { id: 'c', name: 'Cloud', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com', enabledModels: ['claude'], apiKey: 'k' } as unknown as ProviderConfig

function text(result: Awaited<ReturnType<AgentTool['execute']>>): string {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

function asTask<T>(provider: ProviderConfig, fn: () => Promise<T>): Promise<T> {
  return runWithTaskExecutionContext({ provider, taskId: 'caller', taskSessionId: 'caller-session' }, fn)
}

describe('lean session shield (recall_message + read_chat_history)', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO sessions (id, source, type) VALUES ('s1', 'web', 'interactive')").run()
    db.prepare("INSERT INTO sessions (id, source, type) VALUES ('lean-done', 'system', 'task')").run()
    db.prepare("INSERT INTO sessions (id, source, type) VALUES ('lean-run', 'system', 'task')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id, worker_profile, result_status, result_summary) VALUES ('t-done', 'Lean', 'p', 'completed', 'agent', 'lean-done', 'lean_local', 'completed', '{\"total\":\"12.50\"}')").run()
    db.prepare("INSERT INTO tasks (id, name, prompt, status, trigger_type, session_id, worker_profile) VALUES ('t-run', 'Lean2', 'p', 'running', 'agent', 'lean-run', 'lean_local')").run()
    const msg = db.prepare('INSERT INTO chat_messages (id, session_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, \'main\')')
    msg.run(10, 's1', 'assistant', 'normal strand answer', null)
    msg.run(20, 'lean-done', 'user', `Brief: read /workspace/k.txt ${RAW}`, null)
    msg.run(21, 'lean-done', 'tool', `Tool: read_file ${RAW}`, JSON.stringify({ toolName: 'read_file', toolArgs: { path: 'k.txt' }, toolResult: RAW }))
    msg.run(22, 'lean-done', 'assistant', `thinking about ${RAW}`, null)
    msg.run(23, 'lean-done', 'assistant', `STATUS: completed\nSUMMARY:\n{"total":"12.50"} ${RAW}`, null)
    msg.run(30, 'lean-run', 'assistant', `partial ${RAW}`, null)
    db.prepare("INSERT INTO tool_calls (session_id, tool_name, input, output) VALUES ('lean-done', 'read_file', '{}', ?)").run(RAW)
  })

  describe('recall_message', () => {
    it('withholds tool rows, briefs and intermediate answers of a lean session from a non-local caller', async () => {
      const tool = createRecallMessageTool({ db })
      for (const id of [20, 21, 22, 30]) {
        const t = text(await tool.execute('c', { message_id: id }))
        expect(t).toContain('[withheld: message of lean_local task')
        expect(t).not.toContain(RAW)
      }
      // A cloud background task is equally non-local.
      const fromCloud = text(await asTask(cloudProvider, () => tool.execute('c', { message_id: 21 })))
      expect(fromCloud).not.toContain(RAW)
    })

    it('keeps the validated result visible on the final assistant row', async () => {
      const t = text(await createRecallMessageTool({ db }).execute('c', { message_id: 23 }))
      expect(t).toContain('validated result')
      expect(t).toContain('{"total":"12.50"}')
      expect(t).not.toContain(RAW)
    })

    it('leaves normal rows untouched and lets a local task read the raw lean rows', async () => {
      const tool = createRecallMessageTool({ db })
      expect(text(await tool.execute('c', { message_id: 10 }))).toContain('normal strand answer')
      const local = text(await asTask(localProvider, () => tool.execute('c', { message_id: 21 })))
      expect(local).toContain(RAW)
    })
  })

  describe('read_chat_history', () => {
    it('masks lean rows for a non-local caller and keeps the validated result', async () => {
      const t = text(await createReadChatHistoryTool({ db }).execute('c', {}))
      expect(t).toContain('normal strand answer')
      expect(t).not.toContain(RAW)
      expect(t).toContain('[withheld: message of lean_local task t-done')
      expect(t).toContain('[withheld: message of lean_local task t-run')
      expect(t).toContain('{"total":"12.50"}')
    })

    it('does not act as a search oracle over lean content (messages or tool calls)', async () => {
      const tool = createReadChatHistoryTool({ db })
      const viaQuery = text(await tool.execute('c', { query: 'KONTO' }))
      expect(viaQuery).toContain('No chat messages found')
      const fromCloud = text(await asTask(cloudProvider, () => tool.execute('c', { session_id: 'lean-done' })))
      expect(fromCloud).not.toContain(RAW)
    })

    it('shows the raw lean transcript to a local task', async () => {
      const t = text(await asTask(localProvider, () => createReadChatHistoryTool({ db }).execute('c', { session_id: 'lean-done' })))
      expect(t).toContain(RAW)
    })
  })
})
