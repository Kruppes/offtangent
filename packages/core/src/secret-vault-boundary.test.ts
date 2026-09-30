/**
 * End-to-end: a `shell` call that runs a password-manager CLI, through the
 * REAL wiring of both agent paths (maintainer request, privacy plan 2026-09-26).
 *
 * - chat path: `createAgentRuntime` → `withSecretBoundary([...tools])`
 * - task path: `TaskRunner.startTask` → `withSecretBoundary(options.tools)`
 *
 * The CLI itself is a synthetic stub script written into a temp directory and
 * put on `PATH`; no test talks to a real vault. Every canary value is built at
 * runtime, so the repo contains no credential-looking literal.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const captured = vi.hoisted(() => ({ tools: [] as AgentTool[] }))

vi.mock('@earendil-works/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt?: string; model?: unknown; tools: AgentTool[]; messages: unknown[] }
    private listener: ((event: unknown) => void) | null = null
    constructor(options: { initialState: { systemPrompt?: string; model?: unknown; tools: AgentTool[] } }) {
      this.state = { ...options.initialState, messages: [] }
      captured.tools = options.initialState.tools
    }
    subscribe(fn: (event: unknown) => void): () => void {
      this.listener = fn
      return () => { this.listener = null }
    }
    async prompt(): Promise<void> {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'STATUS: completed\nSUMMARY: done' }],
        provider: 'test-provider',
        model: 'test-model',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      }
      this.listener?.({ type: 'message_end', message })
      this.listener?.({ type: 'agent_end', messages: [] })
      this.state.messages.push(message)
    }
    async continue(): Promise<void> {}
    abort(): void {}
  }
  return { Agent: MockAgent }
})

const { createAgentRuntime, createBaseAgentTools } = await import('./agent-runtime.js')
const { TaskRunner } = await import('./task-runner.js')
const { TaskStore } = await import('./task-store.js')
const { SessionManager } = await import('./session-manager.js')
const { initDatabase } = await import('./database.js')
const { invalidateSecretHandleCache, listSecrets, resolveSecret } = await import('./secret-store.js')
const { invalidateKnownValues, secretHandle } = await import('./secret-boundary.js')
const { VAULT_EXPORT_NOTICE, VAULT_OPAQUE_HANDLE } = await import('./secret-vault-cli.js')

const canary = (label: string): string => ['Vw', label, 'e2e', 'Qx'].join('-')
const PASSWORD = canary('E2EPASSWORD')
const PASSWORD_SHA = crypto.createHash('sha256').update(PASSWORD).digest('hex')
const SESSION = canary('E2ESESSION')
const NOTES = canary('E2ENOTES')

const ITEM = {
  object: 'item',
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  type: 1,
  name: 'Router',
  notes: NOTES,
  login: { username: 'admin', password: PASSWORD, totp: null, uris: [{ uri: 'https://router.example.invalid' }] },
  fields: [],
}

let tmpDir: string
let workspaceDir: string
let binDir: string
let previous: Record<string, string | undefined> = {}

function makeModel(): Record<string, unknown> {
  return {
    id: 'gpt-4o', name: 'GPT-4o', api: 'openai-completions', provider: 'openai',
    baseUrl: 'https://api.openai.com/v1', reasoning: false, input: ['text'],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  }
}

/** Synthetic CLI stub: prints the fixture that matches the requested command. */
function writeStub(): void {
  const script = `#!/bin/sh
case "$1 $2" in
  "get item")    printf '%s' '${JSON.stringify(ITEM)}' ;;
  "get password") printf '%s\\n' '${PASSWORD}' ;;
  "export --format") printf 'folder,name,login_password\\n,Router,${PASSWORD}\\n' ;;
  *)
    case "$*" in
      *--raw*) printf '%s\\n' '${SESSION}' ;;
      *) printf 'Syncing complete.\\n' ;;
    esac ;;
esac
`
  const file = path.join(binDir, 'bw')
  fs.writeFileSync(file, script)
  fs.chmodSync(file, 0o755)
}

function tool(name: string): AgentTool {
  const found = captured.tools.find(entry => entry.name === name)
  if (!found) throw new Error(`tool ${name} missing; got ${captured.tools.map(t => t.name).join(', ')}`)
  return found
}

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

const withPath = (command: string): string => `export PATH="${binDir}:$PATH"; ${command}`

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-boundary-'))
  workspaceDir = path.join(tmpDir, 'workspace')
  binDir = path.join(tmpDir, 'bin')
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  writeStub()
  previous = {
    DATA_DIR: process.env.DATA_DIR,
    WORKSPACE_DIR: process.env.WORKSPACE_DIR,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  }
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = workspaceDir
  process.env.ENCRYPTION_KEY = 'test-key-for-vault-boundary-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  captured.tools = []
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

function bootChat(): void {
  const db = initDatabase(':memory:')
  createAgentRuntime({
    model: makeModel() as never,
    apiKey: 'sk-not-a-real-key',
    db,
    tools: [],
    memoryDir: path.join(tmpDir, 'memory'),
  })
}

