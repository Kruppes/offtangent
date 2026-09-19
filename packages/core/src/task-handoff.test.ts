import { describe, it, expect } from 'vitest'
import {
  buildTaskHandoff,
  extractHandoffSection,
  formatContinuationContext,
  MAX_CONTINUATION_CHARS,
  MAX_HANDOFF_CHARS,
} from './task-handoff.js'
import type { Task } from './task-store.js'

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
    agentId: 'bob',
    createdAt: '2026-09-17 14:00:00',
    startedAt: '2026-09-17 14:00:00',
    completedAt: '2026-09-17 14:30:00',
    attachedSkills: null,
    outputSchema: null,
    contextMode: null,
    handoff: null,
    agentNotifiedAt: null,
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
      reason: 'timeout',
      durationMinutes: 30,
    })
    expect(handoff).toContain('Task: Port the runner (task-1)')
    expect(handoff).toContain('hard max-duration abort')
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

  it('handles a run that produced nothing', () => {
    const handoff = buildTaskHandoff({ task: makeTask(), reason: 'progress_guard', errorMessage: 'tool call cap 300 reached' })
    expect(handoff).toContain('progress guard tripped')
    expect(handoff).toContain('Error: tool call cap 300 reached')
    expect(handoff).toContain('No result text was produced')
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
    expect(block).toContain('name="Port the runner"')
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

  it('keeps the attribute safe when the name contains quotes or newlines', () => {
    const block = formatContinuationContext(makeTask({ name: 'He said "hi"\nand left' }))
    expect(block).toContain(`name="He said 'hi' and left"`)
  })
})
