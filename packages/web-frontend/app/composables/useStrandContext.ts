/**
 * useStrandContext — context gauge and strand context of one strand (W4b).
 *
 * Shared per strand (module state) so the ring in the header and the panel
 * read one request. `refresh()` re-reads after a finished turn.
 */
import { shallowRef, watch, type MaybeRefOrGetter, toValue } from 'vue'
import { PROJECTS_PATH, STRAND_CONTEXT_PATH } from '~/api/strandContext'
import { STRAND_FACTS_PATH, mapFacts, mapRecalled, type RecalledMessage } from '~/api/strandW5b'
import { mapContextReport, type StrandContextView } from '~/utils/contextGauge'
import { ApiError } from '~/composables/useApi'

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'unsupported' }
  | { status: 'error'; offline: boolean }
  | { status: 'ready'; data: T }

export interface StrandBelongings {
  facts: Array<{ id: number; text: string }>
  /** All facts of the strand; `facts` may be capped by the server. */
  factsTotal?: number
  summaries: number
  toolCalls: number
  /** No longer filled since W5b (the fact list carries no message count). */
  messages?: number
  projectName: string | null
}

const gauges = shallowRef(new Map<string, LoadState<StrandContextView>>())
/** W5b: messages the agent fetched back for this strand, from the same context report. */
const recalledLists = shallowRef(new Map<string, RecalledMessage[]>())
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
      const nextRecalled = new Map(recalledLists.value)
      nextRecalled.set(id, mapRecalled(raw))
      recalledLists.value = nextRecalled
      put(gauges, id, { status: 'ready', data: mapContextReport(raw) })
    } catch (error) {
      put(gauges, id, failure(error))
    }
  }

  async function loadBelongings(id: string) {
    if (!belongings.value.has(id)) put(belongings, id, { status: 'loading' })
    try {
      const pid = toValue(projectId) ?? null
      // W5b: the slim fact list replaces the delete preview here; the preview
      // itself stays untouched for the delete dialog.
      const [rawFacts, projects] = await Promise.all([
        apiFetch<unknown>(STRAND_FACTS_PATH(id)),
        pid ? apiFetch<{ projects: Array<{ id: string; name: string }> }>(PROJECTS_PATH).catch(() => ({ projects: [] })) : Promise.resolve({ projects: [] }),
      ])
      const preview = mapFacts(rawFacts)
      put(belongings, id, {
        status: 'ready',
        data: {
          facts: preview.facts.map(f => ({ id: f.id, text: f.text })),
          factsTotal: preview.total,
          summaries: preview.summaries,
          toolCalls: preview.toolCalls,
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
    /**
     * Recalled messages of the strand, with the gauge's load state: they come
     * from the same request, so loading and errors are shared.
     */
    recalled: (): LoadState<RecalledMessage[]> => {
      const id = toValue(strandId)
      const state = id ? gauges.value.get(id) : undefined
      if (!id || !state) return { status: 'loading' }
      if (state.status !== 'ready') return state
      return { status: 'ready', data: recalledLists.value.get(id) ?? [] }
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
export function setStrandContextForTest(id: string, gauge: LoadState<StrandContextView> | null, owned: LoadState<StrandBelongings> | null, recalled: RecalledMessage[] = []): void {
  const r = new Map(recalledLists.value)
  r.set(id, recalled)
  recalledLists.value = r
  const g = new Map(gauges.value)
  const b = new Map(belongings.value)
  if (gauge) g.set(id, gauge); else g.delete(id)
  if (owned) b.set(id, owned); else b.delete(id)
  gauges.value = g
  belongings.value = b
}
