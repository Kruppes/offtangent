import { describe, expect, it } from 'vitest'
import {
  buildAbortHandoff,
  buildBudgetWarningMessage,
  firstBudgetCrossing,
  MAX_ABORT_HANDOFF_CHARS,
  ABORT_HANDOFF_WRAPUP_NOTE,
  ABORT_HANDOFF_HEAD,
  classifyHandoffError,
  HANDOFF_ERROR_CLASSES,
  handoffPath,
  handoffToolName,
  TaskActivityLog,
} from './task-budget.js'
import { extractHandoffSection } from './task-handoff.js'

describe('firstBudgetCrossing (S0-A / A3 threshold logic)', () => {
  it('stays quiet below the warning point', () => {
    expect(firstBudgetCrossing({
      time: { used: 70 * 60_000, limit: 120 * 60_000 },
      tool_calls: { used: 239, limit: 300 },
      input_tokens: { used: 23_000_000, limit: 30_000_000 },
    }, 0.8)).toBeNull()
  })

  it('fires exactly at the fraction (>=), not one step earlier', () => {
    expect(firstBudgetCrossing({ tool_calls: { used: 239, limit: 300 } }, 0.8)).toBeNull()
    expect(firstBudgetCrossing({ tool_calls: { used: 240, limit: 300 } }, 0.8)).toEqual({
      kind: 'tool_calls', used: 240, limit: 300, ratio: 0.8,
    })
  })

  it('reports the tool-call budget when it crosses before time and tokens', () => {
    const crossing = firstBudgetCrossing({
      time: { used: 40 * 60_000, limit: 120 * 60_000 },
      tool_calls: { used: 250, limit: 300 },
      input_tokens: { used: 5_000_000, limit: 30_000_000 },
    }, 0.8)
    expect(crossing?.kind).toBe('tool_calls')
  })

  it('reports the token budget when only it crossed', () => {
    const crossing = firstBudgetCrossing({
      tool_calls: { used: 10, limit: 300 },
      input_tokens: { used: 25_000_000, limit: 30_000_000 },
    }, 0.8)
    expect(crossing?.kind).toBe('input_tokens')
  })

  it('reports time when time crossed first', () => {
    const crossing = firstBudgetCrossing({
      time: { used: 100 * 60_000, limit: 120 * 60_000 },
      tool_calls: { used: 10, limit: 300 },
    }, 0.8)
    expect(crossing?.kind).toBe('time')
  })

  it('picks the budget closest to exhaustion when several crossed at once', () => {
    const crossing = firstBudgetCrossing({
      time: { used: 90, limit: 100 },
      tool_calls: { used: 285, limit: 300 },
      input_tokens: { used: 81, limit: 100 },
    }, 0.8)
    expect(crossing?.kind).toBe('tool_calls')
  })

  it('ignores disabled budgets and an invalid fraction', () => {
    expect(firstBudgetCrossing({ tool_calls: { used: 1000, limit: 0 } }, 0.8)).toBeNull()
    expect(firstBudgetCrossing({ tool_calls: { used: 1000, limit: 300 } }, 0)).toBeNull()
    expect(firstBudgetCrossing({ tool_calls: { used: 1000, limit: 300 } }, 1)).toBeNull()
  })
})

describe('buildBudgetWarningMessage', () => {
  it('names the budget and makes the interim state mandatory', () => {
    const msg = buildBudgetWarningMessage({ kind: 'tool_calls', used: 240, limit: 300, ratio: 0.8 })
    expect(msg).toContain('<time_budget_warning budget="tool_calls">')
    expect(msg).toContain('tool call budget is 80 %')
    expect(msg).toContain('240 calls of 300 calls')
    expect(msg).toContain('Write your interim state NOW')
    expect(msg).toContain('HANDOFF')
  })
})

