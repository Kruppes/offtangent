import type { ProviderQuotaContract } from '@axiom/core/contracts'

export type ModelSource = 'turn' | 'strand' | 'persona' | 'global' | 'fallback'
export interface ModelSelection { providerId: string; modelId: string }
export interface EffectiveModel extends ModelSelection { source: ModelSource; degradedReason?: string }
export interface SelectableModel extends ModelSelection {
  providerName: string
  displayName: string
  contextWindow: number | null
  status: 'connected' | 'error' | 'untested'
  selectable: boolean
  unavailableReason: string | null
  isActive: boolean
  isFallback: boolean
  quota: ProviderQuotaContract | null
}
export interface StrandModelDetail {
  pinnedModel: ModelSelection | null
  effectiveModel: EffectiveModel | null
}

export function useModelsApi() {
  const { apiFetch } = useApi()
  return {
    async listModels() {
      return (await apiFetch<{ models: SelectableModel[] }>('/api/models')).models ?? []
    },
    async getStrand(id: string) {
      const response = await apiFetch<{ strand: StrandModelDetail }>(`/api/strands/${encodeURIComponent(id)}`)
      return response.strand
    },
    async setStrandModel(id: string, selection: ModelSelection | null) {
      return apiFetch<StrandModelDetail>(`/api/strands/${encodeURIComponent(id)}/model`, {
        method: 'PATCH',
        body: JSON.stringify(selection ?? { providerId: null, modelId: null }),
      })
    },
  }
}
