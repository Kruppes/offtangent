/**
 * V4 of the privacy plan (2026-09-26): end-to-end over the REAL runtime
 * wiring, not over a hand-built tool list.
 *
 * The test boots an AgentRuntime (pi-agent replaced by a capture double, every
 * tool module real) and takes the tool list the runtime actually handed to the
 * agent. That list is the product of `withSecretBoundary([...options.tools,
 * ...createBaseAgentTools(...)])`, so what is asserted here is the shipped
 * wiring:
 *
 * - `shell` resolves `{{secret:<slug>}}` in its arguments, so the command runs
 *   with the real value (proven by the sha256 the command itself computes),
 * - what comes back is sealed again: neither the result nor the row that would
 *   be logged to `tool_calls` contains the value,
 * - `env` never returns a known value,
 * - an unknown slug is a tool error, not a silent empty string,
 * - every other tool keeps handles unresolved (D5).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const captured = vi.hoisted(() => ({ tools: [] as AgentTool[], transformContext: null as null | ((messages: unknown[]) => Promise<unknown[]>) }))

vi.mock('@earendil-works/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[] }
    constructor(options: {
      initialState: { systemPrompt: string; model: unknown; tools: AgentTool[] }
      transformContext?: (messages: unknown[]) => Promise<unknown[]>
    }) {
      this.state = { ...options.initialState, messages: [] }
      captured.tools = options.initialState.tools
      captured.transformContext = options.transformContext ?? null
    }
    subscribe(): () => void { return () => {} }
    async prompt(): Promise<void> {}
    async continue(): Promise<void> {}
    abort(): void {}
  }
  return { Agent: MockAgent }
})

const { createAgentRuntime } = await import('./agent-runtime.js')
const { initDatabase } = await import('./database.js')
const { sealSecret, invalidateSecretHandleCache } = await import('./secret-store.js')
const { invalidateKnownValues, secretHandle, redactKnown } = await import('./secret-boundary.js')

/** Assembled at runtime so no file in the repo holds a token-shaped literal. */
const CANARY = ['ghp', '_', 'RuntimeCanary', '00000', 'abcdefghijklmno', 'pq'].join('')
const CANARY_SHA = crypto.createHash('sha256').update(CANARY).digest('hex')

let tmpDir: string
let workspaceDir: string
let previous: Record<string, string | undefined> = {}

function makeModel() {
  return {
    id: 'gpt-4o', name: 'GPT-4o', api: 'openai-completions' as const, provider: 'openai',
    baseUrl: 'https://api.openai.com/v1', reasoning: false,
    input: ['text' as const], cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096,
  }
}

function tool(name: string): AgentTool {
  const found = captured.tools.find(entry => entry.name === name)
  if (!found) throw new Error(`tool ${name} missing; got ${captured.tools.map(t => t.name).join(', ')}`)
  return found
}

/**
 * Execute a tool the way the agent does (`execute(toolCallId, params)`) and
 * flatten the result — or the error message — into one string.
 */