describe('TaskActivityLog + buildAbortHandoff', () => {
  it('keeps the last calls, the per-tool counts and the written paths', () => {
    const log = new TaskActivityLog(3)
    log.record('write_file', { path: '/workspace/w/a.ts', content: 'x' }, 'ok', false, 1000)
    log.record('edit_file', { path: '/workspace/w/b.ts' }, { content: [{ type: 'text', text: 'edited' }] }, false, 2000)
    log.record('write_file', { path: '/workspace/w/failed.ts' }, 'Error: denied', true, 3000)
    log.record('shell', { command: 'npx vitest run' }, 'Tests 3 passed', false, 4000)
    log.record('write_file', { path: '/workspace/w/a.ts' }, 'ok', false, 5000)

    expect(log.writtenPaths()).toEqual(['/workspace/w/a.ts', '/workspace/w/b.ts'])
    expect(log.recent()).toEqual([
      { toolName: 'write_file', at: 3000, isError: true },
      { toolName: 'shell', at: 4000, isError: false },
      { toolName: 'write_file', at: 5000, isError: false },
    ])
    expect(log.toolCounts()).toEqual([
      { toolName: 'write_file', calls: 3, errors: 1 },
      { toolName: 'edit_file', calls: 1, errors: 0 },
      { toolName: 'shell', calls: 1, errors: 0 },
    ])
  })

  it('stores no argument and no result text at all', () => {
    const log = new TaskActivityLog()
    log.record('email_read', { uid: 1 }, 'PRIVATE BODY', false)
    log.record('shell', { command: 'echo ARGVALUE' }, 'RESULTVALUE', false)
    const dump = JSON.stringify({ r: log.recent(), c: log.toolCounts(), w: log.writtenPaths() })
    expect(dump).not.toContain('PRIVATE')
    expect(dump).not.toContain('ARGVALUE')
    expect(dump).not.toContain('RESULTVALUE')
  })

  it('produces a value-free HANDOFF section the handoff extractor recognises', () => {
    const log = new TaskActivityLog()
    log.record('write_file', { path: '/workspace/w/report.md' }, 'ok', false, Date.UTC(2026, 9, 24, 10, 0, 0))
    log.record('shell', { command: 'git log -1' }, 'abc123 commit', true, Date.UTC(2026, 9, 24, 10, 0, 5))
    const text = buildAbortHandoff({
      errorClass: 'tool_call_budget',
      taskId: 'task-1',
      toolCalls: 300,
      activity: log,
      warned: true,
    })
    expect(text).not.toContain('No result was produced')
    expect(text.startsWith(`${ABORT_HANDOFF_HEAD} tool_call_budget`)).toBe(true)
    const section = extractHandoffSection(text)
    expect(section).not.toBeNull()
    expect(section).toContain('- /workspace/w/report.md')
    expect(section).toContain('- shell: 1 call(s), 1 error(s)')
    expect(section).toContain('- 2026-10-24T10:00:05.000Z shell error')
    expect(section).toContain('- 2026-10-24T10:00:00.000Z write_file ok')
    expect(section).toContain(ABORT_HANDOFF_WRAPUP_NOTE)
    expect(section).toContain('budget warning had been sent')
    expect(section).not.toContain('git log')
    expect(section).not.toContain('abc123')
  })

  it('caps the whole abort handoff', () => {
    const log = new TaskActivityLog(8, 400)
    for (let i = 0; i < 400; i++) log.record('write_file', { path: `/workspace/${'d'.repeat(15)}/${i}.md` }, 'ok', false)
    const text = buildAbortHandoff({ errorClass: 'tool_call_budget', taskId: 'big', toolCalls: 400, activity: log, warned: false })
    expect(text.length).toBeLessThanOrEqual(MAX_ABORT_HANDOFF_CHARS + 1)
  })
})

