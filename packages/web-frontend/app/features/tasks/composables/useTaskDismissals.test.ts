import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Task } from '~/api/tasks'
import { DISMISS_CHUNK, groupByStrand, isTaskDismissable, useTaskDismissals } from './useTaskDismissals'

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id, name: `Task ${id}`, prompt: 'p', status: 'completed', triggerType: 'user', triggerSourceId: null,
    provider: null, model: null, isDefaultModel: null, maxDurationMinutes: null, promptTokens: 0, completionTokens: 0,
    cacheRead: 0, cacheWrite: 0, estimatedCost: 0, toolCallCount: 0, resultSummary: null, resultStatus: 'completed',
    errorMessage: null, createdAt: '2026-10-03T10:00:00.000Z', startedAt: null, completedAt: null, sessionId: null,
    strandId: 'strand-a', dismissedAt: null, ...patch,
  }
}

function api() {
  return {
    dismissActivity: vi.fn(async (_strandId: string, ids: string[]) => ({ dismissed: ids, dismissedAt: '2026-10-03T12:00:00.000Z' })),
    undismissActivity: vi.fn(async (_strandId: string, ids: string[]) => ({ restored: ids })),
  }
}

describe('isTaskDismissable', () => {
  it('only offers finished tasks of a strand that are not yet dismissed', () => {
    expect(isTaskDismissable(task('a'))).toBe(true)
    expect(isTaskDismissable(task('b', { status: 'failed' }))).toBe(true)
    expect(isTaskDismissable(task('c', { status: 'running' }))).toBe(false)
    expect(isTaskDismissable(task('d', { status: 'paused' }))).toBe(false)
    expect(isTaskDismissable(task('e', { strandId: null }))).toBe(false)
    expect(isTaskDismissable(task('f', { strandId: undefined }))).toBe(false)
    expect(isTaskDismissable(task('g', { dismissedAt: '2026-10-03T11:00:00.000Z' }))).toBe(false)
  })
})

describe('groupByStrand', () => {
  it('sends one request per strand and cuts at the server cap', () => {
    const many = Array.from({ length: DISMISS_CHUNK + 5 }, (_, i) => ({ id: `t${i}`, strandId: 's1' }))
    const groups = groupByStrand([...many, { id: 'x', strandId: 's2' }, { id: 'x', strandId: 's2' }])
    expect(groups.map(g => [g.strandId, g.ids.length])).toEqual([['s1', DISMISS_CHUNK], ['s1', 5], ['s2', 1]])
  })
})

describe('useTaskDismissals', () => {
  it('dismisses tasks of several strands grouped per strand, hides them and undoes', async () => {
    const tasks = ref([
      task('a1', { strandId: 'strand-a' }),
      task('a2', { strandId: 'strand-a', status: 'failed' }),
      task('b1', { strandId: 'strand-b' }),
      task('live', { strandId: 'strand-b', status: 'running' }),
      task('cron', { strandId: null }),
    ])
    const fake = api()
    const ack = useTaskDismissals(tasks, fake)
    expect(ack.dismissable.value.map(t => t.id)).toEqual(['a1', 'a2', 'b1'])

    expect(await ack.dismiss(tasks.value)).toBe(true)
    expect(fake.dismissActivity).toHaveBeenCalledTimes(2)
    expect(fake.dismissActivity).toHaveBeenCalledWith('strand-a', ['a1', 'a2'])
    expect(fake.dismissActivity).toHaveBeenCalledWith('strand-b', ['b1'])
    expect(ack.visible(tasks.value).map(t => t.id)).toEqual(['live', 'cron'])
    expect(ack.hidden.value).toHaveLength(3)
    expect(ack.lastDismissed.value).toHaveLength(3)

    ack.showHidden.value = true
    expect(ack.visible(tasks.value)).toHaveLength(5)

    expect(await ack.undo()).toBe(true)
    expect(fake.undismissActivity).toHaveBeenCalledWith('strand-a', ['a1', 'a2'])
    expect(fake.undismissActivity).toHaveBeenCalledWith('strand-b', ['b1'])
    expect(ack.hidden.value).toHaveLength(0)
    expect(ack.lastDismissed.value).toBeNull()
  })

  it('never sends a running, paused or strandless task', async () => {
    const tasks = ref([task('live', { status: 'running' }), task('wait', { status: 'paused' }), task('cron', { strandId: null })])
    const fake = api()
    const ack = useTaskDismissals(tasks, fake)
    expect(await ack.dismiss(tasks.value)).toBe(false)
    expect(fake.dismissActivity).not.toHaveBeenCalled()
  })

  it('keeps the strands that went through when another strand fails', async () => {
    const tasks = ref([task('a1', { strandId: 'strand-a' }), task('b1', { strandId: 'strand-b' })])
    const fake = api()
    fake.dismissActivity.mockImplementationOnce(async () => { throw new Error('409') })
    const ack = useTaskDismissals(tasks, fake)
    expect(await ack.dismiss(tasks.value)).toBe(true)
    expect(ack.error.value).toBe(true)
    expect(ack.visible(tasks.value).map(t => t.id)).toEqual(['a1'])
    expect(ack.lastDismissed.value).toEqual([{ id: 'b1', strandId: 'strand-b' }])
  })

  it('reports an error and hides nothing when every request fails', async () => {
    const tasks = ref([task('a1')])
    const fake = api()
    fake.dismissActivity.mockRejectedValue(new Error('offline'))
    const ack = useTaskDismissals(tasks, fake)
    expect(await ack.dismiss(tasks.value)).toBe(false)
    expect(ack.error.value).toBe(true)
    expect(ack.visible(tasks.value)).toHaveLength(1)
    expect(ack.lastDismissed.value).toBeNull()
  })

  it('takes server truth from the next poll and restores a single hidden task', async () => {
    const tasks = ref([task('a1', { dismissedAt: '2026-10-03T11:00:00.000Z' })])
    const fake = api()
    const ack = useTaskDismissals(tasks, fake)
    expect(ack.hidden.value).toHaveLength(1)
    expect(await ack.restoreTask(tasks.value[0]!)).toBe(true)
    expect(fake.undismissActivity).toHaveBeenCalledWith('strand-a', ['a1'])
    expect(ack.hidden.value).toHaveLength(0)
    // The poll confirms the restore: the overlay entry is dropped, the row stays visible.
    tasks.value = [task('a1', { dismissedAt: null })]
    await nextTick()
    expect(ack.hidden.value).toHaveLength(0)
  })
})
