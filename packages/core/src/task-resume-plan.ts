/**
 * What the agent should be told after a restart (W4, resume robustness).
 *
 * Two independent facts exist when the process comes back up:
 *
 *  1. `task_injections` rows that are still `pending` — finished tasks whose
 *     result never reached a strand. Those carry their own payload, so the
 *     honest thing is to re-deliver the payload verbatim (see
 *     `formatRedeliveryPayload`), not a summary of it.
 *  2. Tasks that are still `running` — either genuinely alive or restarted by
 *     `TaskRunner.recoverTasks`. Nobody is waiting for them any more: the
 *     session that spawned them died with the container. They need a wake-up
 *     so the agent knows work is still in flight and does not restart it.
 *
 * This module is pure: it turns those two lists into a delivery plan. The
 * decision that costs money is "how many LLM runs does a restart trigger",
 * so it is made here, deterministically, and tested directly.
 */

export interface PendingInjectionSummary {
  id: string
  taskId: string
  sessionId: string
  agentId: string
  userId: number
}

export interface RunningTaskSummary {
  taskId: string
  name: string
  /** The strand the task belongs to, or null for feed-only work. */
  sessionId: string | null
  agentId: string
  userId: number
  triggerType: string
  /** True when `recoverTasks` re-started it after the interruption. */
  resumed?: boolean
}

export interface BootResumeNotice {
  sessionId: string
  agentId: string
  userId: number
  /** Representative task id — the notice row needs one for correlation. */
  taskId: string
  taskIds: string[]
  text: string
}

export interface BootResumePlanInput {
  pendingInjections: PendingInjectionSummary[]
  runningTasks: RunningTaskSummary[]
  /** Tasks listed per notice before the rest is summarised; 0 disables notices. */
  maxNoticeTasks?: number
  /** Hard cap on notices (i.e. on LLM runs) a single boot may trigger. */
  maxNotices?: number
}

export interface BootResumePlan {
  /** Ids of pending injections that should be re-delivered as-is. */
  redeliverIds: string[]
  notices: BootResumeNotice[]
  /**
   * Strand groups that had running tasks but got no notice because a
   * re-delivered result already wakes that strand.
   */
  suppressedByRedelivery: number
  /** Strand groups dropped because `maxNotices` was reached. */
  droppedByCap: number
  /** Running tasks without a strand origin (feed-only). Never notified. */
  feedOnlyRunning: number
}

const DEFAULT_MAX_NOTICE_TASKS = 5
const DEFAULT_MAX_NOTICES = 5

function groupKey(sessionId: string, agentId: string): string {
  return `${agentId}\u0000${sessionId}`
}

/**
 * Build the restart plan.
 *
 * Rule of thumb, and the main trade-off of this module: a strand that already
 * receives a re-delivered task result does NOT additionally get a restart
 * notice. The result itself wakes the agent in that strand, and it can call
 * `list_tasks` for anything still running. One wake-up per strand.
 */
export function planBootResume(input: BootResumePlanInput): BootResumePlan {
  const maxNoticeTasks = input.maxNoticeTasks ?? DEFAULT_MAX_NOTICE_TASKS
  const maxNotices = input.maxNotices ?? DEFAULT_MAX_NOTICES

  const redeliverIds = input.pendingInjections.map(p => p.id)
  const wokenStrands = new Set(input.pendingInjections.map(p => groupKey(p.sessionId, p.agentId)))

  const plan: BootResumePlan = {
    redeliverIds,
    notices: [],
    suppressedByRedelivery: 0,
    droppedByCap: 0,
    feedOnlyRunning: 0,
  }

  if (maxNoticeTasks <= 0) {
    plan.feedOnlyRunning = input.runningTasks.filter(t => !t.sessionId).length
    return plan
  }

  const groups = new Map<string, { sessionId: string; agentId: string; userId: number; tasks: RunningTaskSummary[] }>()
  for (const task of input.runningTasks) {
    if (!task.sessionId) {
      plan.feedOnlyRunning++
      continue
    }
    const key = groupKey(task.sessionId, task.agentId)
    const existing = groups.get(key)
    if (existing) existing.tasks.push(task)
    else groups.set(key, { sessionId: task.sessionId, agentId: task.agentId, userId: task.userId, tasks: [task] })
  }

  for (const [key, group] of groups) {
    if (wokenStrands.has(key)) {
      plan.suppressedByRedelivery++
      continue
    }
    if (plan.notices.length >= maxNotices) {
      plan.droppedByCap++
      continue
    }
    plan.notices.push({
      sessionId: group.sessionId,
      agentId: group.agentId,
      userId: group.userId,
      taskId: group.tasks[0].taskId,
      taskIds: group.tasks.map(t => t.taskId),
      text: formatResumeNotice(group.tasks, maxNoticeTasks),
    })
  }

  return plan
}

/**
 * The synthetic message a restarted container sends into a strand. Framed as
 * a `<task_injection>`-sibling so the agent treats it as a system event, not
 * as a user turn: the user did not say anything, the infrastructure did.
 */
export function formatResumeNotice(tasks: RunningTaskSummary[], maxListed: number): string {
  const listed = tasks.slice(0, Math.max(1, maxListed))
  const rest = tasks.length - listed.length
  const lines = listed.map(t => {
    const resumed = t.resumed ? ', restarted after the interruption' : ''
    return `- "${t.name}" (task ${t.taskId}, trigger ${t.triggerType}${resumed})`
  })
  if (rest > 0) lines.push(`- … and ${rest} more running task(s)`)

  return `<system_injection type="restart_resume" running_tasks="${tasks.length}">
The container was restarted, so the agent session that was working in this strand is gone. No user message triggered this run.

${tasks.length} background task(s) are still running and will deliver their results here when they finish:
${lines.join('\n')}

Pick the work back up where it stopped: check the state with list_tasks before doing anything, do NOT re-start work that is already delegated, and tell the user briefly what is still in flight if that is useful. If there is nothing to do but wait, say so in one short sentence.
</system_injection>`
}
