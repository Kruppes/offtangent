export interface ResolvedRoleModel {
  providerId: string
  providerName: string
  modelId: string
}

export interface ModelPolicyRoleEntry {
  role: string
  value: string
  source: 'role' | 'legacy' | 'active'
  legacyField?: string
  resolved: ResolvedRoleModel | null
  warning?: string
}

export interface ModelPolicyResponse {
  roles: Record<string, string>
  default: (ResolvedRoleModel & { composite: string }) | null
  policy: ModelPolicyRoleEntry[]
}

export interface ModelPolicyResolveStep {
  step: string
  value: string | null
  taken: boolean
  reason: string
}

export interface ModelPolicyResolveResponse {
  role: string
  kind: string | null
  agentId: string | null
  steps: ModelPolicyResolveStep[]
  resolved: ResolvedRoleModel | null
}

/** Client for the admin-only `/api/model-policy` endpoints. */
export function useModelPolicyApi() {
  const { apiFetch } = useApi()

  const getModelPolicy = () => apiFetch<ModelPolicyResponse>('/api/model-policy')

  const updateModelPolicy = (roles: Record<string, string>) =>
    apiFetch<ModelPolicyResponse>('/api/model-policy', {
      method: 'PUT',
      body: JSON.stringify({ roles }),
    })

  const resolveRole = (params: { role: string; kind?: string; agentId?: string }) => {
    const query = new URLSearchParams({ role: params.role })
    if (params.kind) query.set('kind', params.kind)
    if (params.agentId) query.set('agentId', params.agentId)
    return apiFetch<ModelPolicyResolveResponse>(`/api/model-policy/resolve?${query.toString()}`)
  }

  return { getModelPolicy, updateModelPolicy, resolveRole }
}
