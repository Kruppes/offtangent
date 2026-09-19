import {
  buildModel,
  getProviderDefaultModel,
  loadMultiPersonaSettings,
  loadProvidersDecrypted,
  loadProvidersMasked,
  parseProviderModelId,
  resolveEffectiveModel,
} from '@axiom/core'
import type { Database, EffectiveModel, ModelSelection, ProviderConfig } from '@axiom/core'
import type { ProviderQuotaContract, ProviderStatusContract } from '@axiom/core/contracts'
import { mapProvidersListResponse } from './api/modules/providers/mapper.js'

export interface SelectableModel {
  providerId: string
  providerName: string
  modelId: string
  displayName: string
  contextWindow: number | null
  status: ProviderStatusContract
  selectable: boolean
  unavailableReason: string | null
  isActive: boolean
  isFallback: boolean
  quota: ProviderQuotaContract | null
}

export function listSelectableModels(quota: Record<string, ProviderQuotaContract> = {}): SelectableModel[] {
  const file = loadProvidersDecrypted()
  // Reuse the existing provider mapper/masking boundary before deriving the
  // public catalog. Model metadata is joined to the decrypted provider only
  // for buildModel(); no provider object or credential is returned.
  const publicFile = mapProvidersListResponse(loadProvidersMasked(), file, quota)
  return publicFile.providers.flatMap(publicProvider => (publicProvider.enabledModels ?? []).map(modelId => {
    const provider = file.providers.find(candidate => candidate.id === publicProvider.id)!
    const status = publicProvider.modelStatuses?.[modelId] ?? publicProvider.status ?? 'untested'
    const override = publicProvider.models?.find(model => model.id === modelId)
    let contextWindow: number | null = override?.contextWindow ?? null
    let displayName = override?.name || modelId
    try {
      const built = buildModel(provider, modelId)
      contextWindow ??= built.contextWindow ?? null
      displayName = override?.name || built.name || modelId
    } catch {
      // A custom model may not be in pi-ai's static registry; configured
      // metadata above remains the safe display fallback.
    }
    return {
      providerId: publicProvider.id,
      providerName: publicProvider.name,
      modelId,
      displayName,
      contextWindow,
      status,
      selectable: status !== 'error',
      unavailableReason: status === 'error' ? 'Modelltest fehlgeschlagen' : null,
      isActive: file.activeProvider === provider.id
        && (file.activeModel ?? getProviderDefaultModel(provider)) === modelId,
      isFallback: file.fallbackProvider === provider.id
        && (file.fallbackModel ?? getProviderDefaultModel(provider)) === modelId,
      quota: publicProvider.quota ?? null,
    }
  }))
}

function pair(providerId?: string | null, modelId?: string | null): ModelSelection | null {
  return providerId && modelId ? { providerId, modelId } : null
}

export function effectiveModelForStrand(db: Database, strandId: string, turnOverride?: ModelSelection | null): EffectiveModel | null {
  const file = loadProvidersDecrypted()
  const row = db.prepare(
    'SELECT agent_id, model_provider_id, model_id FROM sessions WHERE id = ?',
  ).get(strandId) as { agent_id: string | null; model_provider_id: string | null; model_id: string | null } | undefined
  if (!row) return null
  const personaSpec = loadMultiPersonaSettings().perAgentProvider?.[row.agent_id ?? 'main']
  const persona = personaSpec ? parseProviderModelId(personaSpec) : null
  return resolveEffectiveModel({
    turnOverride,
    strandPin: pair(row.model_provider_id, row.model_id),
    personaPin: pair(persona?.providerId, persona?.modelId),
    globalActive: pair(file.activeProvider, file.activeModel),
    fallback: pair(file.fallbackProvider, file.fallbackModel),
    providers: file.providers,
  })
}

export function getProvider(providerId: string): ProviderConfig | null {
  return loadProvidersDecrypted().providers.find(provider => provider.id === providerId) ?? null
}

/** Validate explicit choices against the very same catalog exposed by GET /api/models.
 * Missing means inherit; null/partial/empty pairs are never silently ignored.
 */
export function parseTurnModelSelection(body: { modelProviderId?: unknown; modelId?: unknown }):
  | { ok: true; value: ModelSelection | undefined }
  | { ok: false; error: string; code: string } {
  const { modelProviderId, modelId } = body
  if (modelProviderId === undefined && modelId === undefined) return { ok: true, value: undefined }
  if (typeof modelProviderId !== 'string' || !modelProviderId.trim()
    || typeof modelId !== 'string' || !modelId.trim()) {
    return { ok: false, code: 'invalid_model_pin', error: 'modelProviderId and modelId must both be non-empty strings, or both omitted' }
  }
  const selection = { providerId: modelProviderId.trim(), modelId: modelId.trim() }
  if (!listSelectableModels().some(model => model.providerId === selection.providerId
    && model.modelId === selection.modelId && model.selectable)) {
    return { ok: false, code: 'model_unavailable', error: 'Provider/model does not exist, is disabled, or is unavailable' }
  }
  return { ok: true, value: selection }
}
