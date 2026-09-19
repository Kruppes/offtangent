/** What a restarted container decides to tell the agent (W4). */
import { describe, it, expect } from 'vitest'
import { planBootResume, formatResumeNotice, type RunningTaskSummary, type PendingInjectionSummary } from './task-resume-plan.js'

function pending(over: Partial<PendingInjectionSummary> = {}): PendingInjectionSummary {
  return { id: 'i1', taskId: 't1', sessionId: 'strand-a', agentId: 'bob', userId: 1, ...over }
}

function running(over: Partial<RunningTaskSummary> = {}): RunningTaskSummary {
  return { taskId: 't9', name: 'Build W4', sessionId: 'strand-a', agentId: 'bob', userId: 1, triggerType: 'agent', ...over }
}

describe('planBootResume', () => {
  it('re-delivers every pending injection', () => {
    const plan = planBootResume({
      pendingInjections: [pending({ id: 'i1' }), pending({ id: 'i2', sessionId: 'strand-b' })],
      runningTasks: [],
    })
    expect(plan.redeliverIds).toEqual(['i1', 'i2'])
    expect(plan.notices).toEqual([])
  })

  it('wakes a strand with running tasks that has no result to deliver', () => {
    const plan = planBootResume({ pendingInjections: [], runningTasks: [running()] })
    expect(plan.notices).toHaveLength(1)
    expect(plan.notices[0]).toMatchObject({ sessionId: 'strand-a', agentId: 'bob', userId: 1, taskId: 't9', taskIds: ['t9'] })
    expect(plan.notices[0].text).toContain('container was restarted')
    expect(plan.notices[0].text).toContain('Build W4')
  })

  it('sends one notice per strand, not per task', () => {
    const plan = planBootResume({
      pendingInjections: [],
      runningTasks: [running({ taskId: 'a' }), running({ taskId: 'b' }), running({ taskId: 'c', sessionId: 'strand-b' })],
    })
    expect(plan.notices.map(n => n.sessionId)).toEqual(['strand-a', 'strand-b'])
    expect(plan.notices[0].taskIds).toEqual(['a', 'b'])
  })

  it('separates personas that share a strand id', () => {
    const plan = planBootResume({
      pendingInjections: [],
      runningTasks: [running({ agentId: 'bob' }), running({ taskId: 'x', agentId: 'main' })],
    })
    expect(plan.notices.map(n => n.agentId)).toEqual(['bob', 'main'])
  })

  it('suppresses the notice when a re-delivered result already wakes that strand', () => {
    const plan = planBootResume({
      pendingInjections: [pending({ sessionId: 'strand-a', agentId: 'bob' })],
      runningTasks: [running({ sessionId: 'strand-a', agentId: 'bob' })],
    })
    expect(plan.notices).toEqual([])
    expect(plan.suppressedByRedelivery).toBe(1)
    expect(plan.redeliverIds).toEqual(['i1'])
  })

  it('still notices a strand whose pending result belongs to another persona', () => {
    const plan = planBootResume({
      pendingInjections: [pending({ sessionId: 'strand-a', agentId: 'main' })],
      runningTasks: [running({ sessionId: 'strand-a', agentId: 'bob' })],
    })
    expect(plan.notices.map(n => n.agentId)).toEqual(['bob'])
    expect(plan.suppressedByRedelivery).toBe(0)
  })

  it('never notices feed-only work (cronjob, heartbeat, consolidation)', () => {
    const plan = planBootResume({
      pendingInjections: [],
      runningTasks: [running({ sessionId: null, triggerType: 'cronjob' }), running({ taskId: 'h', sessionId: null, triggerType: 'heartbeat' })],
    })
    expect(plan.notices).toEqual([])
    expect(plan.feedOnlyRunning).toBe(2)
  })

  it('caps how many strands a single boot may wake', () => {
    const tasks = ['a', 'b', 'c'].map(id => running({ taskId: id, sessionId: `strand-${id}` }))
    const plan = planBootResume({ pendingInjections: [], runningTasks: tasks, maxNotices: 2 })
    expect(plan.notices).toHaveLength(2)
    expect(plan.droppedByCap).toBe(1)
  })

  it('disables notices entirely with maxNoticeTasks = 0 but still re-delivers results', () => {
    const plan = planBootResume({
      pendingInjections: [pending({ sessionId: 'strand-z' })],
      runningTasks: [running(), running({ sessionId: null })],
      maxNoticeTasks: 0,
    })
    expect(plan.notices).toEqual([])
    expect(plan.redeliverIds).toEqual(['i1'])
    expect(plan.feedOnlyRunning).toBe(1)
  })
})

describe('formatResumeNotice', () => {
  it('lists the tasks with trigger and resumed marker', () => {
    const text = formatResumeNotice([running({ taskId: 'abc', resumed: true })], 5)
    expect(text).toContain('running_tasks="1"')
    expect(text).toContain('(task abc, trigger agent, restarted after the interruption)')
    expect(text).toContain('list_tasks')
  })

  it('summarises the tail beyond the display limit', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => running({ taskId: `t${i}` }))
    const text = formatResumeNotice(tasks, 3)
    expect(text).toContain('running_tasks="7"')
    expect(text).toContain('… and 4 more running task(s)')
    expect(text).not.toContain('t5')
  })

  it('is framed as a system injection, not as a user message', () => {
    const text = formatResumeNotice([running()], 5)
    expect(text.startsWith('<system_injection type="restart_resume"')).toBe(true)
    expect(text.trim().endsWith('</system_injection>')).toBe(true)
    expect(text).toContain('No user message triggered this run')
  })
})
