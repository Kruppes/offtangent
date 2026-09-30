import type {
  PersonaFilesContract,
  PersonaFieldsContract,
  PersonaListItemContract,
  PersonaDetailContract,
  PersonaDeletePreviewContract,
  UpdatePersonaPayloadContract,
  CreatePersonaPayloadContract,
} from '@axiom/core/contracts'

export type PersonaFiles = PersonaFilesContract
export type PersonaFields = PersonaFieldsContract
export type PersonaListItem = PersonaListItemContract
export type PersonaDetail = PersonaDetailContract
export type PersonaDeletePreview = PersonaDeletePreviewContract
export type UpdatePersonaPayload = UpdatePersonaPayloadContract
export type CreatePersonaPayload = CreatePersonaPayloadContract

export function usePersonasApi() {
  const { apiFetch } = useApi()

  const listPersonas = () => apiFetch<PersonaListItem[]>('/api/personas')

  const getPersona = (id: string) => apiFetch<PersonaDetail>(`/api/personas/${encodeURIComponent(id)}`)

  /**
   * One write endpoint for everything: raw files ("advanced"), structured
   * fields, `archived` and `isDefault`. Fields win over files in the same
   * request, which is what the editor wants when both tabs were touched.
   */
  const updatePersona = (id: string, payload: UpdatePersonaPayload) =>
    apiFetch<PersonaDetail>(`/api/personas/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })

  const createPersona = (payload: CreatePersonaPayload) =>
    apiFetch<PersonaDetail>('/api/personas', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

  /** What a hard delete would take with it. Read only. */
  const getDeletePreview = (id: string) =>
    apiFetch<PersonaDeletePreview>(`/api/personas/${encodeURIComponent(id)}/delete-preview`)

  /** Hard delete. Archive (`updatePersona(id, { archived: true })`) is the default path. */
  const deletePersona = (id: string) =>
    apiFetch<{ message: string }>(`/api/personas/${encodeURIComponent(id)}?confirm=1`, {
      method: 'DELETE',
    })

  return {
    listPersonas,
    getPersona,
    updatePersona,
    createPersona,
    getDeletePreview,
    deletePersona,
  }
}
