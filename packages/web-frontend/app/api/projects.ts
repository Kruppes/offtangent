import type { Project, CreateProjectInput, UpdateProjectPatch } from '@axiom/core'

export type { Project, CreateProjectInput, UpdateProjectPatch }

export function useProjectsApi() {
  const { apiFetch } = useApi()
  return {
    async list(includeArchived = false) {
      const data = await apiFetch<{ projects: Project[] }>(`/api/projects${includeArchived ? '?include_archived=1' : ''}`)
      return data.projects
    },
    async create(payload: CreateProjectInput) {
      const data = await apiFetch<{ project: Project }>('/api/projects', {
        method: 'POST', body: JSON.stringify(payload),
      })
      return data.project
    },
    async update(id: string, patch: UpdateProjectPatch) {
      const data = await apiFetch<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      })
      return data.project
    },
  }
}
