import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { useFeed } from './useFeed'
import type { FeedItem } from '~/api/feed'

const api = vi.hoisted(() => ({ list: vi.fn(), unreadCount: vi.fn(), read: vi.fn(), readAll: vi.fn(), ask: vi.fn() }))
vi.mock('~/api/feed', () => ({ useFeedApi: () => api }))
const item = (id: string): FeedItem => ({ id, title: id, body: null, kind: 'system', readAt: null, createdAt: '2026-09-01T00:00:00Z', strandId: null, agentId: null, taskId: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  const states = new Map<string, Ref>()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  api.list.mockResolvedValue([item('a'), item('b')])
  api.unreadCount.mockResolvedValue(2)
})
afterEach(() => vi.unstubAllGlobals())

describe('shared feed state', () => {
  it('shares list/count and leaves errors retryable', async () => {
    const feed = useFeed()
    await feed.load()
    expect(useFeed().items.value).toHaveLength(2)
    expect(useFeed().unreadCount.value).toBe(2)
    api.list.mockRejectedValueOnce(new Error('offline'))
    await feed.load()
    expect(feed.error.value).toBe('feed.error')
    expect(feed.items.value).toHaveLength(2)
    await feed.load()
    expect(feed.error.value).toBeNull()
  })
  it('optimistically reads one item and rolls back on failure', async () => {
    const feed = useFeed()
    await feed.load()
    const request = deferred<void>()
    api.read.mockReturnValue(request.promise)
    const done = feed.markRead('a')
    expect(feed.items.value[0]?.readAt).toBeTruthy()
    expect(useFeed().unreadCount.value).toBe(1)
    request.reject(new Error('offline'))
    await done
    expect(feed.items.value[0]?.readAt).toBeNull()
    expect(feed.unreadCount.value).toBe(2)
    expect(feed.error.value).toBe('feed.readError')
  })
  it('rolls back all reads without dropping a live arrival, and ignores duplicate frames', async () => {
    const feed = useFeed()
    await feed.load()
    const request = deferred<void>()
    api.readAll.mockReturnValue(request.promise)
    const done = feed.markRead()
    expect(feed.unreadCount.value).toBe(0)
    expect(feed.items.value.every(row => row.readAt)).toBe(true)
    feed.receive(item('new'))
    feed.receive(item('new'))
    expect(feed.unreadCount.value).toBe(1)
    request.reject(new Error('offline'))
    await done
    expect(feed.unreadCount.value).toBe(3)
    expect(feed.items.value.map(row => row.id)).toEqual(['new', 'a', 'b'])
    expect(feed.items.value.every(row => !row.readAt)).toBe(true)
  })
  it('blocks duplicate read mutations and does not issue a read for a read item', async () => {
    const feed = useFeed()
    await feed.load()
    const request = deferred<void>()
    api.read.mockReturnValue(request.promise)
    const done = feed.markRead('a')
    await feed.markRead('a')
    await feed.markRead()
    expect(api.read).toHaveBeenCalledTimes(1)
    expect(api.readAll).not.toHaveBeenCalled()
    api.list.mockResolvedValue([{ ...item('a'), readAt: 'now' }, item('b')])
    api.unreadCount.mockResolvedValue(1)
    request.resolve()
    await done
    await Promise.resolve()
    await feed.markRead('a')
    expect(api.read).toHaveBeenCalledTimes(1)
  })
  it('routes Ask to the returned capture strand, never the original item strand', async () => {
    const feed = useFeed()
    await feed.load()
    api.ask.mockResolvedValue({ capture: { strandId: 'new/strand' } })
    expect(await feed.ask({ ...item('a'), strandId: 'original' })).toBe('/strands/new%2Fstrand')
    expect(feed.items.value.find(row => row.id === 'a')?.readAt).toBeTruthy()
    api.ask.mockResolvedValue({ capture: { strandId: null } })
    expect(await feed.ask(item('b'))).toBe('/')
  })
  it('retains unread state when Ask fails', async () => {
    const feed = useFeed()
    await feed.load()
    api.ask.mockRejectedValue(new Error('offline'))
    expect(await feed.ask(item('a'))).toBeNull()
    expect(feed.items.value[0]?.readAt).toBeNull()
    expect(feed.error.value).toBe('feed.askError')
  })
  it('ignores an in-flight load after logout/reset', async () => {
    const feed = useFeed()
    const request = deferred<FeedItem[]>()
    api.list.mockReturnValue(request.promise)
    const done = feed.load()
    feed.reset()
    request.resolve([item('private')])
    await done
    expect(feed.items.value).toEqual([])
    expect(feed.unreadCount.value).toBe(0)
    expect(api.list).toHaveBeenCalledTimes(1)
  })
  it('does not let an older snapshot erase a websocket arrival', async () => {
    const feed = useFeed()
    const request = deferred<FeedItem[]>()
    api.list.mockReturnValueOnce(request.promise).mockResolvedValue([item('new'), item('a')])
    const done = feed.load()
    feed.receive(item('new'))
    request.resolve([item('a')])
    await done
    await Promise.resolve()
    expect(feed.items.value[0]?.id).toBe('new')
    expect(api.list).toHaveBeenCalledTimes(2)
  })
})
