/**
 * Catalog loader for the OAuth create flow of the provider dialog.
 *
 * The dialog asks the backend for the preset's model catalog while it is open
 * in create mode. That answer can arrive late: the user may have closed the
 * dialog, or reopened it in edit mode for an existing provider of the same
 * type. A late answer must then not touch the form, or it would filter or
 * replace that provider's enabled models.
 *
 * Every load (and every explicit invalidate) starts a new generation. A
 * result, an error or the end of loading is only written while its generation
 * is still the current one and the dialog is still open in create mode for
 * the same OAuth type.
 */

export interface OAuthCatalogContext {
  open: boolean
  mode: 'create' | 'edit'
  providerType: string
  isOAuth: boolean
}

export interface OAuthCatalogHandlers<M> {
  fetchModels: (providerType: string) => Promise<M[]>
  /** Current dialog state, read again after the request returns. */
  context: () => OAuthCatalogContext
  /** A load for `providerType` starts: clear the old list, show loading. */
  onStart: () => void
  /** No load applies (closed, edit mode, no OAuth type): show nothing. */
  onIdle: () => void
  onModels: (models: M[]) => void
  onError: (message: string) => void
  onSettled: () => void
}

export interface OAuthCatalogLoader {
  load: () => Promise<void>
  /** Drop any request in flight, e.g. when the dialog closes. */
  invalidate: () => void
}

/** True while a load started for `providerType` may still write to the form. */
export function isOAuthCatalogResultCurrent(
  started: { generation: number, providerType: string },
  current: { generation: number } & OAuthCatalogContext,
): boolean {
  return started.generation === current.generation
    && current.open
    && current.mode === 'create'
    && current.isOAuth
    && current.providerType === started.providerType
}

/**
 * Selection after the catalog arrived: keep the user's picks that exist in
 * the catalog; if none remain, preselect the first catalog model.
 */
export function selectOAuthCatalogModels(enabled: readonly string[], models: readonly { id: string }[]): string[] {
  const known = new Set(models.map(m => m.id))
  const kept = enabled.filter(id => known.has(id))
  if (kept.length === 0 && models[0]) return [models[0].id]
  return kept
}

export function createOAuthCatalogLoader<M>(handlers: OAuthCatalogHandlers<M>): OAuthCatalogLoader {
  let generation = 0

  function invalidate() {
    generation += 1
  }

  async function load() {
    invalidate()
    const ctx = handlers.context()
    const started = { generation, providerType: ctx.providerType }
    const isCurrent = () => isOAuthCatalogResultCurrent(started, { generation, ...handlers.context() })

    if (!ctx.open || ctx.mode !== 'create' || !ctx.providerType || !ctx.isOAuth) {
      handlers.onIdle()
      return
    }

    handlers.onStart()
    try {
      const models = await handlers.fetchModels(started.providerType)
      if (isCurrent()) handlers.onModels(models)
    } catch (err) {
      if (isCurrent()) handlers.onError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrent()) handlers.onSettled()
    }
  }

  return { load, invalidate }
}
