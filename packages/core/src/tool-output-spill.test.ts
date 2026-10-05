import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createYoloTools } from './agent-runtime.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import { withSecretBoundary, invalidateKnownValues } from './secret-boundary.js'
import { invalidateSecretHandleCache } from './secret-store.js'
import { CORPUS_TOKENS } from './secret-corpus.fixture.js'
import {
  cleanupToolOutputSpills,
  getToolOutputSpillDir,
  resetToolOutputSpillCleanupForTests,
  spillToolOutput,
  TOOL_OUTPUT_SPILL_TTL_MS,
} from './tool-output-spill.js'

let tmpDir: string
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-tool-spill-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true })
  for (const key of ['DATA_DIR', 'WORKSPACE_DIR', 'ENCRYPTION_KEY']) saved[key] = process.env[key]
  process.env.DATA_DIR = tmpDir
  process.env.WORKSPACE_DIR = path.join(tmpDir, 'workspace')
  process.env.ENCRYPTION_KEY = 'test-key-for-tool-output-spill-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
  resetToolOutputSpillCleanupForTests()
  setHeuristicsOverrideForTests(null)
})

afterEach(() => {
  setHeuristicsOverrideForTests(null)
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

function shellTool(): AgentTool {
  const [tool] = withSecretBoundary(createYoloTools().filter(t => t.name === 'shell'))
  return tool
}

async function runShell(command: string): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await shellTool().execute('call', { command, timeout: 30000 })
  const text = result.content.map(c => (c.type === 'text' ? c.text : '')).join('')
  return { text, details: (result.details ?? {}) as Record<string, unknown> }
}

/** Print `n` characters of a pattern plus a marker in the middle, via node (no shell quoting tricks). */
function printCommand(head: string, middle: string, tail: string, extra = ''): string {
  return `node -e "process.stdout.write('${head}'+'${middle}'+'${tail}');${extra}"`
}

/**
 * Spill a 600 H + 5000 M + 600 T text with maxChars 1000 and check the contract:
 * exactly 500 H and 500 T stay inline, none of the 5000 M payload characters
 * does, and the complete text sits in a private file.
 *
 * Why not `expect(r.text).not.toContain('M')`: the inline message also names
 * the spill file, and that path is not under the test's control (mkdtemp
 * appends a random suffix that can hold an "M"). The leak check therefore
 * compares the head and tail slices exactly and counts the "M" characters of
 * the whole message against the ones the path itself contributes: any payload
 * character that leaks (even one) changes the count, the path never does.
 */
function verifyHeadTailInlineAndCompleteFile(expectedDir = tmpDir) {
  const text = `${'H'.repeat(600)}${'M'.repeat(5000)}${'T'.repeat(600)}`
  const r = spillToolOutput(text, { maxChars: 1000, label: 'shell', note: 'exit code 2' })!
  const count = (value: string) => (value.match(/M/g) ?? []).length
  expect(r.totalChars).toBe(6200)
  expect(r.headChars).toBe(500)
  // Inline components: head slice, marker, tail slice. Exact equality, so a leaked payload character cannot hide in either.
  const head = r.text.slice(0, r.headChars)
  const tail = r.text.slice(r.text.length - 500)
  const marker = r.text.slice(r.headChars, r.text.length - 500)
  expect(head).toBe('H'.repeat(500))
  expect(tail).toBe('T'.repeat(500))
  expect(r.text.split(r.path)).toHaveLength(2) // the path is named exactly once, in the marker
  expect(count(r.text)).toBe(count(r.path)) // no payload "M" beyond what the path brings along
  expect(count(marker)).toBe(count(r.path))
  expect(r.text).toContain('shell output truncated: 6200 characters total, exit code 2')
  expect(r.text).toContain('5200 omitted here')
  expect(r.text).toContain(r.path)
  expect(r.text).toContain('offset 500')
  expect(fs.readFileSync(r.path, 'utf-8')).toBe(text) // complete payload intact in the file
  expect(path.dirname(r.path)).toBe(path.join(expectedDir, 'tool-output'))
  expect(fs.statSync(r.path).mode & 0o777).toBe(0o600)
  expect(fs.statSync(path.dirname(r.path)).mode & 0o777).toBe(0o700)
  return r
}

describe('spillToolOutput', () => {
  it('returns null at or below the threshold', () => {
    expect(spillToolOutput('x'.repeat(100), { maxChars: 100, label: 'shell' })).toBeNull()
    expect(spillToolOutput('x'.repeat(10), { maxChars: 0, label: 'shell' })).toBeNull()
    expect(fs.existsSync(getToolOutputSpillDir())).toBe(false)
  })

  it('keeps head and tail inline and the complete text in a private file', () => {
    verifyHeadTailInlineAndCompleteFile()
  })

  it('stays deterministic when the spill path itself contains the marker character (regression: random mkdtemp suffix)', () => {
    // The spill path is part of the inline message. mkdtemp picks a random
    // suffix, so a path with an upper-case "M" is a fixed fixture here, not luck.
    const dataDir = path.join(tmpDir, 'MMMM-forced-marker-chars')
    fs.mkdirSync(dataDir, { recursive: true })
    process.env.DATA_DIR = dataDir // restored by afterEach
    const r = verifyHeadTailInlineAndCompleteFile(dataDir)
    expect(r.path).toContain('MMMM-forced-marker-chars') // guard: the fixture really puts "M" into the path
  })

  it('generates the file name itself; the label cannot steer the path', () => {
    const r = spillToolOutput('x'.repeat(50), { maxChars: 10, label: '../../etc/passwd' })!
    expect(path.dirname(r.path)).toBe(getToolOutputSpillDir())
    expect(path.basename(r.path)).toMatch(/^etcpasswd-\d+-[0-9a-f]{16}\.txt$/)
    const other = spillToolOutput('x'.repeat(50), { maxChars: 10, label: '../../etc/passwd' })!
    expect(other.path).not.toBe(r.path)
  })

  it('returns null instead of throwing when the directory cannot be created', () => {
    fs.writeFileSync(path.join(tmpDir, 'tool-output'), 'not a directory')
    expect(spillToolOutput('x'.repeat(50), { maxChars: 10, label: 'shell' })).toBeNull()
  })
})

describe('cleanupToolOutputSpills', () => {
  it('removes spilled files older than the TTL and nothing else', () => {
    const now = Date.now()
    const old = spillToolOutput('x'.repeat(50), { maxChars: 10, label: 'shell', now: now - TOOL_OUTPUT_SPILL_TTL_MS - 60_000 })!
    const fresh = spillToolOutput('y'.repeat(50), { maxChars: 10, label: 'shell', now })!
    const past = (now - TOOL_OUTPUT_SPILL_TTL_MS - 60_000) / 1000
    fs.utimesSync(old.path, past, past)
    const foreign = path.join(getToolOutputSpillDir(), 'keep-me.txt')
    fs.writeFileSync(foreign, 'foreign')
    fs.utimesSync(foreign, past, past)

    expect(cleanupToolOutputSpills({ now })).toBe(1)
    expect(fs.existsSync(old.path)).toBe(false)
    expect(fs.existsSync(fresh.path)).toBe(true)
    expect(fs.existsSync(foreign)).toBe(true)
  })

  it('runs on the next spill', () => {
    const now = Date.now()
    const old = spillToolOutput('x'.repeat(50), { maxChars: 10, label: 'shell', now: now - TOOL_OUTPUT_SPILL_TTL_MS - 60_000 })!
    const past = (now - TOOL_OUTPUT_SPILL_TTL_MS - 60_000) / 1000
    fs.utimesSync(old.path, past, past)
    resetToolOutputSpillCleanupForTests()
    spillToolOutput('y'.repeat(50), { maxChars: 10, label: 'shell', now })
    expect(fs.existsSync(old.path)).toBe(false)
  })

  it('is a no-op without a spill directory', () => {
    expect(cleanupToolOutputSpills()).toBe(0)
  })
})

describe('shell tool with output spill', () => {
  it('passes output below the threshold through unchanged', async () => {
    const { text, details } = await runShell(`node -e "process.stdout.write('z'.repeat(7999))"`)
    expect(text).toBe('z'.repeat(7999))
    expect(details).toEqual({ exitCode: 0 })
    expect(fs.existsSync(getToolOutputSpillDir())).toBe(false)
  })

  it('spills output above the default threshold (8000) to a file and keeps head + tail inline', async () => {
    const { text, details } = await runShell(printCommand("'+'A'.repeat(6000)+'", 'MIDDLE', "'+'B'.repeat(6000)+'"))
    expect(details.truncated).toBe(true)
    expect(details.totalChars).toBe(12006)
    const file = details.fullOutputPath as string
    expect(path.dirname(file)).toBe(path.join(tmpDir, 'tool-output'))
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${'A'.repeat(6000)}MIDDLE${'B'.repeat(6000)}`)
    expect(text.startsWith('A'.repeat(4000))).toBe(true)
    expect(text.endsWith('B'.repeat(4000))).toBe(true)
    expect(text).not.toContain('MIDDLE')
    expect(text).toContain(file)
    expect(text).toContain('12006 characters total, exit code 0')
    expect(text.length).toBeLessThan(8000 + 600)
  })

  it('keeps the exit code and the stderr tail of a failing command', async () => {
    const cmd = `node -e "process.stdout.write('o'.repeat(20000));process.stderr.write('FATAL: boom');process.exit(3)"`
    const { text, details } = await runShell(cmd)
    expect(details.exitCode).toBe(3)
    expect(text).toContain('exit code 3')
    expect(text.endsWith('FATAL: boom')).toBe(true)
    expect(fs.readFileSync(details.fullOutputPath as string, 'utf-8')).toContain('FATAL: boom')
  })

  it('writes only sealed text: a credential in the omitted middle never reaches the file in plaintext', async () => {
    const token = CORPUS_TOKENS.AKIA
    // Line breaks around the credential: the detector matches on word boundaries.
    const { text, details } = await runShell(printCommand("'+'A'.repeat(6000)+'", `\\nAWS=${token}\\n`, "'+'B'.repeat(6000)+'"))
    const file = fs.readFileSync(details.fullOutputPath as string, 'utf-8')
    expect(file).not.toContain(token)
    expect(file).toMatch(/AWS=\{\{secret:aws-access-key-\d+\}\}/)
    expect(text).not.toContain(token)
  })

  it('never writes the output of a password-manager CLI command to disk', async () => {
    // A fake `bw` on PATH prints a long, harmless listing.
    const bin = path.join(tmpDir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'bw'), `#!/bin/sh\nnode -e "process.stdout.write('v'.repeat(12000))"\n`, { mode: 0o755 })
    const { details } = await runShell(`PATH=${bin}:$PATH bw --version`)
    expect(details.fullOutputPath).toBeUndefined()
    expect(fs.existsSync(getToolOutputSpillDir())).toBe(false)
  })

  it('honours a configured threshold and 0 disables the file', async () => {
    setHeuristicsOverrideForTests({ toolOutput: { shellSpillChars: 2000 } })
    const spilled = await runShell(`node -e "process.stdout.write('q'.repeat(3000))"`)
    expect(spilled.details.fullOutputPath).toBeDefined()
    expect(spilled.text.startsWith('q'.repeat(1000))).toBe(true)

    setHeuristicsOverrideForTests({ toolOutput: { shellSpillChars: 0, shellMaxChars: 1000 } })
    const capped = await runShell(`node -e "process.stdout.write('r'.repeat(3000))"`)
    expect(capped.details.fullOutputPath).toBeUndefined()
    expect(capped.details.truncated).toBe(true)
    expect(capped.text).toContain('Narrow the command')
  })
})
