export interface ProviderModelSource {
  id: string
  name: string
  enabledModels?: string[]
}

export interface ProviderModelOption {
  value: string
  label: string
}

/** Flattened `providerId:modelId` options for provider/model select dropdowns. */
export function buildProviderModelOptions(providers: ProviderModelSource[]): ProviderModelOption[] {
  return providers.flatMap(provider =>
    (provider.enabledModels ?? []).map(modelId => ({
      value: `${provider.id}:${modelId}`,
      label: `${provider.name} (${modelId})`,
    })),
  )
}

/** Resolve a provider by id or (case-insensitive) display name. */
export function findProviderByKey<T extends ProviderModelSource>(providers: T[], key: string): T | undefined {
  const lowerKey = key.toLowerCase()
  return providers.find(p => p.id === key || p.name.toLowerCase() === lowerKey)
}
