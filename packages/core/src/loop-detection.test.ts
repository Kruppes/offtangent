import { describe, it, expect } from 'vitest'
import {
  ToolCallTracker,
  buildSmartDetectionPrompt,
  parseSmartDetectionResponse,
  resolveDetectionMethod,
  formatPeriodicStatusUpdate,
  isFailedToolResult,
} from './loop-detection.js'
import type { LoopDetectionConfig } from './loop-detection.js'

describe('ToolCallTracker', () => {
  describe('systematic loop detection', () => {
    it('detects loop when same tool+args produce same error N consecutive times', () => {
      const tracker = new ToolCallTracker()

      // 3 identical error calls
      tracker.record('bash', { command: 'npm test' }, 'Error: test failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: test failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: test failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(true)
      expect(result.method).toBe('systematic')
      expect(result.details).toContain('bash')
      expect(result.details).toContain('3 consecutive times')
    })

    it('does not trigger on different errors', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'Error: test 1 failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: test 2 failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: test 3 failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })

    it('does not trigger on different tool names', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('read', { path: 'file.ts' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })

    it('does not trigger on successful calls (not errors)', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'All tests passed', false)
      tracker.record('bash', { command: 'npm test' }, 'All tests passed', false)
      tracker.record('bash', { command: 'npm test' }, 'All tests passed', false)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })

    it('does not trigger when fewer calls than threshold', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })

    it('detects loop with configurable threshold', () => {
      const tracker = new ToolCallTracker()

      // 5 identical errors
      for (let i = 0; i < 5; i++) {
        tracker.record('write', { path: 'file.ts' }, 'Error: permission denied', true)
      }

      const result = tracker.checkSystematicLoop(5)
      expect(result.loopDetected).toBe(true)
    })

    it('no false positive when errors are interspersed with successes', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm test' }, 'All tests passed', false)
      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })

    it('detects loop after initial success followed by consecutive errors', () => {
      const tracker = new ToolCallTracker()

      // Success first
      tracker.record('bash', { command: 'npm test' }, 'All tests passed', false)

      // Then 3 identical errors
      tracker.record('bash', { command: 'npm test' }, 'Error: timeout', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: timeout', true)
      tracker.record('bash', { command: 'npm test' }, 'Error: timeout', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(true)
    })

    it('does not trigger when different args produce same error', () => {
      const tracker = new ToolCallTracker()

      tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm run build' }, 'Error: failed', true)
      tracker.record('bash', { command: 'npm lint' }, 'Error: failed', true)

      const result = tracker.checkSystematicLoop(3)
      expect(result.loopDetected).toBe(false)
    })
  })

  describe('history tracking', () => {
    it('records and returns history', () => {
      const tracker = new ToolCallTracker()
      tracker.record('bash', { command: 'ls' }, 'file1.ts', false)
      tracker.record('read', { path: 'file1.ts' }, 'content', false)

      expect(tracker.getHistory()).toHaveLength(2)
      expect(tracker.getCount()).toBe(2)
    })

    it('trims history to max size', () => {
      const tracker = new ToolCallTracker(5)

      for (let i = 0; i < 10; i++) {
        tracker.record('bash', { i }, `output-${i}`, false)
      }

      expect(tracker.getHistory()).toHaveLength(5)
      expect(tracker.getCount()).toBe(5)
    })
  })
})

// Use one failure classifier for task runner, chat
// runtime and codemode, so `details.error` without `isError` counts as failed.
describe('isFailedToolResult', () => {
  it('treats the pi-agent-core isError flag as a failure', () => {
    expect(isFailedToolResult(true, { content: [], details: {} })).toBe(true)
  })

  it('treats a result with details.error as a failure even when isError is false', () => {
    expect(isFailedToolResult(false, { content: [{ type: 'text', text: 'Could not find edits[0].oldText' }], details: { error: true } })).toBe(true)
    expect(isFailedToolResult(undefined, { content: [], details: { error: true, refused: true } })).toBe(true)
  })

  it('keeps the old text prefix rule for string results', () => {
    expect(isFailedToolResult(undefined, 'Error: boom')).toBe(true)
    expect(isFailedToolResult(false, 'ok')).toBe(false)
  })

  it('does not treat regular results as failures', () => {
    expect(isFailedToolResult(false, { content: [{ type: 'text', text: 'ok' }], details: { exitCode: 0 } })).toBe(false)
    expect(isFailedToolResult(false, { content: [], details: { error: 'not a boolean flag' } })).toBe(false)
    expect(isFailedToolResult(false, { content: [], details: { error: false } })).toBe(false)
    expect(isFailedToolResult(false, { content: [] })).toBe(false)
    expect(isFailedToolResult(false, null)).toBe(false)
    expect(isFailedToolResult(undefined, undefined)).toBe(false)
  })

  it('lets the tracker detect a loop of details.error results', () => {
    const tracker = new ToolCallTracker()
    const result = { content: [{ type: 'text', text: 'Could not find edits[0].oldText' }], details: { error: true } }
    for (let i = 0; i < 3; i++) {
      tracker.record('edit_file', { path: 'a.ts' }, JSON.stringify(result), isFailedToolResult(false, result))
    }
    expect(tracker.checkSystematicLoop(3).loopDetected).toBe(true)
  })
})

describe('buildSmartDetectionPrompt', () => {
  it('builds a prompt with recent tool call history', () => {
    const tracker = new ToolCallTracker()
    tracker.record('bash', { command: 'npm test' }, 'Error: failed', true)
    tracker.record('read', { path: 'file.ts' }, 'file content', false)

    const prompt = buildSmartDetectionPrompt(tracker.getHistory())
    expect(prompt).toContain('PROGRESS or LOOP')
    expect(prompt).toContain('[ERROR] bash')
    expect(prompt).toContain('[OK] read')
  })
})

describe('parseSmartDetectionResponse', () => {
  it('detects LOOP response', () => {
    const result = parseSmartDetectionResponse('LOOP')
    expect(result.loopDetected).toBe(true)
    expect(result.method).toBe('smart')
  })

  it('detects PROGRESS response', () => {
    const result = parseSmartDetectionResponse('PROGRESS')
    expect(result.loopDetected).toBe(false)
    expect(result.method).toBe('smart')
  })

  it('handles response with extra text containing LOOP', () => {
    const result = parseSmartDetectionResponse('Based on my analysis, the agent is in a LOOP.')
    expect(result.loopDetected).toBe(true)
  })

  it('handles response with extra text containing PROGRESS', () => {
    const result = parseSmartDetectionResponse('The agent is making PROGRESS.')
    expect(result.loopDetected).toBe(false)
  })

  it('defaults to no loop for ambiguous response', () => {
    const result = parseSmartDetectionResponse('I am not sure')
    expect(result.loopDetected).toBe(false)
  })
})

describe('resolveDetectionMethod', () => {
  it('returns none when disabled', () => {
    const config: LoopDetectionConfig = { enabled: false, method: 'systematic', maxConsecutiveFailures: 3 }
    expect(resolveDetectionMethod(config, 0)).toBe('none')
  })

  it('returns systematic for systematic method', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'systematic', maxConsecutiveFailures: 3 }
    expect(resolveDetectionMethod(config, 0)).toBe('systematic')
  })

  it('returns smart for smart method with provider', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'smart', maxConsecutiveFailures: 3, smartProvider: 'openai' }
    expect(resolveDetectionMethod(config, 0)).toBe('smart')
  })

  it('falls back to systematic for smart method without provider', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'smart', maxConsecutiveFailures: 3 }
    expect(resolveDetectionMethod(config, 0)).toBe('systematic')
  })

  it('auto mode uses systematic by default', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'auto', maxConsecutiveFailures: 3 }
    expect(resolveDetectionMethod(config, 5)).toBe('systematic')
  })

  it('auto mode switches to smart with provider and enough tool calls', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'auto', maxConsecutiveFailures: 3, smartProvider: 'openai' }
    expect(resolveDetectionMethod(config, 15)).toBe('smart')
  })

  it('auto mode stays systematic with provider but few tool calls', () => {
    const config: LoopDetectionConfig = { enabled: true, method: 'auto', maxConsecutiveFailures: 3, smartProvider: 'openai' }
    expect(resolveDetectionMethod(config, 5)).toBe('systematic')
  })
})

