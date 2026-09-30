import { computed, ref } from 'vue'
import { useProjectsApi, type Project, type CreateProjectInput } from '~/api/projects'

export function projectColor(color: string | null) {
  return color && /^#[\da-f]{6}$/i.test(color) ? color : undefined
}

export function validateProject(payload: CreateProjectInput): 'nameError' | 'colorError' | null {
  if (!payload.name.trim() || payload.name.trim().length > 80) return 'nameError'
  if (payload.color?.trim() && !projectColor(payload.color.trim())) return 'colorError'
  return null
}

export function useProjects(api = useProjectsApi()) {
  const items = ref<Project[]>([])
  const loading = ref(true)
  const loadError = ref(false)
  const saving = ref(false)
  const mutationError = ref<string | null>(null)
  const archived = ref(false)
  const visible = computed(() => items.value.filter(p => p.archived === archived.value))
  let request = 0

  async function fetchProjects(background = false) {
    const current = ++request
    if (!background) loading.value = true
    loadError.value = false
    try {
      const result = await api.list(true)
      if (current === request) items.value = result
    } catch {
      if (current === request) loadError.value = true
    } finally {
      if (current === request) loading.value = false
    }
  }

  function load() { return fetchProjects() }
  function refreshCounts() { return fetchProjects(true) }

  function replace(project: Project) {
    items.value = [...items.value.filter(p => p.id !== project.id), project]
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
  }

  async function save(payload: CreateProjectInput, id?: string) {
    if (saving.value) return false
    mutationError.value = validateProject(payload)
    if (mutationError.value) return false
    saving.value = true
    try {
      const normalized = { name: payload.name.trim(), color: payload.color?.trim().toLowerCase() || null }
      replace(id ? await api.update(id, normalized) : await api.create(normalized))
      return true
    } catch {
      mutationError.value = 'saveError'
      return false
    } finally {
      saving.value = false
    }
  }

  async function setArchived(project: Project) {
    if (saving.value) return false
    saving.value = true
    mutationError.value = null
    try {
      replace(await api.update(project.id, { archived: !project.archived }))
      return true
    } catch {
      mutationError.value = 'saveError'
      return false
    } finally {
      saving.value = false
    }
  }

  return { items, visible, archived, loading, loadError, saving, mutationError, load, refreshCounts, save, setArchived }
}
