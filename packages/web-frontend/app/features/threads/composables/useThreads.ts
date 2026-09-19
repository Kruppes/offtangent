import {
  useThreadsApi,
  type CreateThreadPayload,
  type Thread,
  type UpdateThreadPayload,
} from '~/api/threads'
import { MOCK_SESSION_ACTIVITY } from '~/api/threads.mock'
import { groupThreads, sortThreads, type ThreadGroup } from '~/features/threads/threadDisplay'
import type { SessionActivity } from '~/composables/useChat'

export type { Thread, ThreadGroup }

/**
 * Inbox state: every thread of every persona, ordered by activity.
 *
 * Mutations are optimistic — renaming, pinning and archiving are instant in the
 * list and rolled back if the PATCH fails, because the inbox is the main
 * navigation surface and must never feel laggy.
 */
export function useThreads() {
  const api = useThreadsApi()
  const config = useRuntimeConfig()
  const { sessionActivity, threadActivity } = useChat()

  const threads = useState<Thread[]>('threads_list', () => [])
  const loading = useState<boolean>('threads_loading', () => false)
  const error = useState<string | null>('threads_error', () => null)
  const includeArchived = useState<boolean>('threads_include_archived', () => false)
  /** The thread currently open in the chat view, highlighted in the inbox. */
  const activeThreadId = useState<string | null>('threads_active_id', () => null)
  /** Set when the last mutation succeeded, so the page can confirm it. */
  const lastAction = useState<string | null>('threads_last_action', () => null)

  const sortedThreads = computed(() => sortThreads(threads.value))
  const groupedThreads = computed(() => groupThreads(threads.value))
  const hasThreads = computed(() => threads.value.length > 0)

  /** Turn state (running / queued) of a thread, or `undefined` when idle. */
  function activityOf(threadId: string): SessionActivity | undefined {
    return sessionActivity.value[threadId]
  }

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      threads.value = await api.listThreads({ includeArchived: includeArchived.value })
      // Without a backend the mock also fakes the live turn state, so the
      // running/queued indicators are demoable.
      if (config.public.threadsMock) {
        sessionActivity.value = { ...sessionActivity.value, ...MOCK_SESSION_ACTIVITY }
      }
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function setIncludeArchived(value: boolean): Promise<void> {
    includeArchived.value = value
    await refresh()
  }

  async function create(payload: CreateThreadPayload): Promise<Thread | null> {
    error.value = null
    try {
      const thread = await api.createThread(payload)
      threads.value = [thread, ...threads.value.filter(t => t.id !== thread.id)]
      lastAction.value = 'created'
      return thread
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  /**
   * Patch one thread optimistically. The previous row is restored when the
   * request fails, so the list never shows a state the backend rejected.
   */
  async function patch(id: string, changes: UpdateThreadPayload, action: string): Promise<Thread | null> {
    const index = threads.value.findIndex(t => t.id === id)
    const previous = index >= 0 ? threads.value[index]! : null
    if (previous) {
      const optimistic = [...threads.value]
      optimistic[index] = { ...previous, ...changes }
      threads.value = optimistic
    }

    try {
      const updated = await api.updateThread(id, changes)
      const current = threads.value.findIndex(t => t.id === id)
      if (current >= 0) {
        const next = [...threads.value]
        next[current] = updated
        threads.value = next
      }
      // An archived thread disappears from the default view right away.
      if (updated.archived && !includeArchived.value) {
        threads.value = threads.value.filter(t => t.id !== id)
      }
      lastAction.value = action
      error.value = null
      return updated
    } catch (err) {
      if (previous) {
        const current = threads.value.findIndex(t => t.id === id)
        const next = [...threads.value]
        if (current >= 0) next[current] = previous
        else next.unshift(previous)
        threads.value = next
      }
      error.value = (err as Error).message
      return null
    }
  }

  function rename(id: string, title: string | null): Promise<Thread | null> {
    const trimmed = title?.trim() ?? ''
    return patch(id, { title: trimmed === '' ? null : trimmed }, 'renamed')
  }

  function pin(id: string, pinned: boolean): Promise<Thread | null> {
    return patch(id, { pinned }, pinned ? 'pinned' : 'unpinned')
  }

  function archive(id: string, archived: boolean): Promise<Thread | null> {
    return patch(id, { archived }, archived ? 'archived' : 'unarchived')
  }

  function clearLastAction(): void {
    lastAction.value = null
  }

  /**
   * Frames of threads other than the open one bump `threadActivity`; each bump
   * means some thread's last message changed, so the inbox reloads itself.
   * Debounced because a streaming turn bumps it on every chunk.
   */
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  watch(threadActivity, () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void refresh() }, 1500)
  })
  onScopeDispose(() => {
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  return {
    threads,
    sortedThreads,
    groupedThreads,
    hasThreads,
    loading,
    error,
    includeArchived,
    activeThreadId,
    lastAction,
    refresh,
    setIncludeArchived,
    create,
    rename,
    pin,
    archive,
    activityOf,
    clearLastAction,
  }
}
