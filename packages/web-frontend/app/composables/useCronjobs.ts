export type CronjobActionType = 'task' | 'injection'

export interface Cronjob {
  id: string
  name: string
  prompt: string
  schedule: string
  scheduleHuman: string
  actionType: CronjobActionType
  provider: string | null
  enabled: boolean
  toolsOverride: string | null
  skillsOverride: string | null
  systemPromptOverride: string | null
  attachedSkills: string[] | null
  lastRunAt: string | null
  lastRunTaskId: string | null
  lastRunStatus: string | null
  createdAt: string
  updatedAt: string
}

interface CronjobsResponse {
  cronjobs: Cronjob[]
}

interface CronjobResponse {
  cronjob: Cronjob
}

/**
 * Shape returned by `GET /api/cronjobs/meta`. Used by the cronjob form
 * to render tool/skill lists dynamically so toggles always reflect the
 * current runtime instead of a hardcoded copy.
 */
export interface CronjobMeta {
  /** Tool names available to background task agents. */
  tools: string[]
  /** Installed skills (`owner/name`). Used for skill overrides + attached skills. */
  installedSkills: Array<{
    id: string
    name: string
    description: string
    emoji?: string
    enabled: boolean
  }>
  /** Agent skills (self-created, under `/data/skills_agent/<name>/`). */
  agentSkills: Array<{ name: string; description: string }>
}

export interface CronjobFormData {
  name: string
  prompt: string
  schedule: string
  actionType?: CronjobActionType
  provider?: string
  enabled?: boolean
  toolsOverride?: string | null
  skillsOverride?: string | null
  systemPromptOverride?: string | null
  attachedSkills?: string[] | null
}

export function useCronjobs() {
  const { apiFetch } = useApi()

  const cronjobs = ref<Cronjob[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const success = ref<string | null>(null)

  async function fetchCronjobMeta(): Promise<CronjobMeta> {
    return apiFetch<CronjobMeta>('/api/cronjobs/meta')
  }

  async function loadCronjobs() {
    loading.value = true
    error.value = null

    try {
      const data = await apiFetch<CronjobsResponse>('/api/cronjobs')
      cronjobs.value = data.cronjobs
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function createCronjob(form: CronjobFormData): Promise<Cronjob | null> {
    error.value = null
    try {
      const data = await apiFetch<CronjobResponse>('/api/cronjobs', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      await loadCronjobs()
      return data.cronjob
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function updateCronjob(id: string, form: Partial<CronjobFormData>): Promise<Cronjob | null> {
    error.value = null
    try {
      const data = await apiFetch<CronjobResponse>(`/api/cronjobs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(form),
      })
      await loadCronjobs()
      return data.cronjob
    } catch (err) {
      error.value = (err as Error).message
      return null
    }
  }

  async function deleteCronjob(id: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch<{ success: boolean }>(`/api/cronjobs/${id}`, {
        method: 'DELETE',
      })
      await loadCronjobs()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function toggleCronjob(id: string, enabled: boolean): Promise<boolean> {
    error.value = null
    try {
      await apiFetch<CronjobResponse>(`/api/cronjobs/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      })
      await loadCronjobs()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  async function triggerCronjob(id: string): Promise<boolean> {
    error.value = null
    try {
      await apiFetch<{ taskId: string; message: string }>(`/api/cronjobs/${id}/trigger`, {
        method: 'POST',
      })
      await loadCronjobs()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    }
  }

  function clearSuccess() {
    success.value = null
  }

  return {
    cronjobs,
    loading,
    error,
    success,
    loadCronjobs,
    createCronjob,
    updateCronjob,
    deleteCronjob,
    toggleCronjob,
    triggerCronjob,
    fetchCronjobMeta,
    clearSuccess,
  }
}
