import type { Thread, Project, NowSetMode } from '@axiom/core'
export type NowStrand = Thread
/**
 * `mode` says who fills the set: `auto` ranks it from the user's activity
 * (read only — `PUT /api/now` answers 409), `manual` is the curated set. A
 * backend that predates the setting omits it; treat a missing value as
 * `manual`, which is exactly how it behaved before.
 */
export interface NowSet { strands: NowStrand[]; max: number; mode?: NowSetMode }
export function useNowApi() {
  const { apiFetch } = useApi()
  return {
    strand: async (id: string) => (await apiFetch<{ strand: NowStrand }>(`/api/strands/${encodeURIComponent(id)}`)).strand,
    projects: async () => (await apiFetch<{ projects: Project[] }>('/api/projects')).projects,
    get: () => apiFetch<NowSet>('/api/now'),
    replace: (strandIds: string[]) => apiFetch<NowSet>('/api/now', { method: 'PUT', body: JSON.stringify({ strandIds }) }),
    candidates: async () => (await apiFetch<{ strands: NowStrand[] }>('/api/strands?limit=200')).strands,
  }
}
