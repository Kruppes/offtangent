import { describe, it, expect } from 'vitest'
import {
  buildTaskHandoff,
  extractHandoffSection,
  formatContinuationContext,
  MAX_CONTINUATION_CHARS,
  MAX_HANDOFF_CHARS,
} from './task-handoff.js'
import type { Task } from './task-store.js'
import { ABORT_HANDOFF_HEAD } from './task-budget.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Port the runner',
    prompt: 'Do the port',
    status: 'failed',
    triggerType: 'agent',
    triggerSourceId: null,
    provider: 'test',
    model: 'test-model',
    isDefaultModel: null,
    resultStatus: 'failed',
    resultSummary: null,
    errorMessage: null,
    promptTokens: 0,
    completionTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    estimatedCost: 0,
    toolCallCount: 17,
    maxDurationMinutes: 30,
    parentTaskId: null,
    sessionId: 'sess-1',
    parentSessionId: null,
    agentId: 'coder',
    createdAt: '2026-09-17 14:00:00',
    startedAt: '2026-09-17 14:00:00',
    completedAt: '2026-09-17 14:30:00',
    attachedSkills: null,
    outputSchema: null,
    contextMode: null,
    handoff: null,
    agentNotifiedAt: null,
    thinkingLevel: null,
    routing: null,
    ...overrides,
  } as Task
}

describe('extractHandoffSection', () => {
  it('finds a markdown heading', () => {
    const section = extractHandoffSection('Some result\n\n## Handoff\nOpen: tests still red')
    expect(section).toBe('## Handoff\nOpen: tests still red')
  })

  it('finds an inline HANDOFF: prefix', () => {
    const section = extractHandoffSection('Result text\nHANDOFF: next step is the lint fix')
    expect(section).toBe('HANDOFF: next step is the lint fix')
  })

  it('finds a bold handoff label', () => {
    expect(extractHandoffSection('x\n**Handoff**\nopen work')).toBe('**Handoff**\nopen work')
  })

  it('returns null without a section', () => {
    expect(extractHandoffSection('All done, no open work')).toBeNull()
    expect(extractHandoffSection(null)).toBeNull()
    expect(extractHandoffSection('')).toBeNull()
  })

  it('does not match the word inside a sentence', () => {
    expect(extractHandoffSection('I wrote a handoff document earlier.')).toBeNull()
  })
})

describe('buildTaskHandoff', () => {
  it('records the reason, the run stats and the agent\'s own handoff section', () => {
    const handoff = buildTaskHandoff({
      task: makeTask({ resultSummary: 'Did half of it.\n\nHANDOFF: finish the migration in task-store.ts' }),
      reason: 'wrap_up',
      durationMinutes: 30,
    })
    // S0-A third review: only the task id, never the free-text name.
    expect(handoff).toContain('Task: task-1')
    expect(handoff).not.toContain('Port the runner')
    expect(handoff).toContain('wrap-up signal was sent')
    expect(handoff).toContain('Ran: 30 min of 30 min budget, 17 tool calls')
    expect(handoff).toContain('HANDOFF: finish the migration in task-store.ts')
    // The prose before the section is not the handoff.
    expect(handoff).not.toContain('Did half of it')
  })

  it('falls back to the summary when the task wrote no handoff section', () => {
    const handoff = buildTaskHandoff({
      task: makeTask({ resultSummary: 'Everything failed at the build step.' }),
      reason: 'reported_failed',
    })
    expect(handoff).toContain('No explicit HANDOFF section')
    expect(handoff).toContain('Everything failed at the build step.')
  })

  it('handles a run that produced nothing, naming only the error class', () => {
    const handoff = buildTaskHandoff({ task: makeTask(), reason: 'progress_guard', errorMessage: 'tool call cap 300 reached' })
    expect(handoff).toContain('progress guard tripped')
    expect(handoff).toContain('Error class: tool_call_budget')
    expect(handoff).not.toContain('cap 300 reached')
    expect(handoff).toContain('no agent-written state was recorded')
  })

  it('takes no runner free text when the runner ended the run (S0-A third review)', () => {
    const handoff = buildTaskHandoff({
      task: makeTask({ resultSummary: 'Killed by Zq9 reason\nHANDOFF: Zq9 copied text' }),
      reason: 'timeout',
      errorMessage: 'network error on https://x.example/?token=Zq9',
      durationMinutes: 30,
    })
    expect(handoff).toContain('hard max-duration abort')
    expect(handoff).toContain('Error class: provider_error')
    expect(handoff).not.toContain('Zq9')
  })

  it('keeps the runner-built abort HANDOFF of a runner-ended run', () => {
    const handoff = buildTaskHandoff({
      task: makeTask({ resultSummary: `${ABORT_HANDOFF_HEAD} timeout\n\nHANDOFF:\nFiles written in this run:\n- none recorded` }),
      reason: 'timeout',
    })
    expect(handoff).toContain('HANDOFF:\nFiles written in this run:')
  })

  it('caps the stored record', () => {
    const handoff = buildTaskHandoff({
      task: makeTask({ resultSummary: `HANDOFF:\n${'x'.repeat(40_000)}` }),
      reason: 'wrap_up',
    })
    expect(handoff.length).toBeLessThanOrEqual(MAX_HANDOFF_CHARS + 60)
    expect(handoff).toContain('truncated')
  })
})

describe('formatContinuationContext', () => {
  it('marks the predecessor state as foreign and includes the handoff', () => {
    const block = formatContinuationContext(makeTask({ handoff: 'Open: P3 test missing' }))
    expect(block).toContain('<continuation_of task_id="task-1"')
    expect(block).not.toContain('Port the runner')
    expect(block).toContain('status="failed"')
    expect(block).toContain('Open: P3 test missing')
    expect(block).toContain('</continuation_of>')
    expect(block).toMatch(/verify claims/i)
  })

  it('falls back to the summary when there is no handoff', () => {
    const block = formatContinuationContext(makeTask({ resultSummary: 'Everything is done except docs.' }))
    expect(block).toContain('Final summary of the predecessor')
    expect(block).toContain('Everything is done except docs.')
  })

  it('states it plainly when the predecessor left nothing', () => {
    expect(formatContinuationContext(makeTask())).toContain('neither a handoff nor a summary')
  })

  it('caps the injected block', () => {
    const block = formatContinuationContext(makeTask({ handoff: 'y'.repeat(50_000) }))
    expect(block.length).toBeLessThanOrEqual(MAX_CONTINUATION_CHARS + 60)
    expect(block).toContain('</continuation_of>')
  })

  it('never carries the free-text task name (S0-A third review)', () => {
    const block = formatContinuationContext(makeTask({ name: 'He said "hi"\nand left Zq9' }))
    expect(block).not.toContain('name=')
    expect(block).not.toContain('Zq9')
    expect(block).toContain('<continuation_of task_id="task-1" status="failed">')
  })
})
