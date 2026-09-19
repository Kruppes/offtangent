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
  const visibleRows = computed<StrandTaskRow[]>(() => flattenTaskRows(roots.value, expanded.value))
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
      errorMessage.value = null
      status.value = 'ready'
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : String(err)
      status.value = 'error'
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