async function run(name: string, args: Record<string, unknown>): Promise<string> {
  const execute = tool(name).execute as (
    id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown,
  ) => Promise<{ content?: Array<{ type: string; text?: string }> }>
  try {
    const result = await execute('call-1', args)
    return (result?.content ?? []).map(part => part.text ?? '').join('\n')
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-runtime-'))
  workspaceDir = path.join(tmpDir, 'workspace')
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  previous = {
    DATA_DIR: process.env.DATA_DIR,
    WORKSPACE_DIR: process.env.WORKSPACE_DIR,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.ENCRYPTION_KEY = 'test-key-for-runtime-boundary-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  captured.tools = []
  captured.transformContext = null
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

function boot(extra: AgentTool[] = []): void {
  const db = initDatabase(':memory:')
  createAgentRuntime({
    model: makeModel(),
    apiKey: 'sk-primary-not-a-real-key',
    db,
    tools: extra,
    memoryDir: path.join(tmpDir, 'memory'),
  })
}

describe('V4 runtime wiring: shell resolves handles, everything else does not', () => {
  it('runs the command with the real value but returns only the handle', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    boot()

    // The command hashes the value it was given. If the handle had not been
    // resolved, the digest would be the digest of the literal handle string.
    const output = await run('shell', { command: `printf '%s' '${secretHandle(slug)}' | sha256sum` })
    expect(output).toContain(CANARY_SHA)
    expect(output).not.toContain(CANARY)

    // And the argument that would be persisted to tool_calls: the runtime logs
    // what the wrapped tool reports, so re-seal the arguments the same way.
    expect(redactKnown(`printf '%s' '${CANARY}' | sha256sum`)).toBe(`printf '%s' '${secretHandle(slug)}' | sha256sum`)
  })

  it('seals a known value that a command prints back', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    boot()
    const output = await run('shell', { command: `printf '%s' '${secretHandle(slug)}'` })
    expect(output).not.toContain(CANARY)
    expect(output).toContain(secretHandle(slug))
  })

  it('does not leak a known value through env', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    boot()
    const output = await run('shell', { command: `CANARY_FOR_TEST='${secretHandle(slug)}' env` })
    expect(output).not.toContain(CANARY)
    expect(output).toContain(secretHandle(slug))
  })

  it('fails loudly on an unknown slug instead of passing it through', async () => {
    boot()
    const output = await run('shell', { command: 'echo {{secret:does-not-exist}}' })
    expect(output.toLowerCase()).toContain('unknown secret handle')
    expect(output).toContain('does-not-exist')
  })

  it('leaves handles unresolved in every other tool (D5)', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    boot()
    const target = path.join(workspaceDir, 'note.txt')
    await run('write_file', { path: target, content: `token: ${secretHandle(slug)}` })
    expect(fs.readFileSync(target, 'utf-8')).toBe(`token: ${secretHandle(slug)}`)
    expect(fs.readFileSync(target, 'utf-8')).not.toContain(CANARY)

    const read = await run('read_file', { path: target })
    expect(read).not.toContain(CANARY)
    expect(read).toContain(secretHandle(slug))
  })

  it('seals what an exclusive tool of the caller returns', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    const leaky = {
      name: 'leaky_tool',
      description: 'returns a secret',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: `here you go: ${CANARY}` }] }),
    } as unknown as AgentTool
    boot([leaky])
    const output = await run('leaky_tool', {})
    expect(output).not.toContain(CANARY)
    expect(output).toContain(secretHandle(slug))
  })

  it('seals a fresh secret a tool discovers for the first time', async () => {
    const fresh = ['ghp', '_', 'FreshFromTool', '11111', 'abcdefghijklm', 'no'].join('')
    boot()
    const file = path.join(workspaceDir, 'found.txt')
    fs.writeFileSync(file, `GITHUB_TOKEN=${fresh}\n`)
    const output = await run('read_file', { path: file })
    expect(output).not.toContain(fresh)
    expect(output).toMatch(/\{\{secret:github-token-\d+\}\}/)
  })

  it('redacts every text part of the outgoing context (step 4)', async () => {
    const slug = sealSecret(CANARY, 'github-token', 'chat')
    boot()
    expect(captured.transformContext).toBeTruthy()
    const messages = [
      { role: 'user', content: [{ type: 'text', text: `use ${CANARY}` }] },
      { role: 'assistant', content: [{ type: 'text', text: `ok, ${CANARY} it is` }] },
    ]
    const out = await captured.transformContext!(messages) as Array<{ content: Array<{ text: string }> }>
    expect(JSON.stringify(out)).not.toContain(CANARY)
    expect(out[0]!.content[0]!.text).toBe(`use ${secretHandle(slug)}`)
    expect(out[1]!.content[0]!.text).toBe(`ok, ${secretHandle(slug)} it is`)
  })
})
