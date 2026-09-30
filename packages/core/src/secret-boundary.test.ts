import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import {
  sealText,
  redactKnown,
  resolveHandles,
  withSecretBoundary,
  secretHandle,
  invalidateKnownValues,
  REDACTED_HANDLE,
} from './secret-boundary.js'
import { sealSecret, invalidateSecretHandleCache, listSecrets } from './secret-store.js'
import { setSecret } from './secrets-config.js'
import { encrypt } from './encryption.js'
import { CORPUS_TOKENS } from './secret-corpus.fixture.js'

let tmpDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-boundary-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-secret-boundary-unit-tests'
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

function writeProviders(apiKey: string): void {
  fs.writeFileSync(
    path.join(tmpDir, 'config', 'providers.json'),
    JSON.stringify({ providers: [{ id: 'p1', name: 'Demo', providerType: 'anthropic', apiKey: encrypt(apiKey), models: [] }] }, null, 2),
  )
}

describe('sealText', () => {
  it('replaces a detected secret with its handle and reports it', () => {
    const result = sealText(`Passwort: Sommer2026!`, { tier: 'user', source: 'chat' })
    expect(result.sealed).toEqual([{ slug: 'password-1', kind: 'password' }])
    expect(result.text).toBe('Passwort: {{secret:password-1}}')
    expect(result.text).not.toContain('Sommer2026')
  })

  it('seals several secrets in one text and dedupes repeated values', () => {
    const text = `GH=${CORPUS_TOKENS.GHP} AWS=${CORPUS_TOKENS.AKIA} GH2=${CORPUS_TOKENS.GHP}`
    const result = sealText(text, { tier: 'strong', source: 'tool:shell' })
    expect(result.text).toBe('GH={{secret:github-token-1}} AWS={{secret:aws-access-key-1}} GH2={{secret:github-token-1}}')
    expect(result.sealed).toEqual([
      { slug: 'github-token-1', kind: 'github-token' },
      { slug: 'aws-access-key-1', kind: 'aws-access-key' },
    ])
    expect(listSecrets()).toHaveLength(2)
  })

  it('does not apply context rules in the strong tier', () => {
    const result = sealText('Passwort: Sommer2026!', { tier: 'strong', source: 'tool:shell' })
    expect(result.sealed).toEqual([])
    expect(result.text).toBe('Passwort: Sommer2026!')
  })

  it('redacts already-known values that the detector does not match', () => {
    const slug = sealSecret('blauer-himmel-2026', 'password', 'form')
    const result = sealText('Der Wert blauer-himmel-2026 steht im Log', { tier: 'strong', source: 'tool:shell' })
    expect(result.text).toBe(`Der Wert ${secretHandle(slug)} steht im Log`)
  })

  it('returns empty input unchanged', () => {
    expect(sealText('', { tier: 'user', source: 'chat' })).toEqual({ text: '', sealed: [] })
  })
})

describe('redactKnown', () => {
  it('replaces a sealed value by its handle', () => {
    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    expect(redactKnown(`token=${CORPUS_TOKENS.GHP} end`)).toBe(`token=${secretHandle(slug)} end`)
  })

  it('replaces secrets.json env values with the opaque handle', () => {
    setSecret('DEMO_DB_PASSWORD', 'db-pass-value-2026')
    expect(redactKnown('psql: db-pass-value-2026 accepted')).toBe(`psql: ${REDACTED_HANDLE} accepted`)
  })

  it('replaces process env values whose NAME looks like a credential', () => {
    process.env.DEMO_SERVICE_TOKEN = 'process-env-token-1234'
    process.env.DEMO_HARMLESS_NAME = 'process-env-token-5678'
    try {
      invalidateKnownValues()
      const out = redactKnown('env dump: process-env-token-1234 and process-env-token-5678')
      expect(out).toBe(`env dump: ${REDACTED_HANDLE} and process-env-token-5678`)
    } finally {
      delete process.env.DEMO_SERVICE_TOKEN
      delete process.env.DEMO_HARMLESS_NAME
      invalidateKnownValues()
    }
  })

  it('ignores short env values (no redaction storm)', () => {
    process.env.DEMO_SHORT_TOKEN = 'abc'
    try {
      invalidateKnownValues()
      expect(redactKnown('the abc in the middle')).toBe('the abc in the middle')
    } finally {
      delete process.env.DEMO_SHORT_TOKEN
      invalidateKnownValues()
    }
  })

  it('replaces provider API keys from providers.json', () => {
    writeProviders(CORPUS_TOKENS.ANT_KEY)
    invalidateKnownValues()
    expect(redactKnown(`key ${CORPUS_TOKENS.ANT_KEY}`)).toBe(`key ${REDACTED_HANDLE}`)
  })

  it('is deterministic and picks up new handles', () => {
    const text = `a ${CORPUS_TOKENS.GLPAT} b`
    expect(redactKnown(text)).toBe(text)
    const slug = sealSecret(CORPUS_TOKENS.GLPAT, 'gitlab-token', 'chat')
    const first = redactKnown(text)
    const second = redactKnown(text)
    expect(first).toBe(`a ${secretHandle(slug)} b`)
    expect(second).toBe(first)
  })

  it('prefers the longest value when one secret contains another', () => {
    const outer = sealSecret('outer-value-inner-value', 'password', 'form')
    sealSecret('inner-value', 'password', 'form')
    expect(redactKnown('x outer-value-inner-value y')).toBe(`x ${secretHandle(outer)} y`)
  })

  it('scans 100 KB of tool-like output in under 5 ms (median)', () => {
    sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    sealSecret(CORPUS_TOKENS.AKIA, 'aws-access-key', 'chat')
    sealSecret(CORPUS_TOKENS.ANT_KEY, 'anthropic-key', 'chat')
    setSecret('DEMO_ENV_ONE', 'env-value-one-2026')
    setSecret('DEMO_ENV_TWO', 'env-value-two-2026')

    const line = 'PASS  src/module-name.test.ts (12 tests) 118ms — commit 1bc70e2df738c3c0604a35953d12ad0925c9953a\n'
    let haystack = ''
    while (haystack.length < 100 * 1024) haystack += line
    haystack = haystack.slice(0, 100 * 1024)

    const timings: number[] = []
    for (let i = 0; i < 25; i++) {
      const start = performance.now()
      redactKnown(haystack)
      timings.push(performance.now() - start)
    }
    timings.sort((a, b) => a - b)
    const median = timings[Math.floor(timings.length / 2)]
    console.log(`[perf] redactKnown on 100 KB (5 known values): median ${median.toFixed(2)} ms`)
    expect(median).toBeLessThan(5)
  })
})

