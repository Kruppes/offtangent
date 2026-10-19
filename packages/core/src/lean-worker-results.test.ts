/**
 * lean_local result contract (acceptance fixes P1–P3, 2026-10-19):
 * - P1 an unusable output_schema fails closed (start, recovery, mid-run),
 * - P2 a success returns only JSON.stringify of the validated value,
 * - P3 every lean non-success text is capped; normal tasks are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'
import type { Task } from './task-store.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { LEAN_NON_SUCCESS_MAX_CHARS, LEAN_SYSTEM_PROMPT, compactLeanText } from './lean-worker-profile.js'

type Reply = string | Error | (() => string)
const script = vi.hoisted(() => ({ replies: [] as unknown[], prompts: [] as string[] }))

vi.mock('./provider-config.js', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return { ...original, estimateCost: vi.fn(() => 0) }
})

vi.mock('@earendil-works/pi-agent-core', () => {
  return {
    Agent: vi.fn().mockImplementation(() => {
      const messages: unknown[] = []
      return {
        subscribe: vi.fn(() => () => {}),
        prompt: vi.fn(async (text: string) => {
          script.prompts.push(text)
          const next = (script.replies.shift() ?? 'STATUS: completed\nSUMMARY:\n```json\n{"total":"0"}\n```') as Reply
          if (next instanceof Error) throw next
          const reply = typeof next === 'function' ? next() : next
          messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] })
        }),
        abort: vi.fn(),
        state: { get messages() { return messages } },
      }
    }),
  }
})

const localOllama = {
  id: 'ollama-id', name: 'Ollama', type: 'ollama', providerType: 'ollama', provider: 'ollama',
  baseUrl: 'http://gpu-box.local:11434', apiKey: '', enabledModels: ['qwen3.8:27b-mlx'], models: [],
  status: 'connected', authMethod: 'api-key',
} as unknown as ProviderConfig
const cloud = { ...localOllama, id: 'cloud-id', name: 'Cloud', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com' } as unknown as ProviderConfig

const SCHEMA = '{"type":"object","required":["total"],"properties":{"total":{"type":"string"}}}'
const BROKEN_SCHEMAS = ['{not json', '{"type":"array"}', '[1,2]']
const LONG = 'Q'.repeat(50) + ' ' + 'detail '.repeat(1200) // ~8.4k chars
const SHORT = 'Which year should I extract, 2025 or 2026?'

function fakeTool(name: string) {
  return { name, label: name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80))

describe('lean_local result contract (P1–P3)', () => {
  const tmpFiles: string[] = []
  let db: Database
  let runner: TaskRunner

  beforeEach(() => {
    setHeuristicsOverrideForTests({ delegation: { minBriefChars: 0 } })
    const p = path.join(os.tmpdir(), `axiom-lean-results-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    const options: TaskRunnerOptions = {
      db,
      buildModel: () => ({ id: 'qwen3.8:27b-mlx' } as ReturnType<TaskRunnerOptions['buildModel']>),
      getApiKey: async () => '',
      tools: ['shell', 'read_file', 'list_files', 'email_list', 'email_read', 'web_fetch'].map(fakeTool) as unknown as TaskRunnerOptions['tools'],
      memoryDir: undefined,
      onTaskComplete: () => {},
      sessionManager: new SessionManager({ db }),
    }
    runner = new TaskRunner(options)
    script.replies.length = 0
    script.prompts.length = 0
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    runner.dispose()
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* cleanup only */ }
    }
    tmpFiles.length = 0
  })

  async function run(opts: { lean: boolean; schema?: string | null; replies: Reply[] }): Promise<Task> {
    script.replies.push(...opts.replies)
    const task = runner.getStore().create({
      name: opts.lean ? 'Lean' : 'Normal',
      prompt: 'Extract the total from /workspace/a.txt',
      triggerType: 'agent',
      provider: 'Ollama',
      model: 'qwen3.8:27b-mlx',
      workerProfile: opts.lean ? 'lean_local' : undefined,
      outputSchema: opts.schema === undefined ? SCHEMA : (opts.schema ?? undefined),
    })
    try {
      await runner.startTask(task, localOllama)
    } catch {
      // a refused start marks the row failed
    }
    await settle()
    return runner.getStore().getById(task.id)!
  }

  describe('P1: unusable output_schema fails closed', () => {
    it.each(BROKEN_SCHEMAS)('refuses to start a lean task with schema %s', async (schema) => {
      const after = await run({ lean: true, schema, replies: [] })
      expect(script.prompts).toHaveLength(0)
      expect(after.status).toBe('failed')
      expect(after.resultStatus).toBe('failed')
    })

    it('fails a lean task whose stored schema becomes unusable during the run (no "accepting result")', async () => {
      let id = ''
      const corrupt = () => {
        db.prepare('UPDATE tasks SET output_schema = ? WHERE id = ?').run('{not json', id)
        return 'STATUS: completed\nSUMMARY:\n```json\n{"total":"12.50"}\n```'
      }
      script.replies.push(corrupt)
      const task = runner.getStore().create({ name: 'Lean', prompt: 'x', triggerType: 'agent', provider: 'Ollama', model: 'qwen3.8:27b-mlx', workerProfile: 'lean_local', outputSchema: SCHEMA })
      id = task.id
      await runner.startTask(task, localOllama)
      await settle()
      const after = runner.getStore().getById(task.id)!
      expect(after.status).toBe('failed')
      expect(after.resultSummary).toMatch(/output_schema unusable/)
      expect(after.resultSummary).not.toContain('12.50')
    })

    it('control: a normal task with an unusable stored schema still accepts its result (unchanged)', async () => {
      let id = ''
      script.replies.push(() => {
        db.prepare('UPDATE tasks SET output_schema = ? WHERE id = ?').run('{not json', id)
        return 'STATUS: completed\nSUMMARY:\nTotal is 12.50'
      })
      const task = runner.getStore().create({ name: 'Normal', prompt: 'x', triggerType: 'agent', provider: 'Ollama', model: 'qwen3.8:27b-mlx', outputSchema: SCHEMA })
      id = task.id
      await runner.startTask(task, localOllama)
      await settle()
      const after = runner.getStore().getById(task.id)!
      expect(after.status).toBe('completed')
      expect(after.resultSummary).toBe('Total is 12.50')
    })

    it.each(BROKEN_SCHEMAS)('does not resume a lean task with a broken non-empty stored schema %s after restart', async (schema) => {
      const store = runner.getStore()
      const task = store.create({ name: 'Lean R', prompt: 'x', triggerType: 'agent', provider: 'Ollama', model: 'qwen3.8:27b-mlx', workerProfile: 'lean_local', outputSchema: SCHEMA, sessionId: 'lean-r' })
      store.update(task.id, { status: 'running' })
      db.prepare('UPDATE tasks SET output_schema = ? WHERE id = ?').run(schema, task.id)
      const result = await runner.recoverTasks(name => (name === 'Ollama' ? localOllama : null), cloud)
      expect(result).toEqual({ resumed: 0, failed: 1 })
      await settle()
      expect(script.prompts).toHaveLength(0)
      const after = store.getById(task.id)!
      expect(after.status).toBe('failed')
      expect(after.errorMessage).toMatch(/usable output_schema/)
      expect(store.list().some(t => t.name === 'Lean R (resumed)')).toBe(false)
    })
  })

  describe('P2: success returns only the validated JSON', () => {
    it('drops prose around a valid JSON object', async () => {
      const after = await run({ lean: true, replies: ['STATUS: completed\nSUMMARY:\nHere is the result:\n```json\n{ "total": "12.50" }\n```\nLet me know if you need more.'] })
      expect(after.status).toBe('completed')
      expect(after.resultSummary).toBe('{"total":"12.50"}')
    })

    it('drops prose in the corrected answer after the correction round', async () => {
      const after = await run({
        lean: true,
        replies: [
          'STATUS: completed\nSUMMARY:\n{"total": 12.5}',
          'STATUS: completed\nSUMMARY:\nSorry, fixed:\n```json\n{"total":"12.50"}\n```\nDone.',
        ],
      })
      expect(script.prompts).toHaveLength(2)
      expect(after.status).toBe('completed')
      expect(after.resultSummary).toBe('{"total":"12.50"}')
    })

    it('control: a normal task with schema keeps its full summary', async () => {
      const summary = 'Here is the result:\n```json\n{"total":"12.50"}\n```\nLet me know.'
      const after = await run({ lean: false, replies: [`STATUS: completed\nSUMMARY:\n${summary}`] })
      expect(after.status).toBe('completed')
      expect(after.resultSummary).toBe(summary)
    })
  })

  describe('P3: lean non-success texts are capped', () => {
    it('caps a long failed summary, keeps the head, caps the handoff too', async () => {
      const after = await run({ lean: true, replies: [`STATUS: failed\nSUMMARY:\n${LONG}`] })
      expect(after.status).toBe('failed')
      expect(after.resultStatus).toBe('failed')
      expect(after.resultSummary!.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
      expect(after.resultSummary!.startsWith('Q'.repeat(50))).toBe(true)
      expect(after.resultSummary).toMatch(/characters cut \(lean_local result limit 2000\)/)
      expect((after.handoff ?? '').length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
    })

    it('keeps a short failed summary unchanged', async () => {
      const after = await run({ lean: true, replies: ['STATUS: failed\nSUMMARY:\nFile /workspace/a.txt is unreadable.'] })
      expect(after.resultSummary).toBe('File /workspace/a.txt is unreadable.')
    })

    it('caps a long question but keeps it a question (paused, head intact)', async () => {
      const after = await run({ lean: true, replies: [`STATUS: question\nSUMMARY:\n${SHORT}\n${LONG}`] })
      expect(after.status).toBe('paused')
      expect(after.resultStatus).toBe('question')
      expect(after.resultSummary!.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
      expect(after.resultSummary!.startsWith(SHORT)).toBe(true)
      expect(runner.isPaused(after.id)).toBe(true)
    })

    it('keeps a short question unchanged', async () => {
      const after = await run({ lean: true, replies: [`STATUS: question\nSUMMARY:\n${SHORT}`] })
      expect(after.status).toBe('paused')
      expect(after.resultSummary).toBe(SHORT)
    })

    it('caps a long correction-round failure (and keeps a short one)', async () => {
      const long = await run({ lean: true, replies: ['STATUS: completed\nSUMMARY:\n{"total": 1}', new Error(`provider exploded: ${LONG}`)] })
      expect(long.status).toBe('failed')
      expect(long.resultSummary!.startsWith('output_schema correction turn failed: provider exploded')).toBe(true)
      expect(long.resultSummary!.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)

      const short = await run({ lean: true, replies: ['STATUS: completed\nSUMMARY:\n{"total": 1}', 'STATUS: completed\nSUMMARY:\n{"total": 2}'] })
      expect(short.status).toBe('failed')
      expect(short.resultSummary).toMatch(/^output_schema not satisfied after the correction turn\./)
      expect(short.resultSummary).not.toMatch(/characters cut/)
    })

    it('caps a long run error message', async () => {
      const after = await run({ lean: true, replies: [new Error(`boom ${LONG}`)] })
      expect(after.status).toBe('failed')
      expect(after.resultSummary!.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
      expect(after.errorMessage!.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
    })

    it('control: normal tasks keep long failed/question/error texts unchanged', async () => {
      const failed = await run({ lean: false, schema: null, replies: [`STATUS: failed\nSUMMARY:\n${LONG}`] })
      expect(failed.resultSummary).toBe(LONG.trim())
      const question = await run({ lean: false, schema: null, replies: [`STATUS: question\nSUMMARY:\n${SHORT}\n${LONG}`] })
      expect(question.resultStatus).toBe('question')
      expect(question.resultSummary).toBe(`${SHORT}\n${LONG}`.trim())
      const errored = await run({ lean: false, schema: null, replies: [new Error(`boom ${LONG}`)] })
      expect(errored.errorMessage).toBe(`boom ${LONG}`)
    })
  })

  it('the lean system prompt makes no privacy promise (efficiency profile, not an isolation boundary)', () => {
    expect(LEAN_SYSTEM_PROMPT).not.toMatch(/leaves this machine|private machine/)
    expect(LEAN_SYSTEM_PROMPT).toContain('local model')
  })

  it('compactLeanText: short unchanged, long capped to the limit with an honest marker', () => {
    expect(compactLeanText('abc')).toBe('abc')
    const capped = compactLeanText('x'.repeat(10_000))
    expect(capped.length).toBeLessThanOrEqual(LEAN_NON_SUCCESS_MAX_CHARS)
    expect(capped).toMatch(/\[… \d+ characters cut/)
    expect(compactLeanText('x'.repeat(LEAN_NON_SUCCESS_MAX_CHARS))).toBe('x'.repeat(LEAN_NON_SUCCESS_MAX_CHARS))
  })
})
