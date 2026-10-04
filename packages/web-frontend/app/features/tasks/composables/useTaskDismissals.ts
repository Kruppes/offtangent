import { computed, ref, watch, type Ref } from 'vue'
import type { Task } from '~/api/tasks'
import type { StrandTasksApi } from '~/api/strandTasks'
import { ApiError } from '~/composables/useApi'

/**
 * W7: acknowledge finished tasks in the global task list, through the same
 * server contract as the strand dock (W6c):
 * `POST /api/strands/:id/activity/dismiss|undismiss` with `{ ids }`.
 *
 * The global list mixes tasks of many strands, so every request is grouped
 * per strand (one call per strand, at most 200 ids each, the server cap).
 * Running and paused tasks are never dismissable, exactly like in the dock,
 * and a task without a strand of the viewer (cronjob, heartbeat, a foreign
 * strand: `strandId: null` from the server) offers no dismiss at all.
 *
 * Dismissed rows leave the default view and stay reachable in a folded
 * "hidden" group; the last action can be undone.
 */
export const DISMISS_CHUNK = 200

type DismissApi = Pick<StrandTasksApi, 'dismissActivity' | 'undismissActivity'>

export interface TaskDismissalTarget {
  id: string
  strandId: string
}

export function isTaskDismissable(task: Pick<Task, 'status'> & { strandId?: string | null; dismissedAt?: string | null }): boolean {
  return !!task.strandId && !task.dismissedAt && (task.status === 'completed' || task.status === 'failed')
}

/** Group ids per strand and cut each group at the server cap. */
export function groupByStrand(targets: TaskDismissalTarget[]): Array<{ strandId: string; ids: string[] }> {
  const byStrand = new Map<string, string[]>()
  for (const target of targets) {
    const ids = byStrand.get(target.strandId) ?? []
    if (!ids.includes(target.id)) ids.push(target.id)
    byStrand.set(target.strandId, ids)
  }
  const out: Array<{ strandId: string; ids: string[] }> = []
  for (const [strandId, ids] of byStrand) {
    for (let i = 0; i < ids.length; i += DISMISS_CHUNK) out.push({ strandId, ids: ids.slice(i, i + DISMISS_CHUNK) })
  }
  return out
}

export interface TaskDismissalOptions {
  /**
   * The server answered 409 (a task went live again between two polls):
   * the caller reloads its list so the row shows the live state.
   */
  onConflict?: () => void
}

export function useTaskDismissals(tasks: Ref<Task[]>, api: DismissApi, options: TaskDismissalOptions = {}) {
  /** Local overlay until the next list poll brings the server state. */
  const overlay = ref<Record<string, string | null>>({})
  const busy = ref(false)
  const error = ref(false)
  /** Last dismiss hit a running or paused task (409); nothing of that group was hidden. */
  const conflict = ref(false)
  const lastDismissed = ref<TaskDismissalTarget[] | null>(null)
  const showHidden = ref(false)

  function dismissedAtOf(task: Task): string | null {
    return task.id in overlay.value ? overlay.value[task.id] ?? null : task.dismissedAt ?? null
  }
  function withOverlay(task: Task): Task {
    return { ...task, dismissedAt: dismissedAtOf(task) }
  }

  const hidden = computed(() => tasks.value.filter(task => !!dismissedAtOf(task)))
  const dismissable = computed(() => tasks.value.map(withOverlay).filter(isTaskDismissable))

  /** Rows of the default view: hidden rows only while the group is open. */
  function visible(list: Task[]): Task[] {
    return showHidden.value ? list : list.filter(task => !dismissedAtOf(task))
  }

  function targetsOf(list: Task[]): TaskDismissalTarget[] {
    return list.filter(task => !!task.strandId).map(task => ({ id: task.id, strandId: task.strandId! }))
  }

  /**
   * Send per strand. A strand that fails does not undo the strands that
   * already went through; the error line asks for a retry.
   */
  async function dismiss(list: Task[]): Promise<boolean> {
    const targets = targetsOf(list.map(withOverlay).filter(isTaskDismissable))
    if (targets.length === 0 || busy.value) return false
    busy.value = true
    error.value = false
    conflict.value = false
    const done: TaskDismissalTarget[] = []
    try {
      for (const group of groupByStrand(targets)) {
        try {
          const res = await api.dismissActivity(group.strandId, group.ids)
          for (const id of group.ids) overlay.value = { ...overlay.value, [id]: res.dismissedAt }
          done.push(...group.ids.map(id => ({ id, strandId: group.strandId })))
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) conflict.value = true
          else error.value = true
        }
      }
    } finally {
      busy.value = false
    }
    if (conflict.value) options.onConflict?.()
    lastDismissed.value = done.length > 0 ? done : null
    return done.length > 0
  }

  async function restore(list: TaskDismissalTarget[]): Promise<boolean> {
    if (list.length === 0 || busy.value) return false
    busy.value = true
    error.value = false
    conflict.value = false
    let ok = true
    try {
      for (const group of groupByStrand(list)) {
        try {
          await api.undismissActivity(group.strandId, group.ids)
          for (const id of group.ids) overlay.value = { ...overlay.value, [id]: null }
        } catch {
          ok = false
          error.value = true
        }
      }
    } finally {
      busy.value = false
    }
    if (ok) lastDismissed.value = null
    return ok
  }

  async function restoreTask(task: Task): Promise<boolean> {
    return task.strandId ? restore([{ id: task.id, strandId: task.strandId }]) : false
  }

  async function undo(): Promise<boolean> {
    return lastDismissed.value ? restore(lastDismissed.value) : false
  }

  /** The list poll delivered server truth: drop overlay entries it confirms. */
  watch(tasks, (list) => {
    const next: Record<string, string | null> = {}
    for (const task of list) {
      if (!(task.id in overlay.value)) continue
      const local = overlay.value[task.id] ?? null
      if ((task.dismissedAt ?? null) === null && local !== null) next[task.id] = local
      else if ((task.dismissedAt ?? null) !== null && local === null) next[task.id] = local
    }
    overlay.value = next
  })

  return { busy, error, conflict, lastDismissed, showHidden, hidden, dismissable, dismissedAtOf, visible, dismiss, restoreTask, undo }
}
