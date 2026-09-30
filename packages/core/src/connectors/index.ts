export type {
  ConnectorAuthKind,
  ConnectorDataClass,
  ConnectorManifest,
  ConnectorOAuthEndpoints,
  ConnectorRecord,
  ConnectorSetup,
  ConnectorSetupStep,
  ConnectorStatus,
  ConnectorTestResult,
  ConnectorTokens,
  ConnectorToolContext,
  ConnectorsFile,
  SafeConnectorSetupStep,
  SafeConnectorState,
} from './types.js'

export {
  createConnectorRegistry,
  getConnectorManifest,
  getConnectorRegistry,
  listConnectorManifests,
} from './registry.js'
export type { ConnectorRegistry } from './registry.js'

export {
  clearConnectorConnection,
  connectorsFilePath,
  getConnectorAccessTokenRaw,
  getConnectorApiKey,
  getConnectorClientSecret,
  getConnectorRecord,
  getConnectorRefreshToken,
  loadConnectorsFile,
  markConnectorError,
  markConnectorReauthRequired,
  resolveConnectorStatus,
  saveConnectorTokens,
  saveConnectorsFile,
  setConnectorApiKey,
  setConnectorClient,
  toSafeConnectorState,
} from './store.js'
export type { ConnectorClientInput } from './store.js'

export {
  OAUTH_STATE_TTL_MS,
  OAuthTokenError,
  buildAuthorizeUrl,
  createOAuthStateStore,
  createPkcePair,
  exchangeAuthorizationCode,
  getOAuthStateStore,
  isTokenExpired,
  refreshAccessToken,
  revokeToken,
} from './oauth.js'
export type { CreatedAuthorization, OAuthStateStore, PendingAuthorization } from './oauth.js'

export type { ConnectorAccessOptions, DisconnectResult } from './access.js'
export {
  ConnectorNotConnectedError,
  ConnectorReauthRequiredError,
  createConnectorToolContext,
  disconnectConnector,
  forceRefreshConnectorAccessToken,
  getConnectorAccessToken,
  testConnector,
} from './access.js'

export { connectorRedirectUri, getConfiguredPublicBaseUrl, normalizeBaseUrl } from './redirect.js'

// P2: the local sub-agent. `createTools` of a connector is handed to a model
// in `sub-agent.ts` only; everything else goes through `ask_connector`.
export {
  DEFAULT_CONNECTOR_LOCAL_MODEL_ID,
  ConnectorLocalModelRejected,
  defaultConnectorLocalModel,
  getConnectorLocalModelStatus,
  isOllamaEndpointReachable,
  isOllamaProviderType,
  listStrictlyLocalModels,
  loadConnectorLocalModelSetting,
  resolveConnectorLocalModel,
  setConnectorLocalModel,
} from './local-model.js'
export type {
  ConnectorLocalModelRef,
  ConnectorLocalModelStatus,
  ConnectorLocalModelStatusOptions,
} from './local-model.js'

export {
  CONNECTOR_SUB_AGENT_SYSTEM_PROMPT,
  ConnectorLocalModelViolation,
  DEFAULT_ANSWER_CAP_CHARS,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_TIMEOUT_MS,
  runConnectorSubAgent,
} from './sub-agent.js'
export type {
  ConnectorSubAgentErrorCode,
  ConnectorSubAgentOptions,
  ConnectorSubAgentResult,
} from './sub-agent.js'

// P3: the first real connector.
export {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CONNECTOR_ID,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  createGoogleConnectorManifest,
} from './google/manifest.js'
export type { GoogleManifestOptions } from './google/manifest.js'

export {
  CONNECTOR_UNTRUSTED_NOTE,
  createAskConnectorTool,
  neutralizeConnectorEnvelope,
  wrapConnectorResult,
} from './ask-connector-tool.js'
export type { AskConnectorToolOptions } from './ask-connector-tool.js'
