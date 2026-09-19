import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createYoloTools } from './agent-runtime.js'
import { setHeuristicsOverrideForTests } from './heuristics.js'
import {
  capHeadTail,
  detectBinaryContent,
  guessMimeType,
  sliceFileForPrompt,
} from './tool-output-limits.js'

function toolByName(name: string): AgentTool {
  const tool = createYoloTools().find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not found`)
  return tool
}

async function runTool(tool: AgentTool, params: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute('call-1', params, undefined as never) as {
    content: Array<{ type: string; text?: string }>
    details?: Record<string, unknown>
  }
  const text = result.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
  return { text, details: result.details ?? {} }
}

describe('capHeadTail', () => {
  it('passes short output through untouched', () => {
    const r = capHeadTail('hello', 100)
    expect(r.text).toBe('hello')
    expect(r.truncated).toBe(false)
  })

  it('keeps head and tail and names the total size', () => {
    const text = 'A'.repeat(1000) + 'MIDDLE' + 'B'.repeat(1000)
    const r = capHeadTail(text, 100, 'shell output')
    expect(r.truncated).toBe(true)
    expect(r.totalChars).toBe(2006)
    expect(r.text.startsWith('A'.repeat(50))).toBe(true)
    expect(r.text.endsWith('B'.repeat(50))).toBe(true)
    expect(r.text).not.toContain('MIDDLE')
    expect(r.text).toContain('shell output truncated')
    expect(r.text).toContain('2006 characters total')
  })
})

describe('sliceFileForPrompt', () => {
  it('returns a small file byte-identical', () => {
    const content = 'line one\nline two\n'
    const r = sliceFileForPrompt(content, { maxChars: 20000, path: '/tmp/a.txt' })
    expect(r.text).toBe(content)
    expect(r.truncated).toBe(false)
    expect(r.nextOffset).toBeNull()
  })

  it('cuts at the cap and reports size, line range and the next offset', () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const r = sliceFileForPrompt(content, { maxChars: 100, path: '/tmp/big.txt' })
    expect(r.truncated).toBe(true)
    expect(r.returned).toBe(100)
    expect(r.nextOffset).toBe(100)
    expect(r.text).toContain(`showing characters 0-100 of ${content.length}`)
    expect(r.text).toContain('lines 1-')
    expect(r.text).toContain('Continue with read_file(path, offset=100)')
  })

  it('pages from an offset and reports the right first line', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const first = sliceFileForPrompt(content, { maxChars: 50, path: '/tmp/p.txt' })
    const second = sliceFileForPrompt(content, { maxChars: 50, offset: first.nextOffset ?? 0, path: '/tmp/p.txt' })
    expect(second.offset).toBe(50)
    expect(second.firstLine).toBeGreaterThan(1)
    expect(second.text).toContain('showing characters 50-100')
    // The two slices together reproduce the first 100 characters.
    const body = (slice: string): string => slice.split('\n').slice(1, -1).join('\n')
    expect(body(first.text) + body(second.text)).toBe(content.slice(0, 100))
  })

  it('clamps limit to the hard cap and ends cleanly at EOF', () => {
    const content = 'x'.repeat(300)
    const r = sliceFileForPrompt(content, { maxChars: 100, limit: 999999, path: '/tmp/c.txt' })
    expect(r.returned).toBe(100)
    const last = sliceFileForPrompt(content, { maxChars: 100, offset: 200, path: '/tmp/c.txt' })
    expect(last.nextOffset).toBeNull()
    expect(last.text).toContain('End of file')
  })
})

describe('detectBinaryContent', () => {
  it('accepts UTF-8 text including umlauts and emoji', () => {
    expect(detectBinaryContent(Buffer.from('Grüße 🌍\n', 'utf-8')).binary).toBe(false)
    expect(detectBinaryContent(Buffer.from('', 'utf-8')).binary).toBe(false)
  })

  it('flags NUL bytes', () => {
    const buf = Buffer.concat([Buffer.from('text'), Buffer.from([0x00]), Buffer.from('more')])
    expect(detectBinaryContent(buf)).toEqual({ binary: true, reason: 'null-byte' })
  })

  it('flags invalid UTF-8 without NUL bytes', () => {
    const buf = Buffer.from([0x41, 0xc3, 0x28, 0xff, 0xfe])
    expect(detectBinaryContent(buf)).toEqual({ binary: true, reason: 'non-utf8' })
  })

  it('guesses MIME types from magic bytes and extensions', () => {
    expect(guessMimeType('/x/photo.bin', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(guessMimeType('/x/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(guessMimeType('/x/archive.zip')).toBe('application/zip')
    expect(guessMimeType('/x/unknown.xyz')).toBe('application/octet-stream')
  })
})

describe('read_file / shell prompt caps', () => {
  let dir: string
  let prevWorkspaceDir: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-tool-caps-'))
    // The shell tool spawns with cwd = getWorkspaceDir(); its fallback
    // /workspace does not exist in the Docker image build stage (spawn
    // ENOENT). Pin the workspace to the temp dir so the test is hermetic.
    prevWorkspaceDir = process.env.WORKSPACE_DIR
    process.env.WORKSPACE_DIR = dir
    setHeuristicsOverrideForTests({ toolOutput: { readFileMaxChars: 2000, shellMaxChars: 1000 } })
  })

  afterEach(() => {
    setHeuristicsOverrideForTests(null)
    if (prevWorkspaceDir === undefined) delete process.env.WORKSPACE_DIR
    else process.env.WORKSPACE_DIR = prevWorkspaceDir
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('read_file returns a small file unchanged', async () => {
    const file = path.join(dir, 'small.txt')
    fs.writeFileSync(file, 'hello world\n')
    const { text, details } = await runTool(toolByName('read_file'), { path: file })
    expect(text).toBe('hello world\n')
    expect(details.truncated).toBeUndefined()
  })

  it('read_file caps a large file and can page through it with offset', async () => {
    const file = path.join(dir, 'big.txt')
    const content = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
    fs.writeFileSync(file, content)
    expect(content.length).toBeGreaterThan(20000)

    const first = await runTool(toolByName('read_file'), { path: file })
    expect(first.text.length).toBeLessThan(2600)
    expect(first.details.truncated).toBe(true)
    expect(first.details.totalChars).toBe(content.length)
    expect(first.details.nextOffset).toBe(2000)
    expect(first.text).toContain(`of ${content.length}`)
    expect(first.text).toContain('offset=2000')
    expect(first.text).toContain('line 0')

    const second = await runTool(toolByName('read_file'), { path: file, offset: 2000 })
    expect(second.details.offset).toBe(2000)
    expect(second.text).toContain('showing characters 2000-4000')
    expect(second.text).toContain(content.slice(2000, 2100))
  })

  it('read_file returns metadata instead of content for binary files', async () => {
    const file = path.join(dir, 'photo.jpg')
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50000, 0x7f), Buffer.from([0x00, 0xff, 0xd9])])
    fs.writeFileSync(file, jpeg)

    const { text, details } = await runTool(toolByName('read_file'), { path: file })
    expect(details.binary).toBe(true)
    expect(details.mime).toBe('image/jpeg')
    expect(details.bytes).toBe(jpeg.length)
    expect(text).toContain('binary file')
    expect(text).toContain('image/jpeg')
    expect(text.length).toBeLessThan(400)
  })

  it('read_file still reports errors for missing files', async () => {
    const { text, details } = await runTool(toolByName('read_file'), { path: path.join(dir, 'nope.txt') })
    expect(details.error).toBe(true)
    expect(text).toContain('Error reading file')
  })

  it('shell keeps head and tail of a huge output', async () => {
    const { text, details } = await runTool(toolByName('shell'), {
      command: `node -e "process.stdout.write('A'.repeat(4000)+'MIDDLE'+'B'.repeat(4000))"`,
      timeout: 30000,
    })
    expect(details.truncated).toBe(true)
    expect(details.totalChars).toBeGreaterThan(8000)
    expect(text.length).toBeLessThan(1600)
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
    expect(text).not.toContain('MIDDLE')
    expect(text).toContain('shell output truncated')
  })

  it('shell passes short output through untouched', async () => {
    const { text, details } = await runTool(toolByName('shell'), { command: 'echo hi' })
    expect(text.trim()).toBe('hi')
    expect(details.truncated).toBeUndefined()
    expect(details.exitCode).toBe(0)
  })
})
