import {
  OAuthTokenError,
  isTokenExpired,
  refreshAccessToken,
  revokeToken,
} from './oauth.js'
import {
  clearConnectorConnection,
  getConnectorAccessTokenRaw,
  getConnectorApiKey,
  getConnectorClientSecret,
  getConnectorRecord,
  getConnectorRefreshToken,
  markConnectorReauthRequired,
  saveConnectorTokens,
} from './store.js'
import type { ConnectorManifest, ConnectorTestResult, ConnectorToolContext } from './types.js'

/** The connector needs a fresh consent — the caller must not retry. */
export class ConnectorReauthRequiredError extends Error {
  constructor(readonly connectorId: string, reason: string) {
    super(`Connector "${connectorId}" needs to be connected again: ${reason}`)
    this.name = 'ConnectorReauthRequiredError'
  }
}

export class ConnectorNotConnectedError extends Error {
  constructor(readonly connectorId: string) {
    super(`Connector "${connectorId}" is not connected`)
    this.name = 'ConnectorNotConnectedError'
  }
}

export interface ConnectorAccessOptions {
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * One refresh per connector at a time. Without this, two parallel tool calls
 * would both spend the refresh token and the second answer would invalidate the
 * first — and on `invalid_grant` both would loop.
 */
const inFlightRefresh = new Map<string, Promise<string>>()

async function refreshAndStore(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions,
): Promise<string> {
  const endpoints = manifest.oauth
  if (!endpoints) throw new Error(`Connector "${manifest.id}" has no OAuth endpoints`)

  const refreshToken = getConnectorRefreshToken(manifest.id)
  if (!refreshToken) throw new ConnectorNotConnectedError(manifest.id)

  const record = getConnectorRecord(manifest.id)
  try {
    const tokens = await refreshAccessToken({
      tokenUrl: endpoints.tokenUrl,
      clientId: record.clientId,
      clientSecret: getConnectorClientSecret(manifest.id),
      refreshToken,
      fetchImpl: options.fetchImpl,
    })
    saveConnectorTokens(manifest.id, tokens)
    return tokens.accessToken
  } catch (err) {
    if (err instanceof OAuthTokenError && err.isInvalidGrant) {
      markConnectorReauthRequired(manifest.id, err.message)
      throw new ConnectorReauthRequiredError(manifest.id, err.message)
    }
    throw err
  }
}

/**
 * Returns a usable access token, refreshing it shortly before expiry. On
 * `invalid_grant` the connector goes to `reauth_required` and the error is
 * terminal: there is no retry loop.
 */
export async function getConnectorAccessToken(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions = {},
): Promise<string> {
  const record = getConnectorRecord(manifest.id)
  if (manifest.auth === 'apiKey') {
    const apiKey = getConnectorApiKey(manifest.id)
    if (!apiKey) throw new ConnectorNotConnectedError(manifest.id)
    return apiKey
  }

  if (record.status === 'reauth_required') {
    throw new ConnectorReauthRequiredError(manifest.id, record.lastError || 'the stored grant was rejected')
  }
  if (!record.refreshToken) throw new ConnectorNotConnectedError(manifest.id)

  const now = options.now?.() ?? Date.now()
  const accessToken = getConnectorAccessTokenRaw(manifest.id)
  if (accessToken && !isTokenExpired(record.expiresAt, now)) return accessToken

  const running = inFlightRefresh.get(manifest.id)
  if (running) return running

  const attempt = refreshAndStore(manifest, options).finally(() => inFlightRefresh.delete(manifest.id))
  inFlightRefresh.set(manifest.id, attempt)
  return attempt
}

/**
 * Refreshes unconditionally, for the one case where the stored expiry lies: the
 * upstream answered `401` although the token looked valid. Shares the in-flight
 * map with {@link getConnectorAccessToken}, so a parallel tool call joins the
 * same refresh instead of spending the refresh token twice.
 */
export async function forceRefreshConnectorAccessToken(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions = {},
): Promise<string> {
  if (manifest.auth === 'apiKey') {
    const apiKey = getConnectorApiKey(manifest.id)
    if (!apiKey) throw new ConnectorNotConnectedError(manifest.id)
    return apiKey
  }

  const record = getConnectorRecord(manifest.id)
  if (record.status === 'reauth_required') {
    throw new ConnectorReauthRequiredError(manifest.id, record.lastError || 'the stored grant was rejected')
  }
  if (!record.refreshToken) throw new ConnectorNotConnectedError(manifest.id)

  const running = inFlightRefresh.get(manifest.id)
  if (running) return running

  const attempt = refreshAndStore(manifest, options).finally(() => inFlightRefresh.delete(manifest.id))
  inFlightRefresh.set(manifest.id, attempt)
  return attempt
}

export function createConnectorToolContext(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions = {},
): ConnectorToolContext {
  return {
    connectorId: manifest.id,
    dataClass: manifest.dataClass,
    getAccessToken: () => getConnectorAccessToken(manifest, options),
    refreshAccessToken: () => forceRefreshConnectorAccessToken(manifest, options),
    fetchImpl: options.fetchImpl,
  }
}

export async function testConnector(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions = {},
): Promise<ConnectorTestResult> {
  if (!manifest.test) return { ok: false, detail: 'not_supported' }
  try {
    return await manifest.test(createConnectorToolContext(manifest, options))
  } catch (err) {
    if (err instanceof ConnectorReauthRequiredError) return { ok: false, detail: 'reauth_required' }
    if (err instanceof ConnectorNotConnectedError) return { ok: false, detail: 'not_connected' }
    return { ok: false, detail: (err as Error).message.slice(0, 200) }
  }
}

export interface DisconnectResult {
  revoked: boolean
}

/**
 * Revokes upstream (when the manifest names an endpoint) and always deletes the
 * local tokens. The configured client stays, so reconnecting is one click.
 */
export async function disconnectConnector(
  manifest: ConnectorManifest,
  options: ConnectorAccessOptions = {},
): Promise<DisconnectResult> {
  let revoked = false
  const revokeUrl = manifest.oauth?.revokeUrl
  if (revokeUrl) {
    let token = ''
    try {
      token = getConnectorRefreshToken(manifest.id) || getConnectorAccessTokenRaw(manifest.id)
    } catch {
      token = ''
    }
    if (token) {
      const record = getConnectorRecord(manifest.id)
      let clientSecret = ''
      try {
        clientSecret = getConnectorClientSecret(manifest.id)
      } catch {
        clientSecret = ''
      }
      revoked = await revokeToken({
        revokeUrl,
        clientId: record.clientId,
        clientSecret,
        token,
        fetchImpl: options.fetchImpl,
      })
    }
  }
  clearConnectorConnection(manifest.id)
  return { revoked }
}
