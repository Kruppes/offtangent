/**
 * useStrandContext — context gauge and strand context of one strand (W4b).
 *
 * Shared per strand (module state) so the ring in the header and the panel
 * read one request. `refresh()` re-reads after a finished turn.
 */
import { shallowRef, watch, type MaybeRefOrGetter, toValue } from 'vue'
import type { StrandDeletePreview } from '@axiom/core'
import { PROJECTS_PATH, STRAND_CONTEXT_PATH, STRAND_FACTS_PREVIEW_PATH } from '~/api/strandContext'
import { mapContextReport, type StrandContextView } from '~/utils/contextGauge'
import { ApiError } from '~/composables/useApi'

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'error'; offline: boolean }
  | { status: 'ready'; data: T }

export interface StrandBelongings {
  facts: Array<{ id: number; text: string }>
  summaries: number
  toolCalls: number
  messages: number
  projectName: string | null
}

const gauges = shallowRef(new Map<string, LoadState<StrandContextView>>())
const belongings = shallowRef(new Map<string, LoadState<StrandBelongings>>())

function put<T>(store: typeof gauges | typeof belongings, id: string, value: LoadState<T>) {
  const next = new Map(store.value as Map<string, LoadState<T>>)
  next.set(id, value)
  ;(store as { value: Map<string, LoadState<T>> }).value = next
}

function failure(error: unknown): LoadState<never> {
  if (error instanceof ApiError && error.status === 404) return { status: 'unsupported' }
  const offline = !(error instanceof ApiError) || error.status === 0
  return { status: 'error', offline }
}

export function useStrandContext(strandId: MaybeRefOrGetter<string | null>, projectId?: MaybeRefOrGetter<string | null | undefined>) {
  const { apiFetch } = useApi()

  async function loadGauge(id: string) {
    if (!gauges.value.has(id)) put(gauges, id, { status: 'loading' })
    try {
      const raw = await apiFetch<unknown>(STRAND_CONTEXT_PATH(id))
      put(gauges, id, { status: 'ready', data: mapContextReport(raw) })
    } catch (error) {
      put(gauges, id, failure(error))
    }
  }

  async function loadBelongings(id: string) {
    if (!belongings.value.has(id)) put(belongings, id, { status: 'loading' })
    try {
      const pid = toValue(projectId) ?? null
      const [preview, projects] = await Promise.all([
        apiFetch<StrandDeletePreview>(STRAND_FACTS_PREVIEW_PATH(id)),
        pid ? apiFetch<{ projects: Array<{ id: string; name: string }> }>(PROJECTS_PATH).catch(() => ({ projects: [] })) : Promise.resolve({ projects: [] }),
      ])
      put(belongings, id, {
        status: 'ready',
        data: {
          facts: Array.isArray(preview.facts) ? preview.facts : [],
          summaries: preview.summaries ?? 0,
          toolCalls: preview.toolCalls ?? 0,
          messages: preview.messages ?? 0,
          projectName: pid ? projects.projects.find(p => p.id === pid)?.name ?? null : null,
        },
      })
    } catch (error) {
      put(belongings, id, failure(error))
    }
  }

  return {
    gauge: () => {
      const id = toValue(strandId)
      return id ? gauges.value.get(id) ?? { status: 'loading' as const } : { status: 'loading' as const }
    },
    belongings: () => {
      const id = toValue(strandId)
      return id ? belongings.value.get(id) ?? { status: 'loading' as const } : { status: 'loading' as const }
    },
    refreshGauge: () => { const id = toValue(strandId); if (id) void loadGauge(id) },
    refreshBelongings: () => { const id = toValue(strandId); if (id) void loadBelongings(id) },
    /** Load the gauge now and whenever the strand changes. */
    watchGauge: () => watch(() => toValue(strandId), (id) => { if (id) void loadGauge(id) }, { immediate: true }),
    watchBelongings: () => watch(() => [toValue(strandId), toValue(projectId)] as const, ([id]) => { if (id) void loadBelongings(id) }, { immediate: true }),
  }
}

/** Test seam: preset the state of one strand (render specs). */
export function setStrandContextForTest(id: string, gauge: LoadState<StrandContextView> | null, owned: LoadState<StrandBelongings> | null): void {
  const g = new Map(gauges.value)
  const b = new Map(belongings.value)
  if (gauge) g.set(id, gauge); else g.delete(id)
  if (owned) b.set(id, owned); else b.delete(id)
  gauges.value = g
  belongings.value = b
}
