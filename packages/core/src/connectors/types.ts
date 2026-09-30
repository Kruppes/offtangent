import type { AgentTool } from '@earendil-works/pi-agent-core'

/** How a connector authenticates against its upstream service. */
export type ConnectorAuthKind = 'oauth2' | 'apiKey'

/**
 * `local_only` connectors carry private data: their tools are reachable only
 * through the local sub-agent (plan 2026-09-26, P2) and are never registered in
 * `createBaseAgentTools`. `any` connectors may later be registered directly.
 */
export type ConnectorDataClass = 'local_only' | 'any'

export type ConnectorStatus =
  | 'not_configured'
  | 'disconnected'
  | 'connected'
  | 'reauth_required'
  | 'error'

/**
 * Provider-agnostic OAuth2 endpoints. Every URL comes from the manifest so the
 * helper never knows a concrete vendor.
 */
export interface ConnectorOAuthEndpoints {
  authorizeUrl: string
  tokenUrl: string
  revokeUrl?: string
  /** Extra query parameters for the authorize request (e.g. `access_type=offline`). */
  authorizeParams?: Record<string, string>
}

export interface ConnectorTokens {
  accessToken: string
  refreshToken: string
  /** Absolute expiry of the access token as an ISO timestamp, empty when unknown. */
  expiresAt: string
  scopes: string[]
}

/** What a connector tool (or `test`) gets handed at call time. */
export interface ConnectorToolContext {
  connectorId: string
  dataClass: ConnectorDataClass
  /** Returns a valid access token, refreshing it when it is about to expire. */
  getAccessToken: () => Promise<string>
  /**
   * Forces a refresh even when the stored token still looks valid. An upstream
   * `401` is the only legitimate caller: the provider may reject a token before
   * its recorded expiry (revoked session, rotated client). Rejects with
   * `ConnectorReauthRequiredError` when the grant itself is gone.
   */
  refreshAccessToken?: () => Promise<string>
  fetchImpl?: typeof fetch
}

export interface ConnectorTestResult {
  ok: boolean
  /** Short, user-facing detail. Never carries tokens or raw upstream payloads. */
  detail?: string
}

/**
 * One step of the one-time OAuth client setup, as shown on the connector card.
 *
 * Deliberately text-free: only an `id` (the i18n key the web UI resolves), an
 * optional deep link into the provider's console and an optional marker for a
 * value the UI may offer as a copy button. Provider wording stays in the
 * locale files, so the core keeps knowing no vendor copy.
 */
export interface ConnectorSetupStep {
  id: string
  /** Absolute `http(s)` URL; anything else is dropped from the projection. */
  url?: string
  /** Which instance-specific value this step needs in the clipboard. */
  copy?: 'redirectUri' | 'scopes'
}

export interface ConnectorSetup {
  steps: ConnectorSetupStep[]
}

export interface ConnectorManifest {
  id: string
  name: string
  description: string
  auth: ConnectorAuthKind
  scopes: string[]
  dataClass: ConnectorDataClass
  oauth?: ConnectorOAuthEndpoints
  /** Optional checklist for the manual client registration at the provider. */
  setup?: ConnectorSetup
  createTools: (ctx: ConnectorToolContext) => AgentTool[]
  test?: (ctx: ConnectorToolContext) => Promise<ConnectorTestResult>
}

/** One connector's persisted record. Secret fields are encrypted at rest. */
export interface ConnectorRecord {
  clientId: string
  clientSecret: string
  accessToken: string
  refreshToken: string
  apiKey: string
  expiresAt: string
  scopes: string[]
  /** Only `connected`, `reauth_required` and `error` are persisted. */
  status: Extract<ConnectorStatus, 'connected' | 'reauth_required' | 'error'> | ''
  lastError: string
  connectedAt: string
  updatedAt: string
}

export interface ConnectorsFile {
  connectors: Record<string, ConnectorRecord>
}

/** Projection of one setup step: every field present, unsafe urls removed. */
export interface SafeConnectorSetupStep {
  id: string
  url: string
  copy: '' | 'redirectUri' | 'scopes'
}

/** Projection handed to clients — never contains a secret in clear text. */
export interface SafeConnectorState {
  id: string
  name: string
  description: string
  auth: ConnectorAuthKind
  scopes: string[]
  dataClass: ConnectorDataClass
  status: ConnectorStatus
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
  setupSteps: SafeConnectorSetupStep[]
}
