/**
 * Step 2 of the privacy plan (2026-09-26): file contents that enter the SYSTEM
 * prompt (MEMORY.md, the recent dailies, the wiki list, the skill list) pass
 * `sealText` with tier `strong` first.
 *
 * Tier `strong` on purpose: the prompt is assembled on every turn, so a
 * context rule ("Passwort: …") firing on prose would be a cache-busting
 * false positive. Structural rules are safe there.
 *
 * The second assertion is the one that protects the prompt cache: assembling
 * twice from unchanged files must produce a byte-identical prompt (the handle
 * of a value is stable once the value is stored).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { assembleSystemPrompt, ensureMemoryStructure } from './memory.js'
import { listSecrets, resolveSecret, invalidateSecretHandleCache } from './secret-store.js'
import { invalidateKnownValues } from './secret-boundary.js'

const CANARY = ['ghp', '_', 'MemoryCanary', '22222', 'abcdefghijklm', 'no'].join('')

let tmpDir: string
let memoryDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-prompt-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  memoryDir = path.join(tmpDir, 'memory')
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-system-prompt-sealing'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  ensureMemoryStructure(memoryDir)
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

describe('system prompt sealing (plan step 2)', () => {
  it('seals a token that sits in MEMORY.md', () => {
    fs.writeFileSync(
      path.join(memoryDir, 'MEMORY.md'),
      `# Agent Memory\n\n- Deploy token of the demo repo: ${CANARY}\n`,
      'utf-8',
    )
    const prompt = assembleSystemPrompt({ memoryDir })
    expect(prompt).not.toContain(CANARY)
    expect(prompt).toMatch(/\{\{secret:github-token-\d+\}\}/)
    const stored = listSecrets()
    expect(stored).toHaveLength(1)
    expect(stored[0]!.source).toBe('system:core-memory')
    expect(resolveSecret(stored[0]!.slug)).toBe(CANARY)
  })

  it('seals a token in a daily note (recent memory)', () => {
    const dailyDir = path.join(memoryDir, 'daily')
    fs.mkdirSync(dailyDir, { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(path.join(dailyDir, `${today}.md`), `- pushed with ${CANARY}\n`, 'utf-8')
    const prompt = assembleSystemPrompt({ memoryDir })
    expect(prompt).not.toContain(CANARY)
    expect(prompt).toMatch(/\{\{secret:github-token-\d+\}\}/)
  })

  it('is deterministic: two assemblies of unchanged files are byte-identical', () => {
    fs.writeFileSync(
      path.join(memoryDir, 'MEMORY.md'),
      `# Agent Memory\n\n- token ${CANARY}\n`,
      'utf-8',
    )
    const first = assembleSystemPrompt({ memoryDir })
    const second = assembleSystemPrompt({ memoryDir })
    expect(second).toBe(first)
    // One handle for one value, no matter how often the prompt is assembled.
    expect(listSecrets()).toHaveLength(1)
  })

  it('leaves prose with the word "Passwort" untouched (tier strong, no context rules)', () => {
    const line = 'Alex sagt, das Passwort für den Router ist geändert worden.'
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# Agent Memory\n\n- ${line}\n`, 'utf-8')
    const prompt = assembleSystemPrompt({ memoryDir })
    expect(prompt).toContain(line)
    expect(listSecrets()).toEqual([])
  })
})
