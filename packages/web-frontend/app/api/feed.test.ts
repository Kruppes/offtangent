import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFeedApi } from './feed'
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
