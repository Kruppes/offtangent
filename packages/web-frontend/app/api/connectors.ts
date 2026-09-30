import type {
  ConnectorContract,
  ConnectorsListResponseContract,
  ConnectorTestResponseContract,
} from '@axiom/core/contracts'

export type Connector = ConnectorContract

/** Status line of the sub-agent's local model (P2). */
export interface ConnectorLocalModelState {
  configured: boolean
  fromSetting: boolean
  providerId: string
  modelId: string
  providerName: string
  strictlyLocal: boolean
  reachable: boolean | null
}

export interface ConnectorLocalModelResponse {
  status: ConnectorLocalModelState
  options: Array<{ providerId: string; modelId: string }>
}

export interface ConnectorClientInput {
  clientId: string
  clientSecret?: string
}

export function useConnectorsApi() {
  const { apiFetch } = useApi()

  const listConnectors = () =>
    apiFetch<ConnectorsListResponseContract>('/api/connectors')

  const setClient = (id: string, payload: ConnectorClientInput) =>
    apiFetch<{ connector: Connector }>(`/api/connectors/${id}/client`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    })

  /**
   * Asks for JSON so the admin token stays in the Authorization header; the
   * caller then navigates to the returned consent URL.
   */
  const startAuthorize = (id: string) =>
    apiFetch<{ url: string }>(`/api/connectors/${id}/authorize`, { headers: { accept: 'application/json' } })

  const testConnector = (id: string) =>
    apiFetch<ConnectorTestResponseContract>(`/api/connectors/${id}/test`, { method: 'POST' })

  const disconnect = (id: string) =>
    apiFetch<{ connector: Connector }>(`/api/connectors/${id}/connection`, { method: 'DELETE' })

  const getLocalModel = () =>
    apiFetch<ConnectorLocalModelResponse>('/api/connectors/local-model')

  const setLocalModel = (payload: { providerId: string; modelId: string }) =>
    apiFetch<ConnectorLocalModelResponse>('/api/connectors/local-model', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })

  return { listConnectors, setClient, startAuthorize, testConnector, disconnect, getLocalModel, setLocalModel }
}
