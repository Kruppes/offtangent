import type { Thread, Project } from '@axiom/core'
export type NowStrand = Thread
export interface NowSet { strands: NowStrand[]; max: number }
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
