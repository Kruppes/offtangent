import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { useApi } from '~/composables/useApi'
import * as tasksApi from '~/api/tasks'
import * as strandTasks from '~/api/strandTasks'
import * as dismissals from '~/features/tasks/composables/useTaskDismissals'
import * as taskFormat from '~/features/tasks/utils/taskFormat'
import { APP_DIR, byTestId, click, flush, focusedNode, loadSfc, mountNode, text, unmountAll } from '~/features/testing/nodeRenderer'

const Strip = loadSfc(path.join(APP_DIR, 'features/tasks/components/HomeActivityStrip.vue'), {
  '~/api/tasks': tasksApi,
  '~/api/strandTasks': strandTasks,
  '../composables/useTaskDismissals': dismissals,
  '../utils/taskFormat': taskFormat,
})

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Synthetic ${id}`, status: 'completed', triggerType: 'user', createdAt: '2026-01-01T10:00:00Z',
  startedAt: '2026-01-01T10:00:01Z', strandId: 'strand-a', dismissedAt: null, ...extra,
})

let list: Array<ReturnType<typeof task>>
let listStatus: number
let dismissStatus: number
let request: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  list = [task('done'), task('live', { status: 'running' }), task('waiting', { status: 'paused' }), task('cron', { strandId: null })]
  listStatus = 200
  dismissStatus = 200
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/tasks')) return listStatus === 200 ? json({ tasks: list, pagination: { page: 1, limit: 20, total: list.length, totalPages: 1 } }) : json({ error: 'down' }, listStatus)
    const ids = JSON.parse(String(init?.body ?? '{}')).ids as string[]
    if (url.endsWith('/activity/dismiss')) return dismissStatus === 200 ? json({ dismissed: ids, dismissedAt: '2026-01-01T12:00:00Z' }) : json({ error: 'task is live' }, dismissStatus)
    if (url.endsWith('/activity/undismiss')) return json({ restored: ids })
    return json({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', request)
})
afterEach(() => { unmountAll(); vi.unstubAllGlobals() })

const calls = (suffix: string) => request.mock.calls.filter(([url]) => String(url).endsWith(suffix))
const rowIds = (root: ReturnType<typeof mountNode>) => byTestId(root, 'home-activity-row').map(row => text(row))

describe('Home activity strip', () => {
  it('lists strand tasks only and offers acknowledge for finished ones, never for running or paused', async () => {
    const root = mountNode(Strip)
    await flush()
    expect(rowIds(root)).toHaveLength(3)
    expect(text(root)).not.toContain('Synthetic cron')
    const dismiss = byTestId(root, 'home-activity-dismiss')
    expect(dismiss.map(b => b.props['data-ack-id'])).toEqual(['done'])
    expect(dismiss[0]!.props['aria-label']).toBe('tasks.ack.dismissOne')
    // 44 px hit area on the icon-only control.
    expect(String(dismiss[0]!.props.class)).toMatch(/\bh-11\b.*\bw-11\b/)
  })

  it('acknowledges through the strand contract, hides the row and undoes', async () => {
    const root = mountNode(Strip)
    await flush()
    await click(byTestId(root, 'home-activity-dismiss')[0]!)
    expect(calls('/api/strands/strand-a/activity/dismiss')).toHaveLength(1)
    expect(JSON.parse(calls('/activity/dismiss')[0]![1].body)).toEqual({ ids: ['done'] })
    expect(text(root)).not.toContain('Synthetic done')
    expect(text(byTestId(root, 'home-activity-status')[0]!)).toContain('tasks.ack.dismissed:1')
    expect(focusedNode).toBe(byTestId(root, 'home-activity-undo')[0])
    await click(byTestId(root, 'home-activity-undo')[0]!)
    expect(JSON.parse(calls('/api/strands/strand-a/activity/undismiss')[0]![1].body)).toEqual({ ids: ['done'] })
    expect(text(root)).toContain('Synthetic done')
    expect(byTestId(root, 'home-activity-undo')).toHaveLength(0)
  })

  it('restores an already acknowledged task from the hidden group', async () => {
    list = [task('old', { dismissedAt: '2026-01-01T11:00:00Z' })]
    const root = mountNode(Strip)
    await flush()
    expect(byTestId(root, 'home-activity-empty')).toHaveLength(1)
    const toggle = byTestId(root, 'home-activity-show-hidden')[0]!
    expect(toggle.props['aria-expanded']).toBe(false)
    await click(toggle)
    await click(byTestId(root, 'home-activity-restore')[0]!)
    expect(calls('/api/strands/strand-a/activity/undismiss')).toHaveLength(1)
    expect(byTestId(root, 'home-activity-dismiss')).toHaveLength(1)
  })

  it('reports a task that went live again (409) and reloads instead of hiding it', async () => {
    dismissStatus = 409
    const root = mountNode(Strip)
    await flush()
    const before = calls('/api/tasks?limit=20').length
    await click(byTestId(root, 'home-activity-dismiss')[0]!)
    await flush()
    expect(text(byTestId(root, 'home-activity-status')[0]!)).toContain('tasks.ack.dismissConflict')
    expect(text(root)).toContain('Synthetic done')
    expect(byTestId(root, 'home-activity-undo')).toHaveLength(0)
    expect(calls('/api/tasks?limit=20').length).toBe(before + 1)
  })

  it('shows a generic error when acknowledging fails for another reason', async () => {
    dismissStatus = 500
    const root = mountNode(Strip)
    await flush()
    await click(byTestId(root, 'home-activity-dismiss')[0]!)
    expect(text(byTestId(root, 'home-activity-status')[0]!)).toContain('tasks.ack.dismissError')
    expect(text(root)).toContain('Synthetic done')
  })

  it('has loading, error with retry and empty states', async () => {
    listStatus = 500
    const root = mountNode(Strip)
    expect(byTestId(root, 'home-activity-loading')).toHaveLength(1)
    await flush()
    const error = byTestId(root, 'home-activity-error')[0]!
    expect(error.props.role).toBe('alert')
    listStatus = 200
    list = []
    const retry = error.children.find(n => n.tag === 'button')!
    await click(retry)
    expect(byTestId(root, 'home-activity-error')).toHaveLength(0)
    expect(byTestId(root, 'home-activity-empty')).toHaveLength(1)
  })
})
