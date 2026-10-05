import { describe, it, expect } from 'vitest'
import { ecoToolFamily, projectToolResult, projectToolResultSafe, toolResultText } from './eco-tool-projection.js'

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

describe('eco tool families (representative productive paths, synthetic fixtures)', () => {
  it('classifies by generic name families only', () => {
    expect(ecoToolFamily('shell')).toBe('shell')
    expect(ecoToolFamily('bash')).toBe('shell')
    expect(ecoToolFamily('read_file')).toBe('file')
    expect(ecoToolFamily('list_files')).toBe('search')
    expect(ecoToolFamily('grep')).toBe('search')
    expect(ecoToolFamily('web_search')).toBe('search')
    expect(ecoToolFamily('publish_board')).toBe('generic')
  })

  it('shell: a failing test run keeps the failing line, its 3 trace frames, the summary and the exit code; > 70 % smaller', () => {
    const lines: string[] = []
    for (let i = 0; i < 1500; i++) lines.push(` ✓ src/mod${i}.test.ts (4 tests) ${i % 50}ms`)
    lines.splice(700, 0, ' FAIL src/payment.test.ts > rounds totals', 'AssertionError: expected 10.05 to be 10.04', '  at src/payment.ts:88:13', '  at src/payment.test.ts:21:5')
    lines.push(' Test Files  1 failed | 1500 passed', '      Tests  1 failed | 6000 passed', 'npm ERR! code 1', 'exit status 1')
    const text = lines.join('\n')
    const p = projectToolResult({ toolName: 'shell', args: { command: 'npm test' }, text, isError: true, refId: 11 })!
    expect(p).not.toBeNull()
    for (const must of ['FAIL src/payment.test.ts', 'expected 10.05 to be 10.04', 'src/payment.ts:88:13', 'src/payment.test.ts:21:5', '1 failed | 6000 passed', 'exit status 1', 'Status: error', 'Profile shell']) {
      expect(p.text).toContain(must)
    }
    expect(p.projectedChars).toBeLessThan(text.length * 0.3)
  })

  it('search: grep over 40 files keeps exact source count and the first hits of EVERY file; middle hits are recoverable by offset', () => {
    const lines: string[] = []
    for (let f = 0; f < 40; f++) for (let h = 0; h < 40; h++) lines.push(`src/area${f}/file${f}.ts:${h * 7 + 1}:  const value${h} = computeTotal(order, ${h}) // padding text`)
    const text = lines.join('\n')
    const p = projectToolResult({ toolName: 'grep', args: { pattern: 'computeTotal' }, text, isError: false, refId: 12 }, { maxSignalLines: 200 })!
    expect(p.text).toContain('40 distinct sources')
    for (let f = 0; f < 40; f++) expect(p.text).toContain(`src/area${f}/file${f}.ts:1:`)
    expect(p.text).not.toContain('src/area20/file20.ts:211:')
    const gap = /recall_message offset ≈ (\d+)/.exec(p.text.slice(p.text.indexOf('src/area20/file20.ts:8:')))!
    expect(text.slice(Number(gap[1])).startsWith('src/area20/file20.ts:15:')).toBe(true)
    expect(p.projectedChars).toBeLessThan(text.length * 0.3)
  })

  it('file: a large source file keeps a structural outline (the declaration in the middle) plus recall offsets', () => {
    const lines: string[] = []
    for (let i = 0; i < 1200; i++) {
      if (i % 100 === 0) lines.push(`export function section${i}(input: Order): number {`)
      else lines.push(`  const step${i} = input.amount * ${i} + offset // arithmetic filler line`)
    }
    const text = lines.join('\n')
    const p = projectToolResult({ toolName: 'read_file', args: { path: '/workspace/app/orders.ts' }, text, isError: false, refId: 13 })!
    expect(p.text).toContain('Profile file')
    expect(p.text).toContain('601| export function section600(input: Order): number {')
    expect(p.text).not.toContain('step650')
    expect(p.projectedChars).toBeLessThan(text.length * 0.3)
  })
})
