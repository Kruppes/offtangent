import { describe, it, expect } from 'vitest'
import { classifyEcoShellCommand, ecoProjectionProfile, projectToolResult, projectToolResultSafe, toolResultText } from './eco-tool-projection.js'

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i} lorem ipsum dolor sit amet 0123456789`).join('\n')

describe('eco tool projection (pure, deterministic)', () => {
  it('keeps short results unchanged (null)', () => {
    expect(projectToolResult({ toolName: 'shell', args: {}, text: 'ok', isError: false, refId: 1 })).toBeNull()
  })
  it('never projects without a real persisted reference id', () => {
    expect(projectToolResult({ toolName: 'shell', args: {}, text: filler(500, 'x'), isError: false, refId: 0 })).toBeNull()
  })
  it('is deterministic and keeps head, tail, error/exit lines verbatim with line numbers and recall offsets', () => {
    const text = `${filler(200, 'a')}\nsrc/foo.ts(12,3): error TS2322: Type mismatch\n${filler(200, 'b')}\n${filler(200, 'c')}\nProcess exited with code 2`
    const input = { toolName: 'shell', args: { command: 'npx tsc --noEmit -p .' }, text, isError: true, refId: 42 }
    const p1 = projectToolResult(input)!
    const p2 = projectToolResult(input)!
    expect(p1.text).toBe(p2.text)
    expect(p1.text).toContain('message 42')
    expect(p1.text).toContain('recall_message(message_id=42)')
    expect(p1.text).toContain('error TS2322: Type mismatch')
    expect(p1.text).toContain('Process exited with code 2')
    expect(p1.text).toContain('a line 0 ')
    expect(p1.text).toMatch(/omitted \(\d+ chars\) — recall_message offset ≈ \d+/)
    expect(p1.text).toContain('PARTIAL')
    expect(p1.projectedChars).toBeLessThan(p1.originalChars * 0.6)
  })
  it('named gap offsets point at the omitted original text', () => {
    const text = filler(600, 'z')
    const p = projectToolResult({ toolName: 'shell', args: { command: 'npm run build' }, text, isError: false, refId: 7 })!
    const m = /lines (\d+)-\d+ omitted \(\d+ chars\) — recall_message offset ≈ (\d+)/.exec(p.text)!
    const firstOmittedLine = Number(m[1])
    expect(text.slice(Number(m[2])).startsWith(`z line ${firstOmittedLine - 1} `)).toBe(true)
  })
  it('keeps the original when the projection would not save enough (all lines are signal)', () => {
    const text = Array.from({ length: 300 }, (_, i) => `error ${i}: failed to compile module number ${i}`).join('\n')
    expect(projectToolResult({ toolName: 'shell', args: { command: 'npm test' }, text, isError: true, refId: 3 }, { maxSignalLines: 10000 })).toBeNull()
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

describe('F1 allowlist: only recognised build/test/lint shell runs and grep-style search are projected', () => {
  it('accepts unambiguous build/test/lint/install commands', () => {
    for (const c of [
      'npm test', 'npm run build', 'npm run lint', 'npm run typecheck', 'npm ci', 'npm test -- --run src/x.test.ts',
      'cd packages/core && npx vitest run src/eco', 'npx tsc --noEmit -p .', 'npx nuxi typecheck', 'pnpm -r build', 'npm -w packages/core run build', 'yarn test',
      'flock /workspace/.heavy-build.lock npm run build', 'timeout 600 npx vitest run', 'CI=1 npm test 2>&1',
      'cargo test', 'go test ./...', 'make test', './gradlew assembleDebug', 'python3 -m pytest -q', 'pytest -x',
    ]) expect(classifyEcoShellCommand(c), c).toBe('log')
    for (const c of ['grep -rn computeTotal src', 'rg computeTotal', 'git grep -n computeTotal']) expect(classifyEcoShellCommand(c), c).toBe('search')
  })
  it('returns null (passthrough) for source/diff/doc readers, network, and every ambiguous shell form', () => {
    for (const c of [
      'cat src/app.ts', 'head -n 400 README.md', 'sed -n 1,400p src/x.ts', 'less x', 'git diff', 'git diff main...HEAD', 'git show HEAD',
      'git log -p', 'curl https://example.com/article', 'wget -qO- https://x', 'python3 script.py', 'node build.js', 'ls -la', 'find . -name x',
      'npm test | tail -50', 'npm test; cat src/a.ts', 'npm test && cat src/a.ts', 'cat a.ts && npm test', 'npm test > out.log',
      'npm test $(cat x)', 'npm test `cat x`', 'bash -c "npm test"', 'sh run.sh', 'eval npm test', 'npm run deploy', 'npm run start',
      'npm test & cat x', 'npm exec -- cat x', 'npx some-unknown-cli', 'make install', 'grep -rl x src', 'grep -c x src', 'grep x file.ts',
      'npm test\ncat x', 'npm test || cat x', 'echo $SECRET', 'npm run test:$X', 'sudo npm test', 'xargs npm test',
    ]) expect(classifyEcoShellCommand(c), c).toBeNull()
  })
  it('never projects non-shell tools (read_file, web_fetch, email_read, recall, read_chat_history, search tools)', () => {
    const big = filler(800, 'p')
    for (const t of ['read_file', 'web_fetch', 'email_read', 'recall_message', 'read_chat_history', 'web_search', 'grep', 'list_files', 'bash', 'publish_board']) {
      expect(ecoProjectionProfile(t, { command: 'npm test', path: 'x' }, big), t).toBeNull()
      expect(projectToolResult({ toolName: t, args: { command: 'npm test' }, text: big, isError: false, refId: 5 }), t).toBeNull()
    }
  })
  it('a diff or a JSON document is content even from an allowlisted command', () => {
    const diff = 'diff --git a/x b/x\n@@ -1,3 +1,3 @@\n' + filler(500, '+')
    expect(ecoProjectionProfile('shell', { command: 'npm test' }, diff)).toBeNull()
    expect(ecoProjectionProfile('shell', { command: 'npm test' }, JSON.stringify({ a: filler(300, 'j') }))).toBeNull()
  })
  it('search output that is not grep-structured (prose/docs) is passthrough', () => {
    expect(ecoProjectionProfile('shell', { command: 'grep -rn x docs' }, filler(500, 'prose'))).toBeNull()
  })
})

describe('eco profiles (representative productive paths, synthetic fixtures)', () => {
  it('shell-log: a failing test run keeps the failing line, its 3 trace frames, the summary and the exit code; > 70 % smaller', () => {
    const lines: string[] = []
    for (let i = 0; i < 1500; i++) lines.push(` ✓ src/mod${i}.test.ts (4 tests) ${i % 50}ms`)
    lines.splice(700, 0, ' FAIL src/payment.test.ts > rounds totals', 'AssertionError: expected 10.05 to be 10.04', '  at src/payment.ts:88:13', '  at src/payment.test.ts:21:5')
    lines.push(' Test Files  1 failed | 1500 passed', '      Tests  1 failed | 6000 passed', 'npm ERR! code 1', 'exit status 1')
    const text = lines.join('\n')
    const p = projectToolResult({ toolName: 'shell', args: { command: 'npm test' }, text, isError: true, refId: 11 })!
    expect(p).not.toBeNull()
    for (const must of ['FAIL src/payment.test.ts', 'expected 10.05 to be 10.04', 'src/payment.ts:88:13', 'src/payment.test.ts:21:5', '1 failed | 6000 passed', 'exit status 1', 'Status: error', 'Profile shell-log']) {
      expect(p.text).toContain(must)
    }
    expect(p.projectedChars).toBeLessThan(text.length * 0.3)
  })

  it('search: grep -rn over 40 files keeps exact hit/source counts and the first hit of EVERY file; omitted hits are recoverable by offset', () => {
    const lines: string[] = []
    for (let f = 0; f < 40; f++) for (let h = 0; h < 40; h++) lines.push(`src/area${f}/file${f}.ts:${h * 7 + 1}:  const value${h} = computeTotal(order, ${h}) // padding text`)
    const text = lines.join('\n')
    const p = projectToolResult({ toolName: 'shell', args: { command: 'grep -rn computeTotal src' }, text, isError: false, refId: 12 })!
    expect(p.text).toContain('1600 hit lines in 40 distinct sources')
    for (let f = 0; f < 40; f++) expect(p.text).toContain(`src/area${f}/file${f}.ts:1:`)
    expect(p.text).not.toContain('src/area20/file20.ts:211:')
    const gap = /recall_message offset ≈ (\d+)/.exec(p.text.slice(p.text.indexOf('src/area20/file20.ts:8:')))!
    expect(text.slice(Number(gap[1])).startsWith('src/area20/file20.ts:15:')).toBe(true)
    expect(p.projectedChars).toBeLessThan(text.length * 0.3)
  })
})
