import type { ResurfaceItem } from '@axiom/core'
export type { ResurfaceItem }
/** Strands that went quiet a few days ago (SPEC 6.3); snoozing hides one for `days`. */
export function useResurfaceApi() {
  const { apiFetch } = useApi()
  return {
    /** A malformed answer counts as "nothing to resurface", never as a crash. */
    list: async (limit = 3) => (await apiFetch<{ items?: ResurfaceItem[] }>(`/api/resurface?limit=${limit}`)).items ?? [],
    snooze: (strandId: string, days = 7) => apiFetch<void>(`/api/resurface/${encodeURIComponent(strandId)}/snooze`, { method: 'POST', body: JSON.stringify({ days }) }),
  }
}