describe('resolveHandles', () => {
  it('resolves a known handle and reports unknown ones', () => {
    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    expect(resolveHandles(`echo ${secretHandle(slug)}`)).toEqual({
      text: `echo ${CORPUS_TOKENS.GHP}`,
      unknown: [],
    })
    const missing = resolveHandles('echo {{secret:nope-1}}')
    expect(missing.unknown).toEqual(['nope-1'])
    expect(missing.text).toBe('echo {{secret:nope-1}}')
  })
})

// --- V4: the tool wrapper ---------------------------------------------------

interface ShellCall { command: string }

function fakeShellTool(calls: ShellCall[]): AgentTool {
  return {
    name: 'shell',
    label: 'Execute Shell Command',
    description: 'fake shell for tests',
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, params) => {
      const { command } = params as { command: string }
      calls.push({ command })
      // `echo <x>` semantics: the command output is the argument.
      const output = command.startsWith('echo ') ? command.slice(5) : command
      return { content: [{ type: 'text' as const, text: output }], details: { exitCode: 0 } }
    },
  }
}

describe('withSecretBoundary — V4', () => {
  it('runs shell with the resolved value but returns and logs only the handle', async () => {
    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])

    const loggedArgs = { command: `echo ${secretHandle(slug)}` }
    const result = await shell.execute('call-1', loggedArgs)

    // executed with the real value
    expect(calls[0].command).toBe(`echo ${CORPUS_TOKENS.GHP}`)
    // returned to the model: handle only
    const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toBe(secretHandle(slug))
    expect(text).not.toContain(CORPUS_TOKENS.GHP)
    // the arguments object the runtime logs is untouched
    expect(loggedArgs.command).toBe(`echo ${secretHandle(slug)}`)
  })

  it('fails the call on an unknown slug instead of running it', async () => {
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])
    await expect(shell.execute('call-2', { command: 'echo {{secret:unknown-9}}' }))
      .rejects.toThrow(/Unknown secret handle\(s\): \{\{secret:unknown-9\}\}/)
    expect(calls).toHaveLength(0)
  })

  it('redacts a known env value that a tool prints', async () => {
    setSecret('DEMO_DEPLOY_TOKEN', 'deploy-token-value-2026')
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])
    const result = await shell.execute('call-3', { command: 'echo DEMO_DEPLOY_TOKEN=deploy-token-value-2026' })
    const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toBe(`DEMO_DEPLOY_TOKEN=${REDACTED_HANDLE}`)
  })

  it('seals a fresh secret found in a tool result (strong tier)', async () => {
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])
    const result = await shell.execute('call-4', { command: `echo AWS=${CORPUS_TOKENS.AKIA}` })
    const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toBe('AWS={{secret:aws-access-key-1}}')
    expect(listSecrets()[0]).toMatchObject({ kind: 'aws-access-key', source: 'tool:shell' })
  })

  it('does not apply context rules to tool output', async () => {
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])
    const result = await shell.execute('call-5', { command: 'echo password: Sommer2026!' })
    const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
    expect(text).toBe('password: Sommer2026!')
  })

  it('seals the error text of any tool', async () => {
    setSecret('DEMO_FAIL_TOKEN', 'fail-token-value-2026')
    const failing: AgentTool = {
      name: 'read_file',
      label: 'Read File',
      description: 'fake',
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        throw new Error(`connect failed with token fail-token-value-2026 and ${CORPUS_TOKENS.GHP}`)
      },
    }
    const [wrapped] = withSecretBoundary([failing])
    await expect(wrapped.execute('call-6', { path: '/tmp/x' })).rejects.toThrow(
      `connect failed with token ${REDACTED_HANDLE} and {{secret:github-token-1}}`,
    )
  })

  it('does not resolve handles for tools other than shell', async () => {
    const slug = sealSecret(CORPUS_TOKENS.GHP, 'github-token', 'chat')
    const seen: string[] = []
    const other: AgentTool = {
      name: 'write_file',
      label: 'Write File',
      description: 'fake',
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_id, params) => {
        seen.push((params as { command: string }).command)
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    }
    const [wrapped] = withSecretBoundary([other])
    await wrapped.execute('call-7', { command: `echo ${secretHandle(slug)}` })
    expect(seen[0]).toBe(`echo ${secretHandle(slug)}`)
  })

  it('keeps tool metadata intact', () => {
    const calls: ShellCall[] = []
    const [shell] = withSecretBoundary([fakeShellTool(calls)])
    expect(shell.name).toBe('shell')
    expect(shell.label).toBe('Execute Shell Command')
    expect(shell.description).toBe('fake shell for tests')
  })
})
