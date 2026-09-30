import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { useTaskEvents } from './useTaskEvents'

const getTaskEvents = vi.hoisted(() => vi.fn())
vi.mock('~/api/tasks', () => ({ useTasksApi: () => ({ getTaskEvents }) }))

async function setup() {
  let state!: ReturnType<typeof useTaskEvents>
  await renderToString(createSSRApp({ setup() { state = useTaskEvents(); return () => h('div') } }))
  return state
}
const response = (status = 'running', nextSince = 't3-m7', content = 'first') => ({
  task: { id: 'a', name: 'Task', status, promptTokens: 10, completionTokens: 20, estimatedCost: 0.2 },
  nextSince,
  events: content ? [{ type: 'message', timestamp: '2026-01-01T00:00:00Z', content, metadata: { thinking: 'thought' } }] : [],
})

beforeEach(() => { vi.useFakeTimers(); getTaskEvents.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('incremental task timeline', () => {
  it('loads history once, appends cursor deltas, refreshes metrics and stops at completion', async () => {
    getTaskEvents.mockResolvedValueOnce(response()).mockResolvedValueOnce(response('running', 't3-m8', 'second')).mockResolvedValueOnce(response('completed', 't3-m8', ''))
    const state = await setup()
    await state.loadTaskEvents('a')
    expect(getTaskEvents).toHaveBeenNthCalledWith(1, 'a', undefined)
    expect(state.events.value[0]).toMatchObject({ type: 'text_delta', text: 'first', thinking: 'thought' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(getTaskEvents).toHaveBeenNthCalledWith(2, 'a', 't3-m7')
    expect(state.events.value).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(getTaskEvents).toHaveBeenNthCalledWith(3, 'a', 't3-m8')
    expect(state.taskInfo.value?.estimatedCost).toBe(0.2)
    expect(state.isLive.value).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(getTaskEvents).toHaveBeenCalledTimes(3)
    state.disconnect()
  })

  it('retries the same cursor after failure without clearing prior events', async () => {
    getTaskEvents.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(response('completed', 't3-m7', ''))
    const state = await setup()
    await state.loadTaskEvents('a')
    await vi.advanceTimersByTimeAsync(4000)
    expect(getTaskEvents.mock.calls.slice(1)).toEqual([['a', 't3-m7'], ['a', 't3-m7']])
    expect(state.events.value).toHaveLength(1)
    expect(state.error.value).toBeNull()
    state.disconnect()
  })

  it('ignores a late response after task switch and disconnect', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void
    getTaskEvents.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce(response('completed', 't0-m0', 'other'))
    const state = await setup()
    const old = state.loadTaskEvents('a')
    await state.loadTaskEvents('b')
    resolve(response())
    await old
    expect(state.events.value.map(e => e.text)).toEqual(['other'])
    state.disconnect()
    await vi.advanceTimersByTimeAsync(10000)
    expect(getTaskEvents).toHaveBeenCalledTimes(2)
  })
})
