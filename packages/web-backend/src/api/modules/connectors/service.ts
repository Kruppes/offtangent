import {
  buildAuthorizeUrl,
  clearConnectorConnection,
  connectorRedirectUri,
  createOAuthStateStore,
  disconnectConnector,
  exchangeAuthorizationCode,
  ConnectorLocalModelRejected,
  getConfiguredPublicBaseUrl,
  getConnectorClientSecret,
  getConnectorLocalModelStatus,
  getConnectorManifest,
  getConnectorRecord,
  listConnectorManifests,
  listStrictlyLocalModels,
  resolveConnectorStatus,
  saveConnectorTokens,
  setConnectorLocalModel,
  setConnectorClient,
  testConnector,
  toSafeConnectorState,
} from '@axiom/core'
import type {
  ConnectorLocalModelRef,
  ConnectorLocalModelStatus,
  ConnectorManifest,
  ConnectorTestResult,
  OAuthStateStore,
  SafeConnectorState,
} from '@axiom/core'
import type { ConnectorCallbackErrorContract } from '@axiom/core/contracts'

export interface ConnectorsServiceOptions {
  /** Injectable for tests; production uses the built-in registry. */
  listManifests?: () => ConnectorManifest[]
  getManifest?: (id: string) => ConnectorManifest | null
  stateStore?: OAuthStateStore
  fetchImpl?: typeof fetch
}

export type CallbackOutcome =
  | { kind: 'connected'; connectorId: string }
  | { kind: 'error'; error: ConnectorCallbackErrorContract }

export interface ConnectorsService {
  baseUrl: (requestBaseUrl: string) => string
  list: (requestBaseUrl: string) => SafeConnectorState[]
  get: (id: string, requestBaseUrl: string) => SafeConnectorState | null
  setClient: (id: string, input: { clientId: string; clientSecret?: string }, requestBaseUrl: string) => SafeConnectorState | null
  startAuthorize: (id: string, requestBaseUrl: string) => { url: string } | { error: ConnectorCallbackErrorContract }
  handleCallback: (id: string, query: { state?: string; code?: string; error?: string }) => Promise<CallbackOutcome>
  test: (id: string) => Promise<ConnectorTestResult | null>
  disconnect: (id: string) => Promise<boolean>
  /** Status line of the sub-agent's local model, plus the selectable pairs. */
  localModel: () => Promise<{ status: ConnectorLocalModelStatus; options: ConnectorLocalModelRef[] }>
  /** Write `connectors.localModel`; rejects a pair that is not strictly local. */
  setLocalModel: (input: { providerId: string; modelId: string }) =>
    Promise<{ status: ConnectorLocalModelStatus; options: ConnectorLocalModelRef[] } | { error: 'not_strictly_local' }>
}

