/**
 * The strand activity view's data source.
 *
 * Two inputs, one state (see `taskActivity.ts`):
 *  * REST catch-up on mount, on strand switch and on every reconnect —
 *    a client that opens the page mid-wave sees the full tree immediately,
 *    and a missed `task_started` frame can never make a sub-task invisible
 *    forever.
 *  * live frames, folded in by `useChat`'s socket handler.
 *
 * Plus a one-second tick that drives the running counters. The tick only
 * runs while at least one node is live, so an idle strand costs nothing.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useStrandTasksApi } from '../../../api/strandTasks'
import {
  applyTaskTreeSnapshot,
  buildTaskRows,
  countLive,
  flattenTaskRows,
  partitionActivity,
  setDismissed,
  subtreeNodes,
  type StrandTaskRow,
} from '../taskActivity'

export type StrandTasksStatus = 'idle' | 'loading' | 'error' | 'ready'

export function useStrandTasks(strandId: () => string | null) {
  const { strandTasks, connectionStatus } = useChat()
  const api = useStrandTasksApi()

  const status = ref<StrandTasksStatus>('idle')
  const errorMessage = ref<string | null>(null)
  const expanded = ref<Set<string>>(new Set())
  const nowMs = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null

  const state = computed(() => {
    const id = strandId()
    return id ? strandTasks.value[id] : undefined
  })
  const roots = computed<StrandTaskRow[]>(() => buildTaskRows(state.value))
  // W6c: three groups — open (default view), older than 24 h (folded) and
  // acknowledged (hidden). The two folded groups open on demand.
  const showOlder = ref(false)
  const showHidden = ref(false)
  const partition = computed(() => partitionActivity(roots.value, nowMs.value))
  const shownRoots = computed<StrandTaskRow[]>(() => [
    ...partition.value.open,
    ...(showOlder.value ? partition.value.older : []),
    ...(showHidden.value ? partition.value.hidden : []),
  ])
  const visibleRows = computed<StrandTaskRow[]>(() => flattenTaskRows(shownRoots.value, expanded.value))
  const liveCount = computed(() => countLive(state.value))
  const totalCount = computed(() => Object.keys(state.value?.nodes ?? {}).length)

  async function reload(include: 'active' | 'all' = 'all'): Promise<void> {
    const id = strandId()
    if (!id) {
      status.value = 'idle'
      return
    }
    status.value = status.value === 'ready' ? 'ready' : 'loading'
    try {
      const tree = await api.getStrandTasks(id, include)
      // Guard against a slow response for a strand the user already left.
      if (strandId() !== id) return
      strandTasks.value = applyTaskTreeSnapshot(strandTasks.value, id, tree.tasks, tree.generatedAt)
      nowMs.value = Date.now()
      errorMessage.value = null
      status.value = 'ready'
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : String(err)
      status.value = 'error'
    }
  }

  /** Last acknowledgement, for the undo bar. Null when nothing to undo. */
  const lastDismissed = ref<string[] | null>(null)
  const dismissError = ref(false)

  function idsOf(rootIds: string[]): string[] {
    const wanted = new Set(rootIds)
    return roots.value.filter(r => wanted.has(r.id)).flatMap(r => subtreeNodes(r).map(n => n.id))
  }

  /**
   * Acknowledge roots (each with its whole subtree). Optimistic: the rows go
   * at once; a failed request puts them back and shows the error line.
   */
  async function dismiss(rootIds: string[]): Promise<boolean> {
    const id = strandId()
    const ids = idsOf(rootIds)
    if (!id || ids.length === 0) return false
    const previous = new Map(ids.map(taskId => [taskId, state.value?.nodes[taskId]?.dismissedAt ?? null]))
    strandTasks.value = setDismissed(strandTasks.value, id, ids, new Date().toISOString())
    dismissError.value = false
    try {
      const res = await api.dismissActivity(id, ids)
      strandTasks.value = setDismissed(strandTasks.value, id, ids, res.dismissedAt)
      lastDismissed.value = ids
      return true
    } catch {
      for (const [taskId, at] of previous) strandTasks.value = setDismissed(strandTasks.value, id, [taskId], at)
      dismissError.value = true
      return false
    }
  }

  /** Bring acknowledged nodes back (undo, or "restore" in the hidden group). */
  async function restore(ids: string[]): Promise<boolean> {
    const id = strandId()
    if (!id || ids.length === 0) return false
    const previous = new Map(ids.map(taskId => [taskId, state.value?.nodes[taskId]?.dismissedAt ?? null]))
    strandTasks.value = setDismissed(strandTasks.value, id, ids, null)
    dismissError.value = false
    try {
      await api.undismissActivity(id, ids)
      lastDismissed.value = null
      return true
    } catch {
      for (const [taskId, at] of previous) strandTasks.value = setDismissed(strandTasks.value, id, [taskId], at)
      dismissError.value = true
      return false
    }
  }

  function toggle(taskId: string): void {
    const next = new Set(expanded.value)
    if (next.has(taskId)) next.delete(taskId)
    else next.add(taskId)
    expanded.value = next
  }

  function isExpanded(taskId: string): boolean {
    return expanded.value.has(taskId)
  }

  function startTicker(): void {
    if (ticker) return
    ticker = setInterval(() => { nowMs.value = Date.now() }, 1000)
  }

  function stopTicker(): void {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  watch(liveCount, live => {
    if (live > 0) startTicker()
    else stopTicker()
  }, { immediate: true })

  watch(() => strandId(), id => {
    expanded.value = new Set()
    showOlder.value = false
    showHidden.value = false
    lastDismissed.value = null
    dismissError.value = false
    if (id) void reload()
    else status.value = 'idle'
  })

  // Reconnect = catch-up. Everything that happened while the socket was down
  // is in the tree the server returns.
  watch(connectionStatus, (next, previous) => {
    if (next === 'connected' && previous !== 'connected' && strandId()) void reload()
  })

  onMounted(() => { if (strandId()) void reload() })
  onBeforeUnmount(stopTicker)

  return {
    status,
    errorMessage,
    roots,
    partition,
    showOlder,
    showHidden,
    lastDismissed,
    dismissError,
    dismiss,
    restore,
    visibleRows,
    liveCount,
    totalCount,
    nowMs,
    expanded,
    reload,
    toggle,
    isExpanded,
  }
}
