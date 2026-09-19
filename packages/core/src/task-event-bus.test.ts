import { describe, it, expect, vi } from 'vitest'
import { TaskEventBus } from './task-event-bus.js'
import type { TaskEvent } from './task-event-bus.js'

describe('TaskEventBus', () => {
  it('emits events to subscribers for a specific task', () => {
    const bus = new TaskEventBus()
    const handler = vi.fn()

    bus.subscribeToTask('task-1', handler)

    const event: TaskEvent = {
      type: 'tool_call_start',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
      toolName: 'bash',
      toolCallId: 'tc-1',
    }

    bus.emitTaskEvent(event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it('does not emit events to subscribers of other tasks', () => {
    const bus = new TaskEventBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    bus.subscribeToTask('task-1', handler1)
    bus.subscribeToTask('task-2', handler2)

    bus.emitTaskEvent({
      type: 'text_delta',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
      text: 'hello',
    })

    expect(handler1).toHaveBeenCalledTimes(1)
    expect(handler2).not.toHaveBeenCalled()
  })

  it('stores backlog and returns it for late joiners', () => {
    const bus = new TaskEventBus()

    bus.emitTaskEvent({
      type: 'tool_call_start',
      taskId: 'task-1',
      timestamp: '2024-01-01T00:00:00Z',
      toolName: 'bash',
    })
    bus.emitTaskEvent({
      type: 'tool_call_end',
      taskId: 'task-1',
      timestamp: '2024-01-01T00:00:01Z',
      toolName: 'bash',
      durationMs: 100,
    })

    const backlog = bus.getBacklog('task-1')
    expect(backlog).toHaveLength(2)
    expect(backlog[0].type).toBe('tool_call_start')
    expect(backlog[1].type).toBe('tool_call_end')
  })

  it('returns empty backlog for unknown task', () => {
    const bus = new TaskEventBus()
    expect(bus.getBacklog('nonexistent')).toEqual([])
  })

  it('clears backlog', () => {
    const bus = new TaskEventBus()
    bus.emitTaskEvent({
      type: 'status_change',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
      status: 'completed',
    })

    expect(bus.getBacklog('task-1')).toHaveLength(1)
    bus.clearBacklog('task-1')
    expect(bus.getBacklog('task-1')).toEqual([])
  })

  it('unsubscribe stops receiving events', () => {
    const bus = new TaskEventBus()
    const handler = vi.fn()

    const unsubscribe = bus.subscribeToTask('task-1', handler)
    bus.emitTaskEvent({
      type: 'text_delta',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
      text: 'first',
    })
    expect(handler).toHaveBeenCalledTimes(1)

    unsubscribe()
    bus.emitTaskEvent({
      type: 'text_delta',
      taskId: 'task-1',
      timestamp: new Date().toISOString(),
      text: 'second',
    })
    expect(handler).toHaveBeenCalledTimes(1) // Still 1
  })

  it('hasSubscribers returns correct status', () => {
    const bus = new TaskEventBus()
    expect(bus.hasSubscribers('task-1')).toBe(false)

    const unsub = bus.subscribeToTask('task-1', () => {})
    expect(bus.hasSubscribers('task-1')).toBe(true)

    unsub()
    expect(bus.hasSubscribers('task-1')).toBe(false)
  })
})
