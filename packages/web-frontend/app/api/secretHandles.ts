import type { SecretHandleKind, SecretHandleMeta } from '@axiom/core/contracts'

export interface SecretHandleListResponse {
  handles: SecretHandleMeta[]
  kinds: readonly string[]
}

export interface SecretHandleCreateResponse {
  slug: string
  handle: string
  kind: string
}

export interface SecretHandleRenameResponse {
  slug: string
  handle: string
}

/**
 * Client for `/api/secrets/handles` (plan 2026-09-26, step 1).
 *
 * There is no "get value" call by design: the API never returns a stored value,
 * so neither does this client.
 */
export function useSecretHandlesApi() {
  const { apiFetch } = useApi()

  const listSecretHandles = () => apiFetch<SecretHandleListResponse>('/api/secrets/handles')

  const createSecretHandle = (input: { value: string; kind: SecretHandleKind | string; slug?: string }) =>
    apiFetch<SecretHandleCreateResponse>('/api/secrets/handles', {
      method: 'POST',
      body: JSON.stringify({
        value: input.value,
        kind: input.kind,
        ...(input.slug ? { slug: input.slug } : {}),
      }),
    })

  const renameSecretHandle = (slug: string, nextSlug: string) =>
    apiFetch<SecretHandleRenameResponse>(`/api/secrets/handles/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ slug: nextSlug }),
    })

  const deleteSecretHandle = (slug: string) =>
    apiFetch<{ slug: string; removed: boolean }>(`/api/secrets/handles/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    })

  return { listSecretHandles, createSecretHandle, renameSecretHandle, deleteSecretHandle }
}
