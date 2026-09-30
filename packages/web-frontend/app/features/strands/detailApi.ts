import type { Thread, StrandDeletePreview } from '@axiom/core'
import type { StrandModelDetail } from '~/api/models'
import { ApiError } from '~/composables/useApi'

export type StrandDetail = Thread & StrandModelDetail
export function strandErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.body?.code === 'strand_busy') return 'strandDetail.busy'
    if (error.status === 409) return 'strandDetail.conflict'
    if (error.status === 404) return 'strandDetail.notFound'
  }
  return 'strandDetail.error'
}
export function useStrandDetailApi() {
  const { apiFetch } = useApi()
  const path = (id: string) => `/api/strands/${encodeURIComponent(id)}`
  return {
    async get(id: string) { return (await apiFetch<{ strand: StrandDetail }>(path(id))).strand },
    async patch(id: string, patch: { title?: string | null; pinned?: boolean; archived?: boolean }) {
      return (await apiFetch<{ strand: Thread }>(path(id), { method: 'PATCH', body: JSON.stringify(patch) })).strand
    },
    preview(id: string) { return apiFetch<StrandDeletePreview>(`${path(id)}/delete-preview`) },
    remove(id: string, deleteFacts = false) {
      return apiFetch(`${path(id)}?confirm=1&delete_facts=${deleteFacts ? '1' : '0'}`, { method: 'DELETE' })
    },
    async tags(id: string, tags: string[]) {
      return (await apiFetch<{ strand: Thread }>(`${path(id)}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) })).strand
    },
    async project(id: string, projectId: string | null) {
      return (await apiFetch<{ thread: Thread }>(`/api/threads/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ projectId }) })).thread
    },
    async suggestion(id: string, action: 'accept' | 'dismiss') {
      return (await apiFetch<{ strand: Thread }>(`${path(id)}/project-suggestion/${action}`, { method: 'POST' })).strand
    },
  }
}
