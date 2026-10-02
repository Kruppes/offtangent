import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { useApi } from '~/composables/useApi'
import * as tasks from '~/api/tasks'
import * as controls from '~/features/tasks/taskControls'
import { all, APP_DIR, button, byTestId, click, input, loadSfc, mountNode, submit, text, unmountAll } from '~/features/testing/nodeRenderer'

const TaskControls = loadSfc(path.join(APP_DIR, 'features/tasks/components/TaskControls.vue'), { '~/api/tasks': tasks, '../taskControls': controls })
const task = (status: string, extra: Record<string, unknown> = {}) => ({ id: 't1', name: 'Synthetic task', status, triggerType: 'user', createdAt: '2026-01-01T10:00:00Z', ...extra })
let replyStatus = 200
let replyBody: unknown = { outcome: 'resumed' }
let request: ReturnType<typeof vi.fn>
beforeEach(() => {
  replyStatus = 200; replyBody = { outcome: 'resumed' }
  vi.stubGlobal('useApi', useApi)
  vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'test-token' }))
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://test.example' } }))
  request = vi.fn(async (url: string) => {
    if (url.endsWith('/reply')) return new Response(JSON.stringify(replyBody), { status: replyStatus })
    return new Response(JSON.stringify({ task: task('failed') }))
  })
  vi.stubGlobal('fetch', request)
})
afterEach(() => { unmountAll(); vi.unstubAllGlobals() })
const calls = (suffix: string) => request.mock.calls.filter(([url]) => String(url).endsWith(suffix))

describe('Task controls', () => {
  it('stops a running task only after confirmation, and cancel does not stop it', async () => {
    const changed = vi.fn()
    const root = mountNode(TaskControls, { task: task('running'), events: [], onChanged: changed })
    expect(text(byTestId(root, 'task-status-line')[0]!)).toContain('tasks.detail.status.running')
    await click(byTestId(root, 'task-stop')[0]!)
    expect(calls('/kill')).toHaveLength(0)
    await click(button(root, 'common.cancel'))
    expect(byTestId(root, 'task-stop-confirm')).toHaveLength(0)
    await click(byTestId(root, 'task-stop')[0]!)
    await click(byTestId(root, 'task-stop-yes')[0]!)
    expect(calls('/api/tasks/t1/kill')).toHaveLength(1)
    expect(changed).toHaveBeenCalledWith('tasks.detail.stopped')
  })

  it('answers a paused task with its question shown, and validates empty input', async () => {
    const changed = vi.fn()
    const events = [{ type: 'status_change', timestamp: '2026-01-01T10:01:00Z', status: 'paused', statusMessage: 'Which synthetic option?' }]
    const root = mountNode(TaskControls, { task: task('paused'), events, onChanged: changed })
    expect(text(root)).toContain('Which synthetic option?')
    const form = byTestId(root, 'task-reply')[0]!
    await submit(form)
    expect(text(root)).toContain('tasks.detail.reply.empty')
    expect(calls('/reply')).toHaveLength(0)
    await input(all(root).find(n => n.tag === 'textarea')!, '  Option B  ')
    await submit(form)
    expect(JSON.parse(calls('/api/tasks/t1/reply')[0]![1].body)).toEqual({ text: 'Option B' })
    expect(changed).toHaveBeenCalledWith('tasks.detail.reply.sent')
  })

  it('reports a still running task (409) as text and keeps the draft', async () => {
    replyStatus = 409; replyBody = { error: 'running' }
    const root = mountNode(TaskControls, { task: task('paused'), events: [] })
    await input(all(root).find(n => n.tag === 'textarea')!, 'Answer')
    await submit(byTestId(root, 'task-reply')[0]!)
    expect(text(root)).toContain('tasks.detail.reply.running')
    expect(all(root).find(n => n.tag === 'textarea')!.props.value).toBe('Answer')
  })

  it('shows a finished result as text, without stop or reply', () => {
    const root = mountNode(TaskControls, { task: task('completed', { resultSummary: '<b>Synthetic result</b>' }), events: [] })
    expect(text(byTestId(root, 'task-result')[0]!)).toContain('<b>Synthetic result</b>')
    expect(byTestId(root, 'task-stop')).toHaveLength(0)
    expect(byTestId(root, 'task-reply')).toHaveLength(0)
  })

  it('follows the backend when a paused task finished meanwhile and the answer became a follow-up', async () => {
    replyStatus = 201; replyBody = { outcome: 'follow_up', followUpTaskId: 't2' }
    const followUp = vi.fn()
    const root = mountNode(TaskControls, { task: task('paused'), events: [], onFollowUp: followUp })
    await input(all(root).find(n => n.tag === 'textarea')!, 'One more thing')
    await submit(byTestId(root, 'task-reply')[0]!)
    expect(followUp).toHaveBeenCalledWith('t2')
  })
})
