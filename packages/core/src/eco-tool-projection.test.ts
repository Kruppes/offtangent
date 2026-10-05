import { describe, it, expect } from 'vitest'
import { projectToolResult, projectToolResultSafe, toolResultText } from './eco-tool-projection.js'

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} lorem ipsum dolor sit amet 0123456789`).join('\n')

describe('eco tool projection (pure, deterministic)', () => {
  it('keeps short results unchanged (null)', () => {
    expect(projectToolResult({ toolName: 'shell', args: {}, text: 'ok', isError: false, refId: 1 })).toBeNull()
  })
  it('never projects without a real persisted reference id', () => {
    expect(projectToolResult({ toolName: 'shell', args: {}, text: filler(500, 'x'), isError: false, refId: 0 })).toBeNull()
  })
  it('is deterministic and keeps head, tail, error/exit lines and arg-matched lines verbatim with line numbers and recall offsets', () => {
    const text = `${filler(200, 'a')}\nsrc/foo.ts(12,3): error TS2322: Type mismatch\n${filler(200, 'b')}\nneedleTokenXYZ found here\n${filler(200, 'c')}\nProcess exited with code 2`
    const input = { toolName: 'shell', args: { command: 'grep -rn needleTokenXYZ src' }, text, isError: true, refId: 42 }
    const p1 = projectToolResult(input)!
    const p2 = projectToolResult(input)!
    expect(p1.text).toBe(p2.text)
    expect(p1.text).toContain('message 42')
    expect(p1.text).toContain('recall_message(message_id=42)')
    expect(p1.text).toContain('error TS2322: Type mismatch')
    expect(p1.text).toContain('needleTokenXYZ found here')
    expect(p1.text).toContain('Process exited with code 2')
    expect(p1.text).toContain('a line 0 ')
    expect(p1.text).toMatch(/omitted \(\d+ chars\) — recall_message offset ≈ \d+/)
    expect(p1.text).toContain('PARTIAL')
    expect(p1.projectedChars).toBeLessThan(p1.originalChars * 0.6)
  })
  it('named gap offsets point at the omitted original text', () => {
    const text = filler(600, 'z')
    const p = projectToolResult({ toolName: 'read_file', args: { path: 'x' }, text, isError: false, refId: 7 })!
    const m = /lines (\d+)-\d+ omitted \(\d+ chars\) — recall_message offset ≈ (\d+)/.exec(p.text)!
    const firstOmittedLine = Number(m[1])
    expect(text.slice(Number(m[2])).startsWith(`z line ${firstOmittedLine - 1} `)).toBe(true)
  })
  it('keeps the original when the projection would not save enough (all lines are signal)', () => {
    const text = Array.from({ length: 300 }, (_, i) => `error ${i}: failed to compile module number ${i}`).join('\n')
    expect(projectToolResult({ toolName: 'shell', args: {}, text, isError: true, refId: 3 }, { maxSignalLines: 10000 })).toBeNull()
  })
  it('fail-safe wrapper never throws', () => {
    expect(projectToolResultSafe({ toolName: 'x', args: null, text: null as unknown as string, isError: false, refId: 1 })).toBeNull()
  })
  it('only text-only results are eligible', () => {
    expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(toolResultText([{ type: 'image', data: 'x', mimeType: 'image/png' }])).toBeNull()
    expect(toolResultText([])).toBeNull()
  })
})