describe('formatPeriodicStatusUpdate', () => {
  it('formats a status update message', () => {
    const msg = formatPeriodicStatusUpdate(
      'abc-123-def',
      'Build website',
      15,
      42,
      8500,
    )

    expect(msg).toContain('task_id="abc-123-def"')
    expect(msg).toContain('periodic_update')
    expect(msg).toContain('"Build website"')
    expect(msg).toContain('15 min')
    expect(msg).toContain('42 tool calls')
    expect(msg).toContain('~8500 tokens')
    expect(msg).toContain('/kill_task abc-123-def')
    expect(msg).toContain('get_task')
    expect(msg).toContain('steer_task')
    expect(msg).toContain('cancel_task')
  })

  it('uses truncated task ID in readable text', () => {
    const msg = formatPeriodicStatusUpdate(
      '12345678-abcd-efgh-1234',
      'My Task',
      5,
      10,
      1000,
    )

    expect(msg).toContain('#12345678')
  })
})

describe('periodic status update timing', () => {
  it('status update interval is configurable and message is metadata-only', () => {
    // This tests that the format doesn't require an LLM call
    // and is assembled purely from task metadata
    const msg = formatPeriodicStatusUpdate(
      'task-id-1',
      'Test Task',
      30,
      100,
      25000,
    )

    // Verify it's a simple XML-formatted string (no LLM reasoning needed)
    expect(msg).toMatch(/^<task_status/)
    expect(msg).toMatch(/<\/task_status>$/)

    // Verify it contains all required metadata
    expect(msg).toContain('task_id="task-id-1"')
    expect(msg).toContain('Test Task')
    expect(msg).toContain('30 min')
    expect(msg).toContain('100 tool calls')
    expect(msg).toContain('~25000 tokens')
    expect(msg).toContain('/kill_task task-id-1')
  })
})
