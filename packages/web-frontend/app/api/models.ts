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
  /** What the NEXT turn will use (pin, else persona/global/fallback). */
  effectiveModel: EffectiveModel | null
  /**
   * The model that is answering right now, frozen when the running turn
   * started, or null when no turn runs. Present on `GET /api/strands/:id`
   * only; `PATCH .../model` answers about the configuration, not a live turn.
   * Incident 2026-09-24: a global model switch during a running turn made the
   * header claim the new model was producing the answer.
   */
  runningTurnModel?: EffectiveModel | null
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
