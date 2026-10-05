import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import * as Vue from 'vue'
import { useApi } from '~/composables/useApi'
import * as tasksApi from '~/api/tasks'
import * as strandTasks from '~/api/strandTasks'
import * as dismissals from '~/features/tasks/composables/useTaskDismissals'
import * as tasksList from '~/features/tasks/composables/useTasksList'
import * as taskFormat from '~/features/tasks/utils/taskFormat'
import { APP_DIR, all, byTestId, click, flush, focusedNode, loadSfc, mountNode, text, unmountAll } from '~/features/testing/nodeRenderer'

// The workspace relies on Nuxt auto-imports; the test provides them as globals.
const autoImports = {
  ref: Vue.ref, computed: Vue.computed, reactive: Vue.reactive, nextTick: Vue.nextTick, watch: Vue.watch,
  onMounted: Vue.onMounted, onUnmounted: Vue.onUnmounted, onBeforeUnmount: Vue.onBeforeUnmount,
  useI18n: () => ({ t: (key: string) => key }),
  useFormat: () => ({ formatNumber: String, formatCurrency: String, formatTimestamp: String }),
  navigateTo: vi.fn(),
}

const Workspace = loadSfc(path.join(APP_DIR, 'features/tasks/components/TasksWorkspace.vue'), {
  '~/api/tasks': tasksApi,
  '~/api/strandTasks': strandTasks,
  '~/features/tasks/composables/useTaskDismissals': dismissals,
  '~/features/tasks/composables/useTasksList': tasksList,
  '~/features/tasks/utils/taskFormat': taskFormat,
  // Focus return after undo walks the DOM; covered by its own unit test.
  '~/utils/focusRestored': { focusRestored: () => null },
})

// LabeledField hands its generated id to the slot.
const stubs = { LabeledField: Vue.defineComponent({ setup: (_, { slots }) => () => Vue.h('label', slots.default?.({ id: 'field-1' })) }) }

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Synthetic ${id}`, prompt: 'p', status: 'completed', triggerType: 'user', triggerSourceId: null,
  provider: null, model: null, isDefaultModel: null, maxDurationMinutes: null, promptTokens: 0, completionTokens: 0,
  cacheRead: 0, cacheWrite: 0, estimatedCost: 0, toolCallCount: 0, resultSummary: null, resultStatus: null,
  errorMessage: null, createdAt: '2026-01-01T10:00:00Z', startedAt: '2026-01-01T10:00:01Z', completedAt: null,
  sessionId: null, strandId: 'strand-a', dismissedAt: null, ...extra,
})

let list: Array<ReturnType<typeof task>>
let dismissStatus: number
let request: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  list = [task('done'), task('live', { status: 'running' }), task('waiting', { status: 'paused' })]
  dismissStatus = 200
  for (const [name, value] of Object.entries(autoImports)) vi.stubGlobal(name, value)
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  request = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/tasks')) return json({ tasks: list, pagination: { page: 1, limit: 20, total: list.length, totalPages: 1 } })
    const ids = JSON.parse(String(init?.body ?? '{}')).ids as string[]
    if (url.endsWith('/activity/dismiss')) return dismissStatus === 200 ? json({ dismissed: ids, dismissedAt: '2026-01-01T12:00:00Z' }) : json({ error: 'task is live' }, dismissStatus)
    if (url.endsWith('/activity/undismiss')) return json({ restored: ids })
    return json({ error: 'unexpected' }, 404)
  })
  vi.stubGlobal('fetch', request)
})
afterEach(() => { unmountAll(); vi.unstubAllGlobals() })

const calls = (suffix: string) => request.mock.calls.filter(([url]) => String(url).includes(suffix))
// Mobile cards and the desktop table both render (CSS picks one), so ids are deduplicated.
const ackIds = (root: ReturnType<typeof mountNode>) => [...new Set(byTestId(root, 'tasks-ack-one').map(b => b.props['data-ack-id']))]

describe('Global task list: acknowledge finished tasks', () => {
  it('offers acknowledge only for finished tasks, never for running or paused ones', async () => {
    const root = mountNode(Workspace, {}, stubs)
    await flush()
    expect(ackIds(root)).toEqual(['done'])
    expect(text(byTestId(root, 'tasks-ack-all')[0]!)).toContain('tasks.ack.dismissAll:1')
    expect(String(byTestId(root, 'tasks-ack-toolbar')[0]!.props.class)).toContain('min-h-11')
  })

  it('acknowledges through the strand contract and undoes', async () => {
    const root = mountNode(Workspace, {}, stubs)
    await flush()
    await click(byTestId(root, 'tasks-ack-one')[0]!)
    expect(JSON.parse(calls('/api/strands/strand-a/activity/dismiss')[0]![1].body)).toEqual({ ids: ['done'] })
    expect(ackIds(root)).toEqual([])
    expect(text(byTestId(root, 'tasks-ack-status')[0]!)).toContain('tasks.ack.dismissed')
    // Keyboard users land on "Undo" instead of on <body> when their row goes.
    expect(focusedNode).toBe(byTestId(root, 'tasks-ack-undo')[0])
    await click(byTestId(root, 'tasks-ack-undo')[0]!)
    expect(JSON.parse(calls('/api/strands/strand-a/activity/undismiss')[0]![1].body)).toEqual({ ids: ['done'] })
    expect(ackIds(root)).toEqual(['done'])
  })

  it('catches a 409 (task live again): says why, hides nothing, reloads the list', async () => {
    dismissStatus = 409
    const root = mountNode(Workspace, {}, stubs)
    await flush()
    const before = calls('/api/tasks').length
    await click(byTestId(root, 'tasks-ack-one')[0]!)
    await flush()
    expect(text(byTestId(root, 'tasks-ack-status')[0]!)).toContain('tasks.ack.dismissConflict')
    expect(byTestId(root, 'tasks-ack-undo')).toHaveLength(0)
    expect(ackIds(root)).toEqual(['done'])
    expect(calls('/api/tasks').length).toBeGreaterThan(before)
    expect(all(root).some(n => n.props.role === 'status' && text(n).includes('dismissConflict'))).toBe(true)
  })
})

describe('Global task list: cached-input share next to the tokens', () => {
  it('shows the real share, a real 0 % and a dash for unknown, never a fake 0', async () => {
    list = [
      // 50 of 1000 input tokens from the cache (pi-ai: promptTokens excludes cache read/write)
      task('five', { promptTokens: 900, cacheRead: 50, cacheWrite: 50, completionTokens: 40000 }),
      task('zero', { promptTokens: 1200, cacheRead: 0, cacheWrite: 0 }),
      task('none', { promptTokens: 0, cacheRead: 0, cacheWrite: 0 }),
    ]
    const root = mountNode(Workspace, {}, stubs)
    await flush()
    const cells = byTestId(root, 'task-cache-rate').map(node => text(node).trim())
    expect(cells).toEqual(['CH 5.0%', 'CH 0.0%', 'CH —'])
    // the tooltip repeats the share below the existing cache-read/-write token rows
    const tooltip = byTestId(root, 'task-cache-rate-tooltip').map(node => text(node).trim())
    expect(tooltip).toEqual(['5.0%', '0.0%', '—'])
  })
})
