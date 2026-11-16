/**
 * Codemode tool (plan 2026-10-08-codemode), integration:
 *  A. real pi-agent `Agent` loop over the faux provider: one codemode call,
 *     nested calls pass beforeToolCall/afterToolCall, the transcript holds
 *     exactly one tool result (codemode);
 *  B. TaskRunner with the real loop + openai-completions fake HTTP: Eco skips
 *     nested calls and handles the codemode result on the normal path; nested
 *     calls count against the task tool-call cap and the repeated-call guard.
 * Synthetic data only, no cloud/live call.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import { buildCodemodeTool, DEFAULT_CODEMODE_SETTINGS } from './codemode-tool.js'
import { createYoloTools } from './agent-runtime.js'
import { initDatabase } from './database.js'
import { setStrandEcoEnabled } from './eco-mode-store.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { TaskStore } from './task-store.js'
import { TaskRunner } from './task-runner.js'
import type { TaskRunnerOptions } from './task-runner.js'
import { SessionManager } from './session-manager.js'
import type { ProviderConfig } from './provider-config.js'

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }> }
let tmpDir: string
let previous: Record<string, string | undefined> = {}
let server: http.Server
let origin: string
let received: Body[] = []
let script: Array<(res: http.ServerResponse) => void> = []
let defaultReply: (res: http.ServerResponse) => void

function readTool(name: string, calls: Array<Record<string, unknown>>): AgentTool {
  return {
    name,
    label: name,
    description: `Synthetic ${name}.`,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id: string, params: unknown): Promise<AgentToolResult<unknown>> => {
      calls.push(params as Record<string, unknown>)
      return { content: [{ type: 'text', text: `content:${(params as { path: string }).path}` }], details: undefined }
    },
  }
}

describe('codemode in a real Agent loop (faux provider)', () => {
  it('runs nested calls through the hooks and leaves exactly one tool result in the transcript', async () => {
    const faux = createFauxCore({ models: [{ id: 'claude-faux' }] })
    const model = faux.getModel()
    const code = 'const [a, b] = await Promise.all([tools.read_file({ path: "/a" }), tools.list_files({ path: "/" })]); text(a); return b'
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('codemode', { code }, { id: 'toolu_parent' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done'),
    ])
    const readCalls: Array<Record<string, unknown>> = []
    const listCalls: Array<Record<string, unknown>> = []
    const tools = [readTool('read_file', readCalls), readTool('list_files', listCalls), readTool('email_send', [])]
    const before: string[] = []
    const after: string[] = []
    const settings = { ...DEFAULT_CODEMODE_SETTINGS, mode: 'readonly' as const }
    // eslint-disable-next-line prefer-const
    let agent: Agent
    const codemode = buildCodemodeTool({ tools, settings, modelId: model.id, getAgent: () => agent })
    expect(codemode).not.toBeNull()
    agent = new Agent({
      initialState: { systemPrompt: 'synthetic', model, tools: [...tools, codemode!] },
      streamFn: faux.streamSimple,
      getApiKey: () => 'none',
      beforeToolCall: async (ctx) => { before.push(`${ctx.toolCall.name}:${ctx.toolCall.id}`); return undefined },
      afterToolCall: async (ctx) => { after.push(`${ctx.toolCall.name}:${ctx.toolCall.id}`); return undefined },
    })
    const events: string[] = []
    agent.subscribe(e => { if (e.type === 'tool_execution_end') events.push(e.toolName) })
    await agent.prompt('go')

    expect(readCalls).toEqual([{ path: '/a' }])
    expect(listCalls).toEqual([{ path: '/' }])
    expect(before).toContain('codemode:toolu_parent')
    expect(before).toEqual(expect.arrayContaining(['read_file:toolu_parent/cm-1', 'list_files:toolu_parent/cm-2']))
    expect(after).toEqual(expect.arrayContaining(['read_file:toolu_parent/cm-1', 'list_files:toolu_parent/cm-2', 'codemode:toolu_parent']))
    // Only the model-issued call is a loop-level tool execution.
    expect(events).toEqual(['codemode'])
    const toolResults = agent.state.messages.filter(m => m.role === 'toolResult')
    expect(toolResults).toHaveLength(1)
    const result = toolResults[0] as { toolName: string; toolCallId: string; content: Array<{ type: string; text?: string }> }
    expect(result.toolName).toBe('codemode')
    expect(result.toolCallId).toBe('toolu_parent')
    const text = result.content.map(c => c.text ?? '').join('\n')
    expect(text).toMatch(/^codemode: 2 calls \(list_files×1, read_file×1\)/)
    expect(text).toContain('content:/a')
    expect(text).toContain('content:/')
    // The second request carries exactly one tool result too.
    expect(faux.state.callCount).toBe(2)
  })
})

const REAL_SHELL = (({ name, label, description, parameters }) => ({ name, label, description, parameters }))(createYoloTools().find(t => t.name === 'shell')!)

function shellLikeTool(calls: string[]): AgentTool {
  return {
    ...REAL_SHELL,
    execute: async (toolCallId: string) => {
      calls.push(toolCallId)
      const ok = Array.from({ length: 600 }, (_, i) => ` ✓ src/m${i}.test.ts (3 tests) ${i % 40}ms`)
      ok.push('      Tests  1800 passed', 'exit status 0')
      return { content: [{ type: 'text', text: ok.join('\n') }], details: { exitCode: 0 } }
    },
  } as AgentTool
}

function openaiSse(res: http.ServerResponse, opts: { tool?: { id: string; name: string; args: unknown }; text?: string }) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const frame = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  if (opts.tool) {
    res.write(frame({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: opts.tool.id, type: 'function', function: { name: opts.tool.name, arguments: JSON.stringify(opts.tool.args) } }] }, null))
    res.write(frame({}, 'tool_calls'))
  } else {
    res.write(frame({ role: 'assistant', content: opts.text ?? 'ok' }, null))
    res.write(frame({}, 'stop'))
  }
  res.end('data: [DONE]\n\n')
}

describe('codemode in the TaskRunner (real pi-agent loop, fake HTTP)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-task-'))
    fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({ codemode: { mode: 'coding', models: ['local-'] } }))
    previous = { DATA_DIR: process.env.DATA_DIR, WORKSPACE_DIR: process.env.WORKSPACE_DIR }
    process.env.DATA_DIR = tmpDir
    process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
    received = []
    script = []
    defaultReply = res => openaiSse(res, { text: 'STATUS: completed\nSUMMARY: synthetic done' })
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
      req.on('end', () => {
        try { received.push(JSON.parse(raw) as Body) } catch { received.push({ messages: [] }) }
        const next = script.shift()
        if (next) next(res)
        else defaultReply(res)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    setHeuristicsOverrideForTests(null)
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function runTask(opts: { tools: AgentTool[]; code: string; eco?: boolean }) {
    const db = initDatabase(path.join(tmpDir, `task-${Math.random().toString(36).slice(2)}.db`))
    const store = new TaskStore(db)
    const STRAND = 'strand-codemode'
    db.prepare("INSERT INTO sessions (id, source, type, parent_session_id, session_user) VALUES (?, 'system', 'interactive', NULL, '1')").run(STRAND)
    setStrandEcoEnabled(db, STRAND, opts.eco ?? false)
    let done: () => void = () => {}
    const taskDone = new Promise<void>(r => { done = r })
    const provider: ProviderConfig = {
      id: 'p-local', name: 'p-local', type: 'openai', providerType: 'openai', provider: 'openai', baseUrl: `${origin}/v1`,
      apiKey: 'none', enabledModels: ['local-test'], models: [], status: 'connected', authMethod: 'api-key',
    } as ProviderConfig
    const runner = new TaskRunner({
      db,
      buildModel: () => ({
        id: 'local-test', name: 'Local test', api: 'openai-completions', provider: 'openai', baseUrl: `${origin}/v1`, reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 2048,
      }) as unknown as ReturnType<TaskRunnerOptions['buildModel']>,
      getApiKey: async () => 'none',
      tools: opts.tools,
      onTaskComplete: () => { done() },
      sessionManager: new SessionManager({ db }),
    })
    script.push(res => openaiSse(res, { tool: { id: 'tc-cm-1', name: 'codemode', args: { code: opts.code } } }))
    const task = store.create({ name: 'codemode synthetic', prompt: 'do the synthetic work', triggerType: 'user', agentId: 'main' })
    await runner.startTask(task, provider, undefined, STRAND)
    await Promise.race([taskDone, new Promise((_, rej) => setTimeout(() => rej(new Error('task timeout')), 20000))])
    // Let the teardown of a guarded task settle.
    await new Promise(resolve => setTimeout(resolve, 100))
    const final = store.getById(task.id)!
    runner.dispose()
    const firstTools = (received[0]?.tools as Array<{ function: { name: string } }> | undefined)?.map(t => t.function.name) ?? []
    const toolMessages = (received[1]?.messages ?? []).filter(m => m.role === 'tool')
    const ecoRows = db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE eco_original IS NOT NULL").get() as { n: number }
    const toolCallRows = db.prepare("SELECT tool_name FROM tool_calls WHERE session_id = ? AND tool_name NOT IN ('task_usage', 'task_guard')").all(final.sessionId) as Array<{ tool_name: string }>
    db.close()
    return { final, firstTools, toolMessages, ecoRows: ecoRows.n, toolCallRows: toolCallRows.map(r => r.tool_name) }
  }

  it('offers codemode only with the setting, Eco skips nested calls and sees only the codemode result', async () => {
    const shellCalls: string[] = []
    const log = vi.spyOn(console, 'log')
    try {
      const out = await runTask({
        eco: true,
        tools: [shellLikeTool(shellCalls)],
        code: 'const log = await tools.shell({ command: "npm test" }); text(log.includes("src/m450.test.ts") ? "NESTED-FULL" : "NESTED-PROJECTED"); return log',
      })
      expect(out.final.status).toBe('completed')
      expect(out.firstTools).toEqual(['shell', 'codemode'])
      expect(shellCalls).toEqual(['tc-cm-1/cm-1'])
      // Exactly one tool result reaches the model: the codemode one.
      expect(out.toolMessages).toHaveLength(1)
      const toolText = typeof out.toolMessages[0].content === 'string' ? out.toolMessages[0].content : JSON.stringify(out.toolMessages[0].content)
      expect(toolText).toContain('codemode: 1 call (shell×1)')
      // The script saw the raw nested result: no Eco projection inside.
      expect(toolText).toContain('NESTED-FULL')
      const ecoLines = log.mock.calls.map(args => String(args[0])).filter(l => l.startsWith('[eco] decision='))
      // The codemode result went through the normal freeze path (codemode
      // output is not a projectable profile, so it is kept as is) ...
      expect(ecoLines.some(l => l.includes('tool=codemode'))).toBe(true)
      // ... and the nested shell call never did.
      expect(ecoLines.some(l => l.includes('tool=shell'))).toBe(false)
      expect(out.ecoRows).toBe(0)
      // Only the model-issued call is recorded as a task tool call.
      expect(out.toolCallRows.filter(n => n === 'shell')).toHaveLength(0)
    } finally {
      log.mockRestore()
    }
  })

  it('counts nested calls against the task tool-call cap', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 3, repeatedToolCalls: 0, maxInputTokens: 0 } })
    const reads: Array<Record<string, unknown>> = []
    const out = await runTask({
      tools: [readTool('read_file', reads)],
      code: 'for (let i = 0; i < 20; i++) await tools.read_file({ path: "/f" + i })',
    })
    expect(out.final.status).toBe('failed')
    expect(out.final.errorMessage).toContain('tool call cap of 3')
    expect(reads.length).toBeLessThan(3)
  })

  it('counts nested calls against the repeated-call guard', async () => {
    setHeuristicsOverrideForTests({ taskGuard: { maxToolCalls: 0, repeatedToolCalls: 3, maxInputTokens: 0 } })
    const reads: Array<Record<string, unknown>> = []
    const out = await runTask({
      tools: [readTool('read_file', reads)],
      code: 'for (let i = 0; i < 20; i++) { try { await tools.read_file({ path: "/same" }) } catch (e) {} }',
    })
    expect(out.final.status).toBe('failed')
    expect(out.final.errorMessage).toContain('read_file')
    expect(reads.length).toBeLessThan(3)
  })

  it('does not offer codemode when the setting is off', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config', 'settings.json'), JSON.stringify({}))
    const out = await runTask({ tools: [shellLikeTool([])], code: 'return 1' })
    expect(out.firstTools).toEqual(['shell'])
  })
})
