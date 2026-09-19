import { useFeedApi, type FeedItem } from '~/api/feed'

/** Shared by navigation, the feed and the existing chat transport. */
export function useFeed() {
  const items = useState<FeedItem[]>('feed_items', () => [])
  const unreadCount = useState<number>('feed_unread', () => 0)
  const loading = useState<boolean>('feed_loading', () => false)
  const busy = useState<boolean>('feed_busy', () => false)
  const error = useState<string | null>('feed_error', () => null)
  const revision = useState<number>('feed_revision', () => 0)
  const generation = useState<number>('feed_generation', () => 0)
  const api = useFeedApi()

  function reset() {
    generation.value++
    revision.value++
    items.value = []
    unreadCount.value = 0
    loading.value = false
    busy.value = false
    error.value = null
  }

  async function refreshCount() {
    const version = revision.value
    try {
      const count = await api.unreadCount()
      if (version === revision.value && !busy.value) unreadCount.value = count
    } catch { /* The feed itself exposes retry; navigation stays usable offline. */ }
  }

  async function load() {
    if (loading.value || busy.value) return
    const owner = generation.value
    loading.value = true
    error.value = null
    const version = revision.value
    try {
      const [rows, count] = await Promise.all([api.list({ limit: 200 }), api.unreadCount()])
      if (version === revision.value) {
        items.value = rows
        unreadCount.value = count
      }
    } catch {
      if (owner === generation.value) error.value = 'feed.error'
    } finally {
      if (owner === generation.value) {
        loading.value = false
        // A live frame or read action overtook this snapshot: fetch authoritative state again.
        if (version !== revision.value && !busy.value) void load()
      }
    }
  }

  function receive(item: FeedItem) {
    revision.value++
    const previous = items.value.find(row => row.id === item.id)
    if (!previous) {
      items.value = [item, ...items.value].slice(0, 200)
      if (!item.readAt) unreadCount.value++
    }
    void refreshCount()
  }

  async function markRead(id?: string) {
    if (busy.value) return
    const selected = items.value.filter(item => !item.readAt && (!id || item.id === id))
    if (id && !selected.length) return
    const owner = generation.value
    busy.value = true
    error.value = null
    revision.value++
    const ids = new Set(selected.map(item => item.id))
    const removed = id ? 1 : unreadCount.value
    const stamp = new Date().toISOString()
    items.value = items.value.map(item => ids.has(item.id) ? { ...item, readAt: stamp } : item)
    unreadCount.value = Math.max(0, unreadCount.value - removed)
    try {
      if (id) await api.read(id)
      else await api.readAll()
    } catch {
      if (owner !== generation.value) return
      items.value = items.value.map(item => ids.has(item.id) ? { ...item, readAt: null } : item)
      unreadCount.value += removed
      error.value = 'feed.readError'
    } finally {
      if (owner === generation.value) {
        revision.value++
        busy.value = false
        if (!error.value) void load()
      }
    }
  }

  async function ask(item: FeedItem): Promise<string | null> {
    if (busy.value) return null
    const owner = generation.value
    busy.value = true
    error.value = null
    revision.value++
    try {
      const result = await api.ask(item.id)
      if (owner !== generation.value) return null
      if (!item.readAt) {
        items.value = items.value.map(row => row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row)
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
      return result.capture.strandId ? `/strands/${encodeURIComponent(result.capture.strandId)}` : '/'
    } catch {
      if (owner !== generation.value) return null
      error.value = 'feed.askError'
      return null
    } finally {
      if (owner === generation.value) {
        busy.value = false
        revision.value++
        void refreshCount()
      }
    }
  }

  return { items, unreadCount, loading, busy, error, reset, load, refreshCount, receive, markRead, ask }
}
