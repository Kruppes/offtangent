import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEED_FILTER_KINDS, isBoardUpdate, useFeedApi, type FeedItem } from './feed'
import { FEED_ITEM_KINDS } from '@axiom/core'
import { useApi } from '../composables/useApi'
afterEach(() => vi.unstubAllGlobals())
describe('feed transport', () => {
  it('encodes list filters and cursor with the backend parameter names', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: [] })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    await useFeedApi().list({ sinceId: 'a/b', limit: 50, kind: 'task_question', unreadOnly: true })
    expect(apiFetch).toHaveBeenCalledWith('/api/feed?since_id=a%2Fb&limit=50&kind=task_question&unread_only=1')
  })
  it('uses real read/count/ask routes', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ count: 9 })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    const api = useFeedApi()
    expect(await api.unreadCount()).toBe(9)
    await api.read('a/b')
    await api.readAll()
    await api.ask('a/b', 'Why?')
    expect(apiFetch).toHaveBeenCalledWith('/api/feed/a%2Fb/read', { method: 'POST' })
    expect(apiFetch).toHaveBeenCalledWith('/api/feed/read-all', { method: 'POST' })
    expect(apiFetch).toHaveBeenCalledWith('/api/feed/a%2Fb/ask', { method: 'POST', body: '{"text":"Why?"}' })
  })
  it('accepts the backend 204 without attempting JSON parsing', async () => {
    vi.stubGlobal('useAuth', () => ({ getAccessToken: () => 'token', refreshAccessToken: vi.fn(), logout: vi.fn() }))
    vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: 'https://example.test' } }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(useApi().apiFetch('/api/feed/read-all', { method: 'POST' })).resolves.toBeUndefined()
  })
})

describe('feed contract for boards', () => {
  it('offers every core kind in the filter, with board_update last and no duplicates', () => {
    expect([...FEED_FILTER_KINDS].sort()).toEqual([...FEED_ITEM_KINDS].sort())
    expect(FEED_FILTER_KINDS.at(-1)).toBe('board_update')
    expect(new Set(FEED_FILTER_KINDS).size).toBe(FEED_FILTER_KINDS.length)
    // The pre-existing filter entries keep their order, so the select does not
    // reshuffle for users who already know it.
    expect(FEED_FILTER_KINDS.slice(0, 6)).toEqual(['task_result', 'task_question', 'cron_report', 'heartbeat', 'reminder', 'system'])
  })

  it('narrows a board update to an item that always carries its board key', () => {
    const base: FeedItem = { id: 'f1', kind: 'board_update', title: 'Depot updated', body: null, agentId: 'analyst', taskId: null, strandId: null, createdAt: '2026-09-25T20:00:00Z', readAt: null, notify: true, boardKey: 'depot' }
    expect(isBoardUpdate(base)).toBe(true)
    if (isBoardUpdate(base)) expect(base.boardKey.length).toBeGreaterThan(0)
    expect(isBoardUpdate({ ...base, boardKey: null })).toBe(false)
    expect(isBoardUpdate({ ...base, boardKey: '' })).toBe(false)
    expect(isBoardUpdate({ ...base, kind: 'task_result' })).toBe(false)
  })

  it('passes the new kind through the list filter with the backend parameter name', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ items: [] })
    vi.stubGlobal('useApi', () => ({ apiFetch }))
    await useFeedApi().list({ kind: 'board_update' })
    expect(apiFetch).toHaveBeenCalledWith('/api/feed?kind=board_update')
  })
})
