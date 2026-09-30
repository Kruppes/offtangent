/**
 * Shared wire contract for connectors (plan 2026-09-26, P1).
 *
 * Pure by design: no fs, no crypto, no database — this is the only part of the
 * connector machinery the browser bundle imports. The runtime side (credential
 * store, OAuth helpers) lives in `connectors/` and stays server-only.
 */

export const CONNECTOR_STATUSES = [
  'not_configured',
  'disconnected',
  'connected',
  'reauth_required',
  'error',
] as const

export type ConnectorStatusContract = (typeof CONNECTOR_STATUSES)[number]

export type ConnectorAuthContract = 'oauth2' | 'apiKey'

export type ConnectorDataClassContract = 'local_only' | 'any'

/**
 * One step of the one-time setup checklist shown on a connector card.
 *
 * `id` is an i18n key suffix (`connectors.setup.<connectorId>.<id>.title|body`),
 * never user-facing text: the wire stays free of provider wording. `url` is
 * always an absolute `http(s)` URL or empty — the server drops anything else, so
 * the browser never renders a `javascript:` link. `copy` names the
 * instance-specific value a step offers as a copy button.
 */
export interface ConnectorSetupStepContract {
  id: string
  url: string
  copy: '' | 'redirectUri' | 'scopes'
}

export interface ConnectorContract {
  id: string
  name: string
  description: string
  auth: ConnectorAuthContract
  scopes: string[]
  dataClass: ConnectorDataClassContract
  status: ConnectorStatusContract
  clientId: string
  clientSecretSet: boolean
  clientSecretMasked: string
  hasTest: boolean
  scopesGranted: string[]
  lastError: string
  connectedAt: string
  updatedAt: string
  expiresAt: string
  redirectUri: string
  /** Empty when the connector ships no setup checklist. */
  setupSteps: ConnectorSetupStepContract[]
}

export interface ConnectorsListResponseContract {
  connectors: ConnectorContract[]
  /** Empty when the instance has no public base URL configured. */
  baseUrl: string
}

export interface ConnectorClientPayloadContract {
  clientId: string
  /** Omitted leaves the stored secret untouched. */
  clientSecret?: string
}

export interface ConnectorMutationResponseContract {
  connector: ConnectorContract
}

export interface ConnectorTestResponseContract {
  ok: boolean
  detail: string
}

/** Callback outcomes the redirect exposes. Deliberately coarse: no upstream detail leaks. */
export const CONNECTOR_CALLBACK_ERRORS = [
  'invalid_state',
  'denied',
  'not_configured',
  'exchange_failed',
  'unknown_connector',
  'public_base_url_missing',
] as const

export type ConnectorCallbackErrorContract = (typeof CONNECTOR_CALLBACK_ERRORS)[number]

export const CONNECTOR_CLIENT_ID_MAX_LENGTH = 400
export const CONNECTOR_CLIENT_SECRET_MAX_LENGTH = 400

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

export function parseConnectorClientPayload(input: unknown): ParseResult<ConnectorClientPayloadContract> {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'Body must be an object' }
  const body = input as Record<string, unknown>

  if (typeof body.clientId !== 'string' || body.clientId.trim().length === 0) {
    return { ok: false, error: 'clientId is required' }
  }
  if (body.clientId.length > CONNECTOR_CLIENT_ID_MAX_LENGTH) {
    return { ok: false, error: `clientId must be at most ${CONNECTOR_CLIENT_ID_MAX_LENGTH} characters` }
  }
  if (body.clientSecret !== undefined) {
    if (typeof body.clientSecret !== 'string') return { ok: false, error: 'clientSecret must be a string' }
    if (body.clientSecret.length > CONNECTOR_CLIENT_SECRET_MAX_LENGTH) {
      return { ok: false, error: `clientSecret must be at most ${CONNECTOR_CLIENT_SECRET_MAX_LENGTH} characters` }
    }
  }

  const value: ConnectorClientPayloadContract = { clientId: body.clientId.trim() }
  if (typeof body.clientSecret === 'string') value.clientSecret = body.clientSecret.trim()
  return { ok: true, value }
}
