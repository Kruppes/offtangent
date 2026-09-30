import { auditExplicitModelFor, CN_PROVIDER_TYPES, checkAutomaticModelFor, type ProviderPolicyView } from './data-policy.js'

export type ModelResolutionSource = 'turn' | 'strand' | 'persona' | 'global' | 'fallback'

export interface ModelSelection {
  providerId: string
  modelId: string
}

export interface EffectiveModel extends ModelSelection {
  source: ModelResolutionSource
  degradedReason?: string
}

export interface ModelResolutionInput {
  turnOverride?: ModelSelection | null
  strandPin?: ModelSelection | null
  personaPin?: ModelSelection | null
  globalActive?: ModelSelection | null
  fallback?: ModelSelection | null
  providers: ReadonlyArray<{
    id: string
    providerType: string
    enabledModels?: string[]
    status?: 'connected' | 'error' | 'untested'
    modelStatuses?: Record<string, 'connected' | 'error' | 'untested'>
    /** Optional, only needed so the data-policy gate can derive a policy. */
    name?: string
    baseUrl?: string
    dataPolicy?: ProviderPolicyView['dataPolicy']
    models?: ProviderPolicyView['models']
  }>
}

/**
 * Provider types that must never become a silent automatic choice.
 *
 * The rule itself now lives in `data-policy.ts` (region `cn`), which is the
 * ONE function every automatic model choice passes through. This export is
 * kept as an alias of that single source so existing callers and the public
 * package surface keep working.
 *
 * @deprecated Use `checkAutomaticModel()` / `CN_PROVIDER_TYPES` instead.
 */
export const AUTO_FORBIDDEN_PROVIDER_TYPES: ReadonlySet<string> = CN_PROVIDER_TYPES

function unusableReason(
  selection: ModelSelection,
  providers: ModelResolutionInput['providers'],
  source: ModelResolutionSource,
): string | null {
  const provider = providers.find(entry => entry.id === selection.providerId)
  if (!provider) return `${source}:provider_missing:${selection.providerId}`
  if (!(provider.enabledModels ?? []).includes(selection.modelId)) {
    return `${source}:model_missing_or_disabled:${selection.providerId}:${selection.modelId}`
  }
  if (provider.modelStatuses?.[selection.modelId] === 'error') {
    return `${source}:model_error:${selection.providerId}:${selection.modelId}`
  }
  if (source === 'fallback') {
    // The automatic fallback is an automatic choice: same gate as the router,
    // the policy roles and the spoken summary (data-policy.ts).
    const gate = checkAutomaticModelFor(provider as ProviderPolicyView, selection.modelId, 'fallback')
    if (!gate.allowed) {
      return `${source}:provider_not_allowed_for_auto_selection:${selection.providerId}:${gate.reason}`
    }
  }
  return null
}

/** Resolve one turn without side effects, preserving the full priority chain. */
export function resolveEffectiveModel(input: ModelResolutionInput): EffectiveModel | null {
  const candidates: Array<[ModelResolutionSource, ModelSelection | null | undefined]> = [
    ['turn', input.turnOverride],
    ['strand', input.strandPin],
    ['persona', input.personaPin],
    ['global', input.globalActive],
    ['fallback', input.fallback],
  ]
  const degraded: string[] = []
  for (const [source, selection] of candidates) {
    if (!selection) continue
    const reason = unusableReason(selection, input.providers, source)
    if (reason) {
      degraded.push(reason)
      continue
    }
    if (source !== 'fallback') {
      // An explicit choice (turn override, strand or persona pin, the globally
      // selected model) is never blocked — D7 — but it IS written to the audit
      // ring, so the log shows every endpoint that saw data.
      const provider = input.providers.find(entry => entry.id === selection.providerId)
      if (provider) auditExplicitModelFor(provider as ProviderPolicyView, selection.modelId, source)
    }
    return {
      ...selection,
      source,
      ...(degraded.length > 0 ? { degradedReason: degraded.join('; ') } : {}),
    }
  }
  return null
}