export function createConnectorsService(options: ConnectorsServiceOptions = {}): ConnectorsService {
  const listManifests = options.listManifests ?? listConnectorManifests
  const getManifest = options.getManifest ?? getConnectorManifest
  const stateStore = options.stateStore ?? createOAuthStateStore()
  const fetchImpl = options.fetchImpl

  /**
   * ONLY the configured `PUBLIC_BASE_URL` counts.
   *
   * The request host is attacker controlled (`Host`, `X-Forwarded-Host`): a
   * forged header would put a foreign origin into the `redirect_uri` of the
   * consent screen, and Google echoes that value back. A missing configuration
   * is therefore a clear error, never a guess. `requestBaseUrl` is still
   * accepted as a parameter so the signature stays stable, but it is ignored.
   */
  const resolveBaseUrl = (_requestBaseUrl: string): string => getConfiguredPublicBaseUrl()

  const project = (manifest: ConnectorManifest, requestBaseUrl: string): SafeConnectorState =>
    toSafeConnectorState(
      manifest,
      getConnectorRecord(manifest.id),
      connectorRedirectUri(manifest.id, resolveBaseUrl(requestBaseUrl)),
    )

  return {
    baseUrl: resolveBaseUrl,

    list(requestBaseUrl) {
      return listManifests().map(manifest => project(manifest, requestBaseUrl))
    },

    get(id, requestBaseUrl) {
      const manifest = getManifest(id)
      return manifest ? project(manifest, requestBaseUrl) : null
    },

    setClient(id, input, requestBaseUrl) {
      const manifest = getManifest(id)
      if (!manifest) return null
      setConnectorClient(id, input)
      return project(manifest, requestBaseUrl)
    },

    startAuthorize(id, requestBaseUrl) {
      const manifest = getManifest(id)
      if (!manifest) return { error: 'unknown_connector' }
      if (manifest.auth !== 'oauth2' || !manifest.oauth) return { error: 'not_configured' }

      // Without a configured public base URL there is no trustworthy redirect
      // URI. Saying so beats starting a flow that ends on a foreign host — and
      // it is checked before the client data, because it is the operator's
      // server configuration that is missing, not the connector's.
      if (!resolveBaseUrl(requestBaseUrl)) return { error: 'public_base_url_missing' }

      const record = getConnectorRecord(id)
      if (!record.clientId || !record.clientSecret) return { error: 'not_configured' }

      const redirectUri = connectorRedirectUri(id, resolveBaseUrl(requestBaseUrl))
      if (!redirectUri) return { error: 'not_configured' }

      const created = stateStore.create(id, redirectUri)
      return {
        url: buildAuthorizeUrl({
          manifest,
          clientId: record.clientId,
          redirectUri,
          state: created.state,
          codeChallenge: created.codeChallenge,
        }),
      }
    },

    async handleCallback(id, query) {
      const manifest = getManifest(id)
      if (!manifest?.oauth) return { kind: 'error', error: 'unknown_connector' }

      // The state is consumed first and unconditionally: a replayed callback
      // must find nothing left, whatever else the query carries.
      const pending = query.state ? stateStore.consume(query.state) : null
      if (!pending || pending.connectorId !== id) return { kind: 'error', error: 'invalid_state' }
      if (query.error || !query.code) return { kind: 'error', error: 'denied' }

      const record = getConnectorRecord(id)
      if (!record.clientId || !record.clientSecret) return { kind: 'error', error: 'not_configured' }

      try {
        const tokens = await exchangeAuthorizationCode({
          tokenUrl: manifest.oauth.tokenUrl,
          clientId: record.clientId,
          clientSecret: getConnectorClientSecret(id),
          code: query.code,
          codeVerifier: pending.codeVerifier,
          redirectUri: pending.redirectUri,
          fetchImpl,
        })
        if (!tokens.refreshToken && !record.refreshToken) {
          // Without a refresh token the connection would die within the hour.
          clearConnectorConnection(id)
          return { kind: 'error', error: 'exchange_failed' }
        }
        saveConnectorTokens(id, tokens)
        return { kind: 'connected', connectorId: id }
      } catch {
        // No upstream message, no stack: the browser only learns the class.
        return { kind: 'error', error: 'exchange_failed' }
      }
    },

    async test(id) {
      const manifest = getManifest(id)
      if (!manifest) return null
      if (!manifest.test) return { ok: false, detail: 'not_supported' }
      const status = resolveConnectorStatus(manifest, getConnectorRecord(id))
      if (status === 'not_configured' || status === 'disconnected') return { ok: false, detail: 'not_connected' }
      return testConnector(manifest, { fetchImpl })
    },

    async disconnect(id) {
      const manifest = getManifest(id)
      if (!manifest) return false
      await disconnectConnector(manifest, { fetchImpl })
      return true
    },

    async localModel() {
      return {
        status: await getConnectorLocalModelStatus({ fetchImpl }),
        options: listStrictlyLocalModels(),
      }
    },

    async setLocalModel(input) {
      try {
        setConnectorLocalModel(input)
      } catch (err) {
        if (err instanceof ConnectorLocalModelRejected) return { error: 'not_strictly_local' }
        throw err
      }
      return {
        status: await getConnectorLocalModelStatus({ fetchImpl }),
        options: listStrictlyLocalModels(),
      }
    },
  }
}
