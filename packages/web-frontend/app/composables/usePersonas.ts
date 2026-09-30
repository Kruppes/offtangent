import { usePersonasApi } from '~/api/personas'
import type {
  PersonaListItem,
  PersonaDetail,
  PersonaFiles,
  PersonaFields,
  PersonaDeletePreview,
  UpdatePersonaPayload,
  CreatePersonaPayload,
} from '~/api/personas'

export type { PersonaListItem, PersonaDetail, PersonaFiles, PersonaFields, PersonaDeletePreview }

export function usePersonas() {
  const api = usePersonasApi()

  const personas = ref<PersonaListItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Every call funnels through here so a failure always leaves the same trace:
   * a readable message in `error` and `null`/`false` for the caller. The
   * backend answers `{ error, code }` and `useApi` already lifts `error` into
   * the thrown message, so there is nothing to translate here.
   */
  async function guard<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      error.value = (err as Error).message
      return fallback
    }
  }

  async function fetchPersonas(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      personas.value = await api.listPersonas()
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  async function getPersona(id: string): Promise<PersonaDetail | null> {
    return guard(() => api.getPersona(id), null)
  }

  async function updatePersona(id: string, payload: UpdatePersonaPayload): Promise<PersonaDetail | null> {
    error.value = null
    const result = await guard(() => api.updatePersona(id, payload), null)
    if (result) await fetchPersonas()
    return result
  }

  async function createPersona(payload: CreatePersonaPayload): Promise<PersonaDetail | null> {
    error.value = null
    const result = await guard(() => api.createPersona(payload), null)
    if (result) await fetchPersonas()
    return result
  }

  async function archivePersona(id: string, archived: boolean): Promise<PersonaDetail | null> {
    return updatePersona(id, { archived })
  }

  async function makeDefault(id: string): Promise<PersonaDetail | null> {
    return updatePersona(id, { isDefault: true })
  }

  async function getDeletePreview(id: string): Promise<PersonaDeletePreview | null> {
    return guard(() => api.getDeletePreview(id), null)
  }

  async function deletePersona(id: string): Promise<boolean> {
    error.value = null
    const ok = await guard(async () => { await api.deletePersona(id); return true }, false)
    if (ok) await fetchPersonas()
    return ok
  }

  return {
    personas,
    loading,
    error,
    fetchPersonas,
    getPersona,
    updatePersona,
    createPersona,
    archivePersona,
    makeDefault,
    getDeletePreview,
    deletePersona,
  }
}
