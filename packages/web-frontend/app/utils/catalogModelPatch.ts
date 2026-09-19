import type { AvailableModelContract, ProviderModelUpdatePayloadContract } from '@axiom/core/contracts'

/**
 * Build the per-model override patch for a model taken from a live provider
 * catalog. Returns null when the entry carries no metadata worth persisting.
 */
export function buildCatalogModelPatch(entry: AvailableModelContract): ProviderModelUpdatePayloadContract | null {
  const patch: ProviderModelUpdatePayloadContract = {}
  if (entry.name && entry.name !== entry.id) patch.name = entry.name
  if (entry.contextWindow) patch.contextWindow = entry.contextWindow
  if (entry.cost) patch.cost = { input: entry.cost.input, output: entry.cost.output }
  return Object.keys(patch).length > 0 ? patch : null
}
