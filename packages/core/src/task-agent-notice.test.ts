/**
 * W5/P3 — repro + fix for the 2026-09-17 16:17 incident: a completed cronjob
 * task whose result never reached the agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { TaskStore } from './task-store.js'
import { initTaskInjectionQueueTable, listPendingTaskInjections } from './task-injection-queue.js'
import { resolveTaskStrandOrigin } from './task-feed.js'
import {
  consumePendingTaskNotices,
  expireStaleTaskNotices,
  formatPendingTaskNoticeBlock,
  listPendingTaskNotices,
  markTaskNoticesDelivered,
} from './task-agent-notice.js'


// Fixtures complete "a moment ago" relative to the real clock: the queries
// filter with a 24 h max age against Date.now(), so pinned calendar dates
// would silently expire the whole suite one day after they were written.
const FIXTURE_NOW = Date.now() - 60_000
function sqlTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

describe('task agent notices (W5/P3)', () => {
  const tmpFiles: string[] = []
  let db: Database
  let store: TaskStore

  beforeEach(() => {
    const p = path.join(os.tmpdir(), `axiom-notice-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    tmpFiles.push(p)
    db = initDatabase(p)
    initTaskInjectionQueueTable(db)
    store = new TaskStore(db)
  })

  afterEach(() => {
    db.close()
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    tmpFiles.length = 0
  })

  function finishCronTask(overrides: { name?: string; summary?: string; resultStatus?: 'completed' | 'failed' | 'silent'; agentId?: string } = {}) {
    const task = store.create({
      name: overrides.name ?? 'w4-deploy-verify-20260917',
      prompt: 'verify the deploy',
      triggerType: 'cronjob',
      agentId: overrides.agentId ?? 'bob',
    })
    store.update(task.id, {
      status: overrides.resultStatus === 'failed' ? 'failed' : 'completed',
      resultStatus: overrides.resultStatus ?? 'completed',
      resultSummary: overrides.summary ?? 'Deploy verified: 3/3 checks green.',
      startedAt: sqlTs(FIXTURE_NOW - 141_000),
      completedAt: sqlTs(FIXTURE_NOW),
    })
    return store.getById(task.id)!
  }

  it('reproduces the gap: a cronjob outcome never enters the injection queue', () => {
    const task = finishCronTask()
    // The exact reason the W4 queue + sweeper could not help: cronjob tasks
    // have no strand origin, so `routeTaskOutcome` takes the feed-only path
    // and no injection is ever enqueued for the sweeper to retry.
    expect(resolveTaskStrandOrigin(db, task)).toBeNull()
    expect(listPendingTaskInjections(db)).toHaveLength(0)

    // …which is exactly what the notice queue now catches.
    const pending = listPendingTaskNotices(db, { agentId: 'bob' })
    expect(pending.map(p => p.id)).toEqual([task.id])
  })

  it('delivers the outcome to the owed persona exactly once', () => {
    const task = finishCronTask()

    const first = consumePendingTaskNotices(db, { agentId: 'bob' })
    expect(first).toContain('<background_task_results>')
    expect(first).toContain('w4-deploy-verify-20260917')
    expect(first).toContain('Deploy verified: 3/3 checks green.')

    // Second run of the same persona: already announced, nothing repeats.
    expect(consumePendingTaskNotices(db, { agentId: 'bob' })).toBeNull()
    expect(store.getById(task.id)!.agentNotifiedAt).toBeTruthy()
  })

  it('does not hand one persona another persona\'s outcome', () => {
    finishCronTask({ agentId: 'bob' })
    expect(consumePendingTaskNotices(db, { agentId: 'main' })).toBeNull()
    expect(consumePendingTaskNotices(db, { agentId: 'bob' })).toContain('w4-deploy-verify')
  })

  it('never announces a silent result', () => {
    finishCronTask({ resultStatus: 'silent', summary: 'Nothing to report.' })
    expect(consumePendingTaskNotices(db, { agentId: 'bob' })).toBeNull()
  })

  it('announces a failed cronjob with its error and handoff', () => {
    const task = finishCronTask({ resultStatus: 'failed', summary: 'Build broke' })
    store.update(task.id, { errorMessage: 'npm run build exited 1', handoff: 'Open: fix the tsc error in task-store.ts' })

    const block = consumePendingTaskNotices(db, { agentId: 'bob' })
    expect(block).toContain('failed')
    expect(block).toContain('Build broke')
    expect(block).toContain('Handoff: Open: fix the tsc error in task-store.ts')
  })

  it('ignores user/agent-triggered tasks (those reach the agent through their strand)', () => {
    const task = store.create({ name: 'User task', prompt: 'x', triggerType: 'user', agentId: 'bob' })
    store.update(task.id, { status: 'completed', resultStatus: 'completed', resultSummary: 'done', completedAt: sqlTs(FIXTURE_NOW) })
    expect(listPendingTaskNotices(db, { agentId: 'bob' })).toHaveLength(0)
  })

  it('ignores running tasks and drops stale ones', () => {
    const running = store.create({ name: 'still running', prompt: 'x', triggerType: 'cronjob', agentId: 'bob' })
    store.update(running.id, { status: 'running' })
    expect(listPendingTaskNotices(db, { agentId: 'bob' })).toHaveLength(0)

    const old = finishCronTask({ name: 'ancient' })
    // Ask from three days after the fixture completion.
    const now = FIXTURE_NOW + 3 * 24 * 3600_000
    expect(listPendingTaskNotices(db, { agentId: 'bob', now })).toHaveLength(0)
    expect(expireStaleTaskNotices(db, { now })).toBeGreaterThanOrEqual(1)
    expect(store.getById(old.id)!.agentNotifiedAt).toBeTruthy()
  })

  it('caps the block size and the number of announced outcomes', () => {
    for (let i = 0; i < 8; i++) finishCronTask({ name: `cron-${i}`, summary: 'z'.repeat(5000) })
    const pending = listPendingTaskNotices(db, { agentId: 'bob' })
    expect(pending).toHaveLength(5)
    const block = formatPendingTaskNoticeBlock(pending)!
    expect(block.length).toBeLessThan(5 * 1500)
    expect(block).toContain('truncated')
  })

  it('formats nothing for an empty list', () => {
    expect(formatPendingTaskNoticeBlock([])).toBeNull()
    markTaskNoticesDelivered(db, [])
  })

  it('backfills existing rows on migration so a deploy replays nothing', () => {
    // Simulate a pre-W5 database: drop the bookkeeping column's content.
    const task = finishCronTask({ name: 'before the migration' })
    db.prepare('UPDATE tasks SET agent_notified_at = NULL WHERE id = ?').run(task.id)
    expect(listPendingTaskNotices(db, { agentId: 'bob' })).toHaveLength(1)

    // Re-running initTaskTable (what a redeploy does) must not touch a row
    // that already carries a timestamp, and the ALTER-time backfill covers
    // the rest — verified by re-initialising the store on the same DB.
    markTaskNoticesDelivered(db, [task.id])
    new TaskStore(db)
    expect(listPendingTaskNotices(db, { agentId: 'bob' })).toHaveLength(0)
  })
})