async function bootTask(): Promise<void> {
  const db = initDatabase(':memory:')
  const sessionManager = new SessionManager({ db })
  const store = new TaskStore(db)
  // The task runner wraps exactly `options.tools`; hand it the real, unwrapped
  // base tool set (same factory the chat path feeds into withSecretBoundary).
  const baseTools = createBaseAgentTools({ db, builtinToolsConfig: () => ({}) as never })
  const runner = new TaskRunner({
    db,
    buildModel: () => ({}) as never,
    getApiKey: async () => 'test-key',
    tools: baseTools as never,
    onTaskComplete: () => {},
    sessionManager,
  } as never)
  const task = store.create({ name: 'Vault Task', prompt: 'read a secret', triggerType: 'agent' })
  captured.tools = []
  await runner.startTask(task, {
    id: 'test-provider-id', name: 'test-provider', type: 'openai', providerType: 'openai', provider: 'openai',
    baseUrl: 'http://localhost:1234', apiKey: 'test-key', enabledModels: ['test-model'], models: [],
    status: 'connected', authMethod: 'api-key',
  } as never)
  await new Promise(resolve => setTimeout(resolve, 150))
  runner.dispose()
}

describe('chat path: shell + password-manager CLI', () => {
  it('seals the JSON item and keeps the metadata', async () => {
    bootChat()
    const output = await run('shell', { command: withPath('bw get item aaaa --session X') })
    expect(output).not.toContain(PASSWORD)
    expect(output).not.toContain(NOTES)
    expect(output).toContain('Router')
    expect(output).toContain('https://router.example.invalid')
    expect(output).toContain(secretHandle('vw-router-login-password'))
    expect(resolveSecret('vw-router-login-password')).toBe(PASSWORD)
  })

  it('resolves the sealed handle again in a later shell command', async () => {
    bootChat()
    await run('shell', { command: withPath('bw get item aaaa') })
    // The follow-up command hashes what it receives: if the handle had not
    // been resolved, the digest would be the digest of the handle string.
    const output = await run('shell', {
      command: `printf '%s' '${secretHandle('vw-router-login-password')}' | sha256sum`,
    })
    expect(output).toContain(PASSWORD_SHA)
    expect(output).not.toContain(PASSWORD)
  })

  it('seals a raw password read and redacts the same value in a later echo', async () => {
    bootChat()
    const first = await run('shell', { command: withPath('bw get password aaaa') })
    expect(first).not.toContain(PASSWORD)
    expect(first).toContain('{{secret:vw-password}}')
    // Known value from now on, even without the CLI in the command.
    const echoed = await run('shell', { command: `printf '%s' '${secretHandle('vw-password')}'` })
    expect(echoed).not.toContain(PASSWORD)
    expect(echoed).toContain('{{secret:')
  })

  it('seals a --raw session key', async () => {
    bootChat()
    const output = await run('shell', { command: withPath('bw unlock --raw') })
    expect(output).not.toContain(SESSION)
    expect(output).toContain('{{secret:vw-session}}')
    expect(resolveSecret('vw-session')).toBe(SESSION)
  })

  it('drops an export entirely', async () => {
    bootChat()
    const output = await run('shell', { command: withPath('bw export --format csv') })
    expect(output).not.toContain(PASSWORD)
    expect(output).toContain(VAULT_EXPORT_NOTICE)
  })

  it('fails closed when the output is piped through another tool', async () => {
    bootChat()
    const output = await run('shell', { command: withPath('bw get item aaaa | sed "s/.*password...//"') })
    expect(output).not.toContain(PASSWORD)
    expect(output).toContain(VAULT_OPAQUE_HANDLE)
  })

  it('leaves a command without the CLI untouched', async () => {
    bootChat()
    fs.writeFileSync(path.join(workspaceDir, 'bw-notes'), 'harmless note\n')
    const output = await run('shell', { command: `ls ${workspaceDir} && echo bw` })
    expect(output).toContain('bw-notes')
    expect(output).toContain('bw')
    expect(output).not.toContain(VAULT_OPAQUE_HANDLE)
  })

  it('redacts a value from a secrets file in a cat output', async () => {
    const fileSecret = canary('E2EFILEVALUE')
    fs.mkdirSync(path.join(tmpDir, 'secrets'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'secrets', 'vaultwarden.env'), `BW_PASSWORD=${fileSecret}\n`)
    invalidateKnownValues()
    bootChat()
    const output = await run('shell', { command: `cat ${path.join(tmpDir, 'secrets', 'vaultwarden.env')}` })
    expect(output).not.toContain(fileSecret)
    expect(output).toContain(VAULT_OPAQUE_HANDLE)
  })
})

describe('task path: the task runner wraps the same way', () => {
  it('seals CLI output for the task agent too', async () => {
    await bootTask()
    const output = await run('shell', { command: withPath('bw get item aaaa') })
    expect(output).not.toContain(PASSWORD)
    expect(output).not.toContain(NOTES)
    expect(output).toContain('{{secret:vw-router-login-password}}')
  })

  it('resolves a handle for the task agent as well', async () => {
    await bootTask()
    await run('shell', { command: withPath('bw get item aaaa') })
    const output = await run('shell', {
      command: `printf '%s' '${secretHandle('vw-router-login-password')}' | sha256sum`,
    })
    expect(output).toContain(PASSWORD_SHA)
    expect(output).not.toContain(PASSWORD)
  })

  it('stores the value under kind/source vaultwarden', async () => {
    await bootTask()
    await run('shell', { command: withPath('bw get item aaaa') })
    const entry = listSecrets().find(item => item.slug === 'vw-router-login-password')
    expect(entry).toBeTruthy()
    expect(entry!.kind).toBe('vaultwarden')
    expect(entry!.source).toBe('vaultwarden')
  })
})
