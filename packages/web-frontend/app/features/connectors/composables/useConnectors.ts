import { useConnectorsApi } from '~/api/connectors'
import type { Connector, ConnectorClientInput, ConnectorLocalModelState } from '~/api/connectors'

export type { Connector, ConnectorClientInput, ConnectorLocalModelState } from '~/api/connectors'

/**
 * State of the `/connectors` page. Mirrors `useProviders`: one shared list, one
 * error string the page can recover from, and per-connector busy ids so a card
 * can disable exactly its own buttons.
 */
export function useConnectors() {
  const api = useConnectorsApi()

  const connectors = useState<Connector[]>('connectors_list', () => [])
  const baseUrl = useState<string>('connectors_base_url', () => '')
  const loading = useState<boolean>('connectors_loading', () => false)
  const loaded = useState<boolean>('connectors_loaded', () => false)
  const error = useState<string | null>('connectors_error', () => null)
  const busyId = useState<string | null>('connectors_busy', () => null)
  // P2: which strictly local model the connector sub-agent may use.
  const localModel = useState<ConnectorLocalModelState | null>('connectors_local_model', () => null)

  async function fetchConnectors(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const data = await api.listConnectors()
      connectors.value = data.connectors
      baseUrl.value = data.baseUrl
      loaded.value = true
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  /**
   * One cheap call: the status line of the local model. Failures are silent —
   * the page must still show the connectors when the probe times out.
   */
  async function fetchLocalModel(): Promise<void> {
    try {
      const data = await api.getLocalModel()
      localModel.value = data.status
    } catch {
      localModel.value = null
    }
  }

  function replace(connector: Connector): void {
    connectors.value = connectors.value.map(entry => (entry.id === connector.id ? connector : entry))
  }

  async function saveClient(id: string, input: ConnectorClientInput): Promise<boolean> {
    error.value = null
    busyId.value = id
    try {
      const data = await api.setClient(id, input)
      replace(data.connector)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      busyId.value = null
    }
  }

  /** Leaves the app: the consent screen lives on the provider's domain. */
  async function connect(id: string): Promise<boolean> {
    error.value = null
    busyId.value = id
    try {
      const { url } = await api.startAuthorize(id)
      window.location.assign(url)
      return true
    } catch (err) {
      error.value = (err as Error).message
      busyId.value = null
      return false
    }
  }

  async function testConnector(id: string): Promise<{ ok: boolean; detail: string } | null> {
    error.value = null
    busyId.value = id
    try {
      const result = await api.testConnector(id)
      await fetchConnectors()
      return { ok: result.ok, detail: result.detail }
    } catch (err) {
      error.value = (err as Error).message
      return null
    } finally {
      busyId.value = null
    }
  }

  async function disconnect(id: string): Promise<boolean> {
    error.value = null
    busyId.value = id
    try {
      const data = await api.disconnect(id)
      replace(data.connector)
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      busyId.value = null
    }
  }

  return {
    connectors,
    baseUrl,
    loading,
    loaded,
    error,
    busyId,
    fetchConnectors,
    localModel,
    fetchLocalModel,
    saveClient,
    connect,
    testConnector,
    disconnect,
  }
}
