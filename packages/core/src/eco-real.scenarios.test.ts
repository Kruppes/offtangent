/**
 * Offline per-scenario accounting (chars, NOT provider tokens, NOT a measured
 * cache hit). Each scenario = one completed tool result followed by K further
 * requests of the same tool loop. Prefix model: the request that first carries
 * the result writes it to cache once, every later request reads it again.
 * "needs full" = the model pages the whole original via recall_message
 * (16000-char pages, each page one extra request that re-reads the prefix).
 * Weighted = write×1.25 + read×0.1 (Anthropic list-price ratios), illustrative.
 */
import { describe, it, expect } from 'vitest'
import { projectToolResult } from './eco-tool-projection.js'

const K = 3 // further requests after the result in the same loop
const PAGE = 16000

interface Row { scenario: string; original: number; projected: number | null; normalW: number; ecoW: number; fullW: number }

function account(name: string, toolName: string, args: Record<string, unknown>, text: string): Row {
  const p = projectToolResult({ toolName, args, text, isError: false, refId: 42 })
  const shown = p ? p.text.length : text.length
  const w = (write: number, read: number) => write * 1.25 + read * 0.1
  const normalW = w(text.length, text.length * K)
  const ecoW = w(shown, shown * K)
  let fullW = ecoW
  if (p) {
    const pages = Math.ceil(text.length / PAGE)
    // every page is written once and re-read by every later request (pages + K)
    let write = shown, read = 0, prefix = shown
    for (let i = 0; i < pages; i++) { read += prefix; const page = Math.min(PAGE, text.length - i * PAGE) + 160; write += page; prefix += page }
    read += prefix * K
    fullW = w(write, read)
  }
  return { scenario: name, original: text.length, projected: p ? p.text.length : null, normalW, ecoW, fullW }
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join('\n')

describe('offline per-scenario accounting (chars, simulation only)', () => {
  it('tiny / large / facts-middle / search / file / shell / needs-full', () => {
    const rows: Row[] = [
      account('tiny shell (2 KB)', 'shell', { command: 'ls' }, lines(60, i => `file-${i}.ts`)),
      account('large passing test log', 'shell', { command: 'npm test' }, lines(2000, i => ` ✓ src/m${i}.test.ts (3 tests) ${i}ms`) + '\nTests  6000 passed (6000)'),
      account('shell log, failure in middle', 'shell', { command: 'npm test' }, lines(2000, i => (i === 1000 ? ' FAIL src/pay.test.ts > totals\nAssertionError: SYNTH-FACT-MIDDLE' : ` ✓ src/m${i}.test.ts ${i}ms`))),
      account('search (grep, 40 files)', 'grep', { pattern: 'useEco' }, lines(1600, i => `src/f${i % 40}.ts:${i}: const x${i} = useEco(${i})`)),
      account('file read, target in middle', 'read_file', { path: 'src/big.ts' }, lines(1500, i => (i === 750 ? 'export function targetFn() { return 1 }' : `  const v${i} = compute(${i}) // filler`))),
      account('needs full (complete diff review)', 'shell', { command: 'git diff' }, lines(1500, i => `+ line ${i} changed content ${'x'.repeat(10)}`)),
    ]
    const tiny = rows[0]!
    expect(tiny.projected).toBeNull() // under 6000 chars: original passes unchanged
    const failure = projectToolResult({ toolName: 'shell', args: { command: 'npm test' }, text: lines(2000, i => (i === 1000 ? ' FAIL src/pay.test.ts > totals\nAssertionError: SYNTH-FACT-MIDDLE' : ` ✓ src/m${i}.test.ts ${i}ms`)), isError: false, refId: 42 })!
    expect(failure.text).toContain('SYNTH-FACT-MIDDLE') // error line survives projection
    const file = projectToolResult({ toolName: 'read_file', args: { path: 'src/big.ts' }, text: lines(1500, i => (i === 750 ? 'export function targetFn() { return 1 }' : `  const v${i} = compute(${i}) // filler`)), isError: false, refId: 42 })!
    expect(file.text).toContain('targetFn') // structural outline line kept
    const full = rows[5]!
    expect(full.fullW).toBeGreaterThan(full.normalW) // needs-full: Eco costs MORE than Normal
    for (const r of rows.slice(1)) expect(r.ecoW).toBeLessThan(r.normalW)
    console.log('ECO-SCENARIOS\n' + rows.map(r => [r.scenario, r.original, r.projected ?? 'unchanged', Math.round(r.normalW), Math.round(r.ecoW), Math.round(r.fullW), `${Math.round((r.ecoW / r.normalW - 1) * 100)}%`, `${Math.round((r.fullW / r.normalW - 1) * 100)}%`].join(' | ')).join('\n'))
  })
})
