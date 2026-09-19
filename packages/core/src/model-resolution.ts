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
  }>
}

/**
 * Provider types that must never become a silent automatic choice
 * (Nicolas 2026-09-13: Chinese cloud providers and Moonshot/Kimi are opt-in
 * only, never a fallback and never a policy role). `zai-coding-plan` is the
 * historical spelling, `zai-coding` the id in the `ProviderType` union; both
 * are listed so neither spelling slips through.
 */
export const AUTO_FORBIDDEN_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'zai', 'zai-coding', 'zai-coding-plan', 'moonshot', 'kimi', 'kimi-coding',
])

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
  if (source === 'fallback' && AUTO_FORBIDDEN_PROVIDER_TYPES.has(provider.providerType)) {
    return `${source}:provider_not_allowed_for_auto_selection:${selection.providerId}`
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
    return {
      ...selection,
      source,
      ...(degraded.length > 0 ? { degradedReason: degraded.join('; ') } : {}),
    }
  }
  return null
}