describe('handoffPath / handoffToolName (S0-A second review: only value-free metadata)', () => {
  it('shows paths under the three roots and withholds everything else', () => {
    expect(handoffPath('/workspace/proj/notes.md')).toBe('/workspace/proj/notes.md')
    expect(handoffPath('/mnt/workspace/x/report.md')).toBe('/mnt/workspace/x/report.md')
    expect(handoffPath('/data/memory/MEMORY.md')).toBe('/data/memory/MEMORY.md')
    expect(handoffPath('/tmp/a.txt')).toBeNull()
    expect(handoffPath('/workspacefoo/a.txt')).toBeNull()
    expect(handoffPath('/workspace/../etc/passwd')).toBeNull()
    expect(handoffPath('relative/a.txt')).toBeNull()
    expect(handoffPath(42)).toBeNull()
  })

  it('checks the whole part below the root and shows only the root when it fails (S0-A third review)', () => {
    // A run of 12+ alphanumerics with a digit anywhere: root only.
    expect(handoffPath('/workspace/proj/Ab12Cd34Ef56.txt')).toBe('/workspace/')
    expect(handoffPath('/workspace/Ab12Cd34Ef56Gh78/notes.md')).toBe('/workspace/')
    // A value split over several short segments: more than 3 segments.
    expect(handoffPath('/workspace/ab12cd/ef34gh/ij56kl/mn78op.txt')).toBe('/workspace/')
    // More than 48 characters below the root.
    expect(handoffPath(`/workspace/proj/${'a-'.repeat(25)}.md`)).toBe('/workspace/')
    // Encoded separators, unicode letters or line separators: root only.
    expect(handoffPath('/workspace/p/%2e%2e/x.md')).toBe('/workspace/')
    expect(handoffPath('/workspace/p/\u00e9t\u00e9.md')).toBe('/workspace/')
    expect(handoffPath('/workspace/p/a\u2028b.md')).toBe('/workspace/')
    // `..` is rejected outright, even when it stays under a root.
    expect(handoffPath('/workspace/p/../other/x.md')).toBeNull()
    // 11 in a row with digits, 12+ letters only, or separators: kept.
    expect(handoffPath('/workspace/proj/Ab12Cd34Ef5.txt')).toBe('/workspace/proj/Ab12Cd34Ef5.txt')
    expect(handoffPath('/workspace/proj/task-budget-test.ts')).toBe('/workspace/proj/task-budget-test.ts')
    expect(handoffPath('/workspace/offtangent/packages/README.md')).toBe('/workspace/offtangent/packages/README.md')
    expect(handoffPath('/workspace')).toBe('/workspace')
  })

  it('maps runner reasons onto the closed error vocabulary', () => {
    expect(classifyHandoffError('Max duration exceeded')).toBe('timeout')
    expect(classifyHandoffError('Progress guard: the task hit the tool call cap of 6 calls')).toBe('tool_call_budget')
    expect(classifyHandoffError('Loop detected (systematic): Tool "x" produced the same error')).toBe('loop_detected')
    expect(classifyHandoffError('LLM API error 429 rate limit')).toBe('provider_error')
    expect(classifyHandoffError('Aborted by user')).toBe('cancelled')
    expect(classifyHandoffError('ENOENT: no such file /workspace/a/b')).toBe('unknown')
    expect(classifyHandoffError(undefined)).toBe('unknown')
    for (const c of ['timeout', 'tool_call_budget', 'token_budget', 'repeated_call', 'provider_error', 'cancelled', 'unknown']) {
      expect(HANDOFF_ERROR_CLASSES).toContain(c)
    }
  })

  it('reduces odd tool names to a constant', () => {
    expect(handoffToolName('write_file')).toBe('write_file')
    expect(handoffToolName('mcp__github__create_issue')).toBe('mcp__github__create_issue')
    expect(handoffToolName('Ab12Cd34Ef56Gh78Ij')).toBe('other_tool')
    expect(handoffToolName('echo secret')).toBe('other_tool')
    expect(handoffToolName(undefined)).toBe('other_tool')
    // 12+ alphanumerics with a digit, or not a registered tool of the run.
    expect(handoffToolName('tool_Ab12Cd34Ef56')).toBe('other_tool')
    expect(handoffToolName('shell', new Set(['shell']))).toBe('shell')
    expect(handoffToolName('madeup', new Set(['shell']))).toBe('other_tool')
  })
})
