import { findProviderByKey, type ProviderModelSource } from '../../../utils/providerModelOptions'

/**
 * Stored cronjob provider values come in two shapes: the modern
 * `providerId:modelId` composite and a legacy plain provider name/id.
 */
function splitProviderValue(raw: string): { providerKey: string; modelId?: string; composite: boolean } {
  const colonIdx = raw.indexOf(':')
  if (colonIdx === -1) return { providerKey: raw, composite: false }
  return { providerKey: raw.slice(0, colonIdx), modelId: raw.slice(colonIdx + 1) || undefined, composite: true }
}

/**
 * Human label for a stored provider value: provider name with the model in
 * parens when known. Falls back to the raw value when unresolvable.
 */
export function formatCronjobProvider(raw: string | null | undefined, providers: ProviderModelSource[]): string {
  if (!raw) return ''
  const { providerKey, modelId } = splitProviderValue(raw)
  const match = findProviderByKey(providers, providerKey)
  if (!match) return raw
  const model = modelId ?? match.enabledModels?.[0]
  return model ? `${match.name} (${model})` : match.name
}

/**
 * Convert a stored provider value into the `providerId:modelId` composite used
 * by the provider select. Legacy plain names expand to the provider's first
 * enabled model; unresolvable composites are returned as-is, unresolvable
 * legacy values fall back to '' (default provider).
 */
export function normalizeCronjobProviderValue(raw: string | null | undefined, providers: ProviderModelSource[]): string {
  if (!raw) return ''
  const { providerKey, modelId, composite } = splitProviderValue(raw)
  const match = findProviderByKey(providers, providerKey)
  if (!match) return composite ? raw : ''
  return `${match.id}:${modelId ?? match.enabledModels?.[0] ?? ''}`
}
