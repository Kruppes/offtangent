/**
 * Codemode tool (plan 2026-10-08-codemode): unit, security and determinism
 * tests over the real pi-codemode sandbox (QuickJS/WASM). All fixtures are
 * synthetic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool, AgentToolResult, AgentMessage, BeforeToolCallContext, AfterToolCallContext } from '@earendil-works/pi-agent-core'
import {
  CODEMODE_CODING_EXTRA_TOOLS,
  CODEMODE_IMAGE_DISCARDED_NOTE,
  CODEMODE_NEVER_TOOLS,
  CODEMODE_READONLY_TOOLS,
  DEFAULT_CODEMODE_SETTINGS,
  buildCodemodeTool,
  codemodeAllowedToolNames,
  createCodemodeConcurrencyLimiter,
  createCodemodeNestedRunner,
  createCodemodeTool,
  formatCodemodeSummary,
  isCodemodeEnabledFor,
  isNestedCodemodeCallId,
  loadCodemodeSettings,
  nestedCodemodeCallId,
  resolveCodemodeSettings,
  withCodemodeTool,
  type CodemodeAgentLike,
  type CodemodeDetails,
  type CodemodeSettings,
} from './codemode-tool.js'
import { withSecretBoundary, invalidateKnownValues, REDACTED_HANDLE } from './secret-boundary.js'
import { invalidateSecretHandleCache } from './secret-store.js'
import { setSecret } from './secrets-config.js'

const SYNTHETIC_SECRET = 'synthetic-codemode-secret-value-7781'

let tmpDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemode-tool-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-codemode-unit-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

type Exec = (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string

interface FakeTool extends AgentTool {
  calls: Array<{ id: string; args: Record<string, unknown> }>
}

function fakeTool(name: string, run: Exec = args => `${name}:${JSON.stringify(args)}`): FakeTool {
  const calls: FakeTool['calls'] = []
  const tool: FakeTool = {
    name,
    label: name,
    description: `Synthetic ${name} tool.`,
    parameters: Type.Object({ path: Type.Optional(Type.String()), command: Type.Optional(Type.String()), q: Type.Optional(Type.String()) }),
    calls,
    execute: async (id: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
      const args = (params ?? {}) as Record<string, unknown>
      calls.push({ id, args })
      const text = await run(args, signal)
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }
  return tool
}

function failingTool(name: string, message: string): FakeTool {
  return fakeTool(name, () => { throw new Error(message) })
}

interface HookLog {
  before: string[]
  after: string[]
}

function fakeAgent(hooks?: Partial<CodemodeAgentLike>): CodemodeAgentLike & { log: HookLog } {
  const log: HookLog = { before: [], after: [] }
  const messages: AgentMessage[] = []
  return {
    log,
    state: { messages },
    beforeToolCall: async (ctx: BeforeToolCallContext, signal?: AbortSignal) => {
      log.before.push(ctx.toolCall.id)
      return hooks?.beforeToolCall?.(ctx, signal)
    },
    afterToolCall: async (ctx: AfterToolCallContext, signal?: AbortSignal) => {
      log.after.push(ctx.toolCall.id)
      return hooks?.afterToolCall?.(ctx, signal)
    },
  }
}

function settings(overrides: Partial<CodemodeSettings> = {}): CodemodeSettings {
  return { ...DEFAULT_CODEMODE_SETTINGS, models: [...DEFAULT_CODEMODE_SETTINGS.models], mode: 'coding', timeoutMs: 10_000, ...overrides }
}

function build(tools: AgentTool[], overrides: Partial<CodemodeSettings> = {}, agent = fakeAgent()) {
  const tool = createCodemodeTool({
    tools,
    settings: settings(overrides),
    createRunner: allowed => createCodemodeNestedRunner(() => agent, allowed),
  })
  if (!tool) throw new Error('codemode tool not built')
  return { tool, agent }
}

async function run(tool: AgentTool, code: string, signal?: AbortSignal, id = 'call-1') {
  const result = await tool.execute(id, { code }, signal)
  const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
  const details = (result.details as { codemode: CodemodeDetails }).codemode
  return { result, text, details }
}

describe('codemode settings', () => {
  it('defaults to off with the documented limits', () => {
    expect(resolveCodemodeSettings(undefined)).toEqual({
      settings: {
        mode: 'off',
        models: ['claude-', 'gpt-'],
        timeoutMs: 120_000,
        memoryLimitBytes: 64 * 1024 * 1024,
        maxNestedCalls: 50,
        maxConcurrentNestedCalls: 4,
        maxOutputChars: 20_000,
      },
      problems: [],
    })
  })

  it('falls back per invalid field and reports it, a typo never enables codemode', () => {
    const { settings: s, problems } = resolveCodemodeSettings({ mode: 'on', models: 'claude-', timeoutMs: 5, maxNestedCalls: 2.5, maxOutputChars: 30_000 })
    expect(s.mode).toBe('off')
    expect(s.models).toEqual(['claude-', 'gpt-'])
    expect(s.timeoutMs).toBe(120_000)
    expect(s.maxNestedCalls).toBe(50)
    expect(s.maxOutputChars).toBe(30_000)
    expect(problems).toHaveLength(4)
    expect(resolveCodemodeSettings('coding').settings.mode).toBe('off')
  })

  it('fails closed: any invalid guardrail with an enabled mode switches the whole codemode off and says why', () => {
    const { settings: s, problems } = resolveCodemodeSettings({ mode: 'coding', maxNestedCalls: '1' })
    expect(s.mode).toBe('off')
    expect(problems).toEqual([
      'codemode.maxNestedCalls must be an integer between 1 and 200',
      'codemode switched off: mode "coding" is ignored while any codemode setting is invalid',
    ])
    for (const broken of [
      { maxNestedCalls: 1_000 },
      { maxNestedCalls: 0 },
      { maxConcurrentNestedCalls: 0 },
      { maxConcurrentNestedCalls: 17 },
      { timeoutMs: '120000' },
      { memoryLimitBytes: 1 },
      { maxOutputChars: 1.5 },
      { models: [''] },
    ]) {
      const resolved = resolveCodemodeSettings({ mode: 'readonly', ...broken })
      expect(resolved.settings.mode, JSON.stringify(broken)).toBe('off')
      expect(resolved.problems.at(-1), JSON.stringify(broken)).toContain('codemode switched off')
    }
    // Valid boundary values keep the mode.
    expect(resolveCodemodeSettings({ mode: 'coding', maxNestedCalls: 200, maxConcurrentNestedCalls: 16 })).toMatchObject({
      settings: { mode: 'coding', maxNestedCalls: 200, maxConcurrentNestedCalls: 16 },
      problems: [],
    })
    expect(resolveCodemodeSettings({ mode: 'coding', maxConcurrentNestedCalls: 1 }).settings.maxConcurrentNestedCalls).toBe(1)
  })

  it('registers no tool for a hand-edited settings.json with an invalid guardrail and warns why', () => {
    const file = path.join(tmpDir, 'config', 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ codemode: { mode: 'coding', maxNestedCalls: '1' } }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const loaded = loadCodemodeSettings()
      expect(loaded.mode).toBe('off')
      const tools: AgentTool[] = [fakeTool('read_file'), fakeTool('shell')]
      const result = withCodemodeTool(tools, loaded, 'claude-x', () => fakeAgent())
      expect(result).toBe(tools)
      expect(result.map(t => t.name)).not.toContain('codemode')
      expect(buildCodemodeTool({ tools, settings: loaded, modelId: 'claude-x', getAgent: () => fakeAgent() })).toBeNull()
      const message = warn.mock.calls.map(args => String(args[0])).find(m => m.startsWith('[codemode]'))
      expect(message).toContain('codemode is off until they are fixed')
      expect(message).toContain('codemode.maxNestedCalls must be an integer between 1 and 200')
      expect(message).toContain('mode "coding" is ignored')
    } finally {
      warn.mockRestore()
    }
  })

  it('reads settings.json per call and fails closed on a broken file', () => {
    const file = path.join(tmpDir, 'config', 'settings.json')
    expect(loadCodemodeSettings().mode).toBe('off')
    fs.writeFileSync(file, JSON.stringify({ codemode: { mode: 'readonly', models: ['claude-'] } }))
    expect(loadCodemodeSettings()).toMatchObject({ mode: 'readonly', models: ['claude-'] })
    fs.writeFileSync(file, '{ not json')
    expect(loadCodemodeSettings().mode).toBe('off')
  })

  it('matches models by prefix only when the mode is not off', () => {
    expect(isCodemodeEnabledFor(settings(), 'claude-sonnet-4-5')).toBe(true)
    expect(isCodemodeEnabledFor(settings(), 'gpt-5')).toBe(true)
    expect(isCodemodeEnabledFor(settings(), 'qwen3-coder')).toBe(false)
    expect(isCodemodeEnabledFor(settings(), undefined)).toBe(false)
    expect(isCodemodeEnabledFor(settings({ mode: 'off' }), 'claude-sonnet-4-5')).toBe(false)
  })
})

describe('codemode allowlists', () => {
  const everything = [
    ...CODEMODE_READONLY_TOOLS, ...CODEMODE_CODING_EXTRA_TOOLS,
    'email_send', 'email_read', 'create_task', 'publish_board', 'send_file_to_user', 'ask_agent', 'generate',
  ].map(name => fakeTool(name))

  it('keeps the never list disjoint from the allowlists', () => {
    for (const name of [...CODEMODE_READONLY_TOOLS, ...CODEMODE_CODING_EXTRA_TOOLS]) {
      expect(CODEMODE_NEVER_TOOLS).not.toContain(name)
    }
    expect(CODEMODE_NEVER_TOOLS).toContain('email_send')
    expect(CODEMODE_NEVER_TOOLS).toContain('codemode')
  })

  it('readonly exposes only read tools, coding adds write_file, edit_file and shell', () => {
    expect([...codemodeAllowedToolNames('readonly')].sort()).toEqual([...CODEMODE_READONLY_TOOLS].sort())
    expect([...codemodeAllowedToolNames('coding')].sort()).toEqual([...CODEMODE_READONLY_TOOLS, 'write_file', 'edit_file', 'shell'].sort())
    expect(codemodeAllowedToolNames('off').size).toBe(0)
  })

  it('exposes no never-tool to the script, not even when it is active in the turn', async () => {
    const { tool } = build(everything, { mode: 'coding' })
    expect(tool.description).not.toMatch(/email_send|create_task|publish_board|send_file_to_user|ask_agent|generate\b|email_read/)
    const { text, details } = await run(tool, 'return { send: "email_send" in tools, read: "email_read" in tools, shell: "shell" in tools, keys: Object.keys(tools).length }')
    expect(details.ok).toBe(true)
    expect(JSON.parse(text.split('\n').pop()!)).toEqual({ send: false, read: false, shell: true, keys: 17 })
  })

  it('readonly hides the coding tools; calling one throws inside the script', async () => {
    const shell = fakeTool('shell')
    const { tool } = build([fakeTool('read_file'), shell], { mode: 'readonly' })
    expect(tool.description).not.toContain('shell')
    const { details, text } = await run(tool, 'return await tools.shell({ command: "id" })')
    expect(details.ok).toBe(false)
    expect(details.errorKind).toBe('script')
    expect(text).toMatch(/tools\.shell does not exist/)
    expect(shell.calls).toHaveLength(0)
  })

  it('only exposes allowlisted tools that are active in the turn', async () => {
    const { tool } = build([fakeTool('read_file')], { mode: 'coding' })
    const { text } = await run(tool, 'return Object.keys(tools)')
    expect(text).toContain('["read_file"]')
  })

  it('registers no tool at all when off, when the model is not allowlisted, or when nothing is callable', () => {
    const tools = [fakeTool('read_file'), fakeTool('shell')]
    const getAgent = () => fakeAgent()
    expect(buildCodemodeTool({ tools, settings: settings({ mode: 'off' }), modelId: 'claude-x', getAgent })).toBeNull()
    expect(buildCodemodeTool({ tools, settings: settings(), modelId: 'llama-3', getAgent })).toBeNull()
    expect(buildCodemodeTool({ tools: [fakeTool('email_send')], settings: settings(), modelId: 'claude-x', getAgent })).toBeNull()
    // Off: the exact same array comes back (zero behaviour change).
    expect(withCodemodeTool(tools, settings({ mode: 'off' }), 'claude-x', getAgent)).toBe(tools)
    expect(withCodemodeTool(tools, settings(), 'mistral-large', getAgent)).toBe(tools)
    const on = withCodemodeTool(tools, settings(), 'claude-x', getAgent)
    expect(on.map(t => t.name)).toEqual(['read_file', 'shell', 'codemode'])
    // Re-applying never nests or duplicates codemode.
    expect(withCodemodeTool(on, settings(), 'claude-x', getAgent).map(t => t.name)).toEqual(['read_file', 'shell', 'codemode'])
    expect(withCodemodeTool(on, settings({ mode: 'off' }), 'claude-x', getAgent).map(t => t.name)).toEqual(['read_file', 'shell'])
  })
})

describe('codemode execution', () => {
  it('chains calls: the result of one feeds the next', async () => {
    const list = fakeTool('list_files', () => 'a.txt\nb.txt')
    const read = fakeTool('read_file', args => `content of ${String(args.path)}`)
    const { tool } = build([list, read])
    const { text, details } = await run(tool, `
      const names = (await tools.list_files({ path: "/w" })).split("\\n")
      const first = await tools.read_file({ path: "/w/" + names[0] })
      return first
    `)
    expect(details.ok).toBe(true)
    expect(text).toContain('content of /w/a.txt')
    expect(read.calls[0].args).toEqual({ path: '/w/a.txt' })
    expect(details.calls.map(c => c.name)).toEqual(['list_files', 'read_file'])
    expect(details.complete).toBe(true)
  })

  it('runs calls in parallel with Promise.all, up to maxConcurrentNestedCalls at once', async () => {
    let inFlight = 0
    let peak = 0
    const read = fakeTool('read_file', async args => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 40))
      inFlight--
      return `r:${String(args.path)}`
    })
    const { tool } = build([read], { maxConcurrentNestedCalls: 3 })
    const { text, details } = await run(tool, `
      const all = await Promise.all(["1", "2", "3", "4", "5", "6"].map(p => tools.read_file({ path: p })))
      return all.join(",")
    `)
    expect(details.ok).toBe(true)
    expect(text).toContain('r:1,r:2,r:3,r:4,r:5,r:6')
    expect(read.calls).toHaveLength(6)
    // Really parallel (the limit is reached), but never above it.
    expect(peak).toBe(3)
    expect(inFlight).toBe(0)
  })

  it('bounds a Promise.all over 50 nested calls to the default concurrency limit; all 50 complete', async () => {
    let inFlight = 0
    let peak = 0
    const shell = fakeTool('shell', async args => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 10))
      inFlight--
      return `done:${String(args.command)}`
    })
    const { tool } = build([shell])
    expect(DEFAULT_CODEMODE_SETTINGS.maxConcurrentNestedCalls).toBe(4)
    const { text, details } = await run(tool, `
      const all = await Promise.all(Array.from({ length: 50 }, (_, i) => tools.shell({ command: "synthetic-" + i })))
      return all.length + ":" + all[0] + ":" + all[49]
    `)
    expect(details.ok).toBe(true)
    expect(text).toContain('50:done:synthetic-0:done:synthetic-49')
    expect(shell.calls).toHaveLength(50)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBe(4)
    expect(details.calls.every(c => c.ok)).toBe(true)
    expect(text.split('\n')[0]).toMatch(/^codemode: 50 calls \(shell×50\)/)
  })

  it('starts no queued call after an abort, even when a nested tool ignores the abort and frees its slot later', async () => {
    let started = 0
    const shell = fakeTool('shell', async () => {
      started++
      // Deliberately ignores the abort signal; frees its slot after 600 ms.
      await new Promise(resolve => setTimeout(resolve, 600))
      return 'late'
    })
    const { tool } = build([shell], { maxConcurrentNestedCalls: 2 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const { details, result } = await run(tool, `
      await Promise.all(Array.from({ length: 10 }, (_, i) => tools.shell({ command: String(i) })))
    `, controller.signal)
    expect(result.isError).toBe(true)
    expect(details.errorKind).toBe('aborted')
    expect(started).toBe(2)
    // Wait until the two running calls have released their slots.
    await new Promise(resolve => setTimeout(resolve, 900))
    expect(started).toBe(2)
    expect(shell.calls).toHaveLength(2)
  })

  it('rejects queued calls cleanly when the script times out', async () => {
    let started = 0
    const shell = fakeTool('shell', async () => {
      started++
      await new Promise(resolve => setTimeout(resolve, 1_200))
      return 'slow'
    })
    const { tool } = build([shell], { maxConcurrentNestedCalls: 1, timeoutMs: 400 })
    const startedAt = Date.now()
    const { details, result } = await run(tool, `
      await Promise.all([tools.shell({ command: "a" }), tools.shell({ command: "b" }), tools.shell({ command: "c" })])
    `)
    expect(result.isError).toBe(true)
    expect(details.errorKind).toBe('timeout')
    expect(Date.now() - startedAt).toBeLessThan(1_100)
    await new Promise(resolve => setTimeout(resolve, 1_400))
    expect(started).toBe(1)
  })

  it('the concurrency limiter is FIFO, hands slots over and removes aborted waiters', async () => {
    const limiter = createCodemodeConcurrencyLimiter(2)
    const r1 = await limiter.acquire([])
    const r2 = await limiter.acquire([])
    expect(limiter.active).toBe(2)
    const order: string[] = []
    const aborted = new AbortController()
    const p3 = limiter.acquire([]).then(release => { order.push('3'); return release })
    const p4 = limiter.acquire([aborted.signal]).then(() => order.push('4'), (err: Error) => { order.push(`4:${err.name}`) })
    const p5 = limiter.acquire([undefined]).then(release => { order.push('5'); return release })
    expect(limiter.queued).toBe(3)
    aborted.abort()
    await p4
    expect(limiter.queued).toBe(2)
    r1()
    r1() // idempotent: does not free a second slot
    const r3 = await p3
    expect(limiter.active).toBe(2)
    expect(limiter.queued).toBe(1)
    r2()
    const r5 = await p5
    expect(order).toEqual(['4:AbortError', '3', '5'])
    r3()
    r5()
    expect(limiter.active).toBe(0)
    await expect(limiter.acquire([AbortSignal.abort()])).rejects.toThrow(/cancelled before it started/)
    expect(limiter.active).toBe(0)
    expect(() => createCodemodeConcurrencyLimiter(0)).toThrow()
  })

  it('returns text() output, console output and the return value, plus a summary line', async () => {
    const { tool } = build([fakeTool('read_file')])
    const { text, details, result } = await run(tool, 'text("hello"); console.log("from console"); await tools.read_file({ path: "x" }); return { n: 1 }')
    expect(result.isError).toBe(false)
    const [summary] = text.split('\n')
    expect(summary).toMatch(/^codemode: 1 call \(read_file×1\), \d+\.\d s$/)
    expect(text).toContain('hello')
    expect(text).toContain('from console')
    expect(text).toContain('{"n":1}')
    expect(details.calls).toHaveLength(1)
    expect(details.calls[0]).toMatchObject({ name: 'read_file', args: '{"path":"x"}', ok: true })
    expect(typeof details.calls[0].durationMs).toBe('number')
  })

  it('a nested tool error propagates as a script error and is logged', async () => {
    const { tool } = build([failingTool('read_file', 'synthetic: file not found')])
    const { text, details, result } = await run(tool, 'await tools.read_file({ path: "nope" }); return "unreachable"')
    expect(result.isError).toBe(true)
    expect(details.ok).toBe(false)
    expect(details.errorKind).toBe('script')
    expect(text).toContain('synthetic: file not found')
    expect(text).not.toContain('unreachable')
    expect(details.calls[0]).toMatchObject({ name: 'read_file', ok: false })
    expect(details.calls[0].error).toContain('synthetic: file not found')
  })

  it('a script can catch a tool error and continue', async () => {
    const { tool } = build([failingTool('read_file', 'boom')])
    const { text, details } = await run(tool, 'try { await tools.read_file({}) } catch (e) { return "caught " + e.message }')
    expect(details.ok).toBe(true)
    expect(text).toContain('caught')
    expect(text).toContain('boom')
  })

  it('times out a spinning script', async () => {
    const { tool } = build([fakeTool('read_file')], { timeoutMs: 1_000 })
    const started = Date.now()
    const { details, result, text } = await run(tool, 'while (true) {}')
    expect(result.isError).toBe(true)
    expect(details.errorKind).toBe('timeout')
    expect(text).toContain('failed: timeout')
    expect(Date.now() - started).toBeLessThan(8_000)
  })

  it('enforces the memory limit', async () => {
    const { tool } = build([fakeTool('read_file')], { memoryLimitBytes: 4 * 1024 * 1024 })
    const { details, result } = await run(tool, 'const a = []; for (let i = 0; i < 1e7; i++) a.push("x".repeat(64) + i); return a.length')
    expect(result.isError).toBe(true)
    expect(details.ok).toBe(false)
    expect(['script', 'sandbox']).toContain(details.errorKind)
  })

  it('caps nested calls per script at maxNestedCalls', async () => {
    const read = fakeTool('read_file')
    const { tool } = build([read], { maxNestedCalls: 3 })
    const { text, details } = await run(tool, 'for (let i = 0; i < 10; i++) await tools.read_file({ path: String(i) })')
    expect(details.ok).toBe(false)
    expect(text).toContain('limit of 3 tool calls per script')
    expect(read.calls).toHaveLength(3)
    expect(text.split('\n')[0]).toMatch(/^codemode: 4 calls/)
  })

  it('propagates an abort to the sandbox and to a running nested tool', async () => {
    let toolSignal: AbortSignal | undefined
    const slow = fakeTool('web_fetch', async (_args, signal) => {
      toolSignal = signal
      await new Promise(resolve => setTimeout(resolve, 5_000))
      return 'late'
    })
    const { tool } = build([slow])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const started = Date.now()
    const { details, result } = await run(tool, 'return await tools.web_fetch({ q: "x" })', controller.signal)
    expect(result.isError).toBe(true)
    expect(details.errorKind).toBe('aborted')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(toolSignal?.aborted).toBe(true)
  })

  it('logs at most 100 calls, truncates args to 2 KB and flags an incomplete log', async () => {
    const read = fakeTool('read_file', () => 'ok')
    const { tool } = build([read], { maxNestedCalls: 150 })
    const { details } = await run(tool, `
      await tools.read_file({ path: "y".repeat(5000) })
      for (let i = 0; i < 119; i++) await tools.read_file({ path: String(i) })
    `)
    expect(details.ok).toBe(true)
    expect(read.calls).toHaveLength(120)
    expect(details.calls).toHaveLength(100)
    expect(details.complete).toBe(false)
    expect(details.calls[0].args.length).toBeLessThan(2_100)
    expect(details.calls[0].args).toContain('more chars')
  })

  it('discards image() output: no image block, a text note instead, text within the inline cap', async () => {
    const { tool } = build([fakeTool('read_file')], { maxOutputChars: 1_000 })
    // Synthetic malformed PNG-prefix payload of 1.6 M base64 chars.
    const { result, text, details } = await run(tool, `
      image({ type: "image", data: "iVBORw0KGgoA" + "AAAA".repeat(400000), mimeType: "image/png" })
      text("after image")
      return "done"
    `)
    expect(details.ok).toBe(true)
    expect(result.content.every(block => block.type === 'text')).toBe(true)
    expect(result.content).toHaveLength(1)
    expect(text).toContain(CODEMODE_IMAGE_DISCARDED_NOTE)
    expect(text).toContain('after image')
    expect(text).toContain('done')
    expect(text).not.toContain('iVBORw0KGgo')
    expect(text.length).toBeLessThan(1_000 + 200)
    expect(details.discardedImages).toBe(1)
    expect(details.spilledTo).toBeUndefined()
    expect(JSON.stringify(result).length).toBeLessThan(10_000)
  })

  it('caps the inline output and spills the rest via the spill mechanism', async () => {
    const { tool } = build([fakeTool('read_file')], { maxOutputChars: 1_000 })
    const { text, details } = await run(tool, 'return "z".repeat(50000)')
    expect(details.ok).toBe(true)
    expect(text.length).toBeLessThan(5_000)
    expect(details.spilledTo).toBeTruthy()
    expect(details.spilledTo!.startsWith(tmpDir)).toBe(true)
    expect(text).toContain('output truncated')
    expect(fs.readFileSync(details.spilledTo!, 'utf-8')).toContain('z'.repeat(50000))
  })

  it('runs nested calls through beforeToolCall/afterToolCall with ids derived from the parent call', async () => {
    const read = fakeTool('read_file')
    const { tool, agent } = build([read])
    await run(tool, 'await tools.read_file({ path: "a" }); await tools.read_file({ path: "b" })', undefined, 'parent-42')
    expect(agent.log.before).toEqual(['parent-42/cm-1', 'parent-42/cm-2'])
    expect(agent.log.after).toEqual(['parent-42/cm-1', 'parent-42/cm-2'])
    expect(read.calls.map(c => c.id)).toEqual(['parent-42/cm-1', 'parent-42/cm-2'])
    expect(isNestedCodemodeCallId('parent-42/cm-2')).toBe(true)
    expect(isNestedCodemodeCallId('parent-42')).toBe(false)
    expect(isNestedCodemodeCallId(nestedCodemodeCallId('toolu_01', 7))).toBe(true)
  })

  it('a block from beforeToolCall surfaces as a tool error in the script', async () => {
    const read = fakeTool('read_file')
    const agent = fakeAgent({ beforeToolCall: async () => ({ block: true, reason: 'synthetic guard says no' }) })
    const { tool } = build([read], {}, agent)
    const { text, details } = await run(tool, 'await tools.read_file({ path: "a" })')
    expect(details.ok).toBe(false)
    expect(text).toContain('synthetic guard says no')
    expect(read.calls).toHaveLength(0)
  })
})

describe('codemode secret boundary', () => {
  it('a registered secret returned by a wrapped nested tool never appears in plaintext (text() and return)', async () => {
    setSecret('DEMO_CODEMODE_TOKEN', SYNTHETIC_SECRET)
    invalidateKnownValues()
    const raw = fakeTool('read_file', () => `token=${SYNTHETIC_SECRET}`)
    const wrapped = withSecretBoundary([raw as AgentTool])
    const agent = fakeAgent()
    const tool = buildCodemodeTool({ tools: wrapped, settings: settings(), modelId: 'claude-test', getAgent: () => agent })!
    expect(tool).not.toBeNull()
    const { text, details } = await run(tool, 'const v = await tools.read_file({ path: "/cfg" }); text(v); return v')
    expect(details.ok).toBe(true)
    expect(text).not.toContain(SYNTHETIC_SECRET)
    expect(text).toContain(REDACTED_HANDLE)
    expect(JSON.stringify(details)).not.toContain(SYNTHETIC_SECRET)
    // The nested call ran through the wrapped tool instance (the raw one saw the call).
    expect(raw.calls).toHaveLength(1)
    expect(agent.log.before).toEqual(['call-1/cm-1'])
  })

  it('seals the codemode output itself even if a nested tool leaked plaintext (defence in depth)', async () => {
    setSecret('DEMO_CODEMODE_TOKEN', SYNTHETIC_SECRET)
    invalidateKnownValues()
    // Deliberately UNwrapped nested tool: the codemode tool's own seal must catch it.
    const leaky = fakeTool('read_file', () => SYNTHETIC_SECRET)
    const agent = fakeAgent()
    const tool = buildCodemodeTool({ tools: [leaky], settings: settings(), modelId: 'claude-test', getAgent: () => agent })!
    const viaText = await run(tool, 'text(await tools.read_file({}))')
    expect(viaText.text).not.toContain(SYNTHETIC_SECRET)
    const viaReturn = await run(tool, 'const v = await tools.read_file({}); return { v, parts: [v] }')
    expect(viaReturn.text).not.toContain(SYNTHETIC_SECRET)
    const viaError = await run(tool, 'throw new Error(await tools.read_file({}))')
    expect(viaError.text).not.toContain(SYNTHETIC_SECRET)
    // Args echoed back from the script are sealed in the log too.
    const viaArgs = await run(tool, 'await tools.read_file({ path: await tools.read_file({}) })')
    expect(JSON.stringify(viaArgs.details)).not.toContain(SYNTHETIC_SECRET)
  })
})

describe('codemode description determinism', () => {
  it('is identical for shuffled tool input and only changes with the allowlist', () => {
    const names = ['web_fetch', 'read_file', 'shell', 'list_files', 'search_memories', 'write_file', 'edit_file']
    const make = (order: string[], mode: CodemodeSettings['mode'] = 'coding') =>
      createCodemodeTool({ tools: order.map(n => fakeTool(n)), settings: settings({ mode }), createRunner: () => async () => { throw new Error('unused') } })!.description
    const a = make(names)
    const b = make([...names].reverse())
    const c = make([names[3], names[0], names[5], names[1], names[6], names[2], names[4]])
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(make(names, 'readonly')).not.toBe(a)
    const idx = (n: string) => a.indexOf(`${n}(`)
    expect(idx('edit_file')).toBeLessThan(idx('list_files'))
    expect(idx('list_files')).toBeLessThan(idx('write_file'))
  })

  it('formats the summary line', () => {
    expect(formatCodemodeSummary([{ name: 'shell' }, { name: 'read_file' }, { name: 'read_file' }], 3, 1234))
      .toBe('codemode: 3 calls (read_file×2, shell×1), 1.2 s')
    expect(formatCodemodeSummary([], 0, 40)).toBe('codemode: 0 calls, 0.0 s')
  })
})
