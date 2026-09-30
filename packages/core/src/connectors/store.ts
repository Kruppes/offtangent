import fs from 'node:fs'
import path from 'node:path'
import { getConfigDir } from '../config.js'
import { decrypt, encrypt, isEncrypted, maskApiKey } from '../encryption.js'
import type {
  ConnectorManifest,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorTokens,
  ConnectorsFile,
  SafeConnectorSetupStep,
  SafeConnectorState,
} from './types.js'

export function connectorsFilePath(): string {
  return path.join(getConfigDir(), 'connectors.json')
}

const EMPTY_RECORD: ConnectorRecord = {
  clientId: '',
  clientSecret: '',
  accessToken: '',
  refreshToken: '',
  apiKey: '',
  expiresAt: '',
  scopes: [],
  status: '',
  lastError: '',
  connectedAt: '',
  updatedAt: '',
}

function normalizeRecord(value: Partial<ConnectorRecord> | undefined): ConnectorRecord {
  return {
    ...EMPTY_RECORD,
    ...value,
    scopes: Array.isArray(value?.scopes) ? value.scopes.map(String) : [],
  }
}

export function loadConnectorsFile(): ConnectorsFile {
  const filePath = connectorsFilePath()
  if (!fs.existsSync(filePath)) return { connectors: {} }

  let data: Partial<ConnectorsFile>
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<ConnectorsFile>
  } catch (err) {
    throw new Error(`Failed to read ${filePath}: ${(err as Error).message}`)
  }

  const connectors: Record<string, ConnectorRecord> = {}
  for (const [id, record] of Object.entries(data.connectors ?? {})) {
    connectors[id] = normalizeRecord(record)
  }
  return { connectors }
}

export function saveConnectorsFile(data: ConnectorsFile): void {
  const configDir = getConfigDir()
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(connectorsFilePath(), JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export function getConnectorRecord(id: string): ConnectorRecord {
  return loadConnectorsFile().connectors[id] ?? { ...EMPTY_RECORD }
}

function sealed(value: string): string {
  if (!value) return ''
  return isEncrypted(value) ? value : encrypt(value)
}

function opened(value: string, context: string): string {
  if (!value) return ''
  if (!isEncrypted(value)) return value
  try {
    return decrypt(value)
  } catch (err) {
    // A broken ENCRYPTION_KEY must name itself instead of surfacing as an
    // upstream auth failure that sends operators chasing the wrong problem.
    throw new Error(`Failed to decrypt ${context}: ${(err as Error).message}`)
  }
}

function writeRecord(id: string, patch: Partial<ConnectorRecord>): ConnectorRecord {
  const file = loadConnectorsFile()
  const next: ConnectorRecord = {
    ...normalizeRecord(file.connectors[id]),
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  next.clientSecret = sealed(next.clientSecret)
  next.accessToken = sealed(next.accessToken)
  next.refreshToken = sealed(next.refreshToken)
  next.apiKey = sealed(next.apiKey)
  file.connectors[id] = next
  saveConnectorsFile(file)
  return next
}

export interface ConnectorClientInput {
  clientId?: string
  /** Omitted leaves the stored secret untouched; an empty string clears it. */
  clientSecret?: string
}

export function setConnectorClient(id: string, input: ConnectorClientInput): ConnectorRecord {
  const patch: Partial<ConnectorRecord> = {}
  if (input.clientId !== undefined) patch.clientId = input.clientId.trim()
  if (input.clientSecret !== undefined) patch.clientSecret = input.clientSecret.trim()
  return writeRecord(id, patch)
}

export function setConnectorApiKey(id: string, apiKey: string): ConnectorRecord {
  return writeRecord(id, { apiKey: apiKey.trim(), status: apiKey.trim() ? 'connected' : '', lastError: '' })
}

export function saveConnectorTokens(id: string, tokens: ConnectorTokens): ConnectorRecord {
  const existing = getConnectorRecord(id)
  return writeRecord(id, {
    accessToken: tokens.accessToken,
    // A refresh response without a new refresh token keeps the stored one.
    refreshToken: tokens.refreshToken || existing.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    status: 'connected',
    lastError: '',
    connectedAt: existing.connectedAt || new Date().toISOString(),
  })
}

export function markConnectorReauthRequired(id: string, reason: string): ConnectorRecord {
  return writeRecord(id, { status: 'reauth_required', lastError: reason, accessToken: '', expiresAt: '' })
}

export function markConnectorError(id: string, reason: string): ConnectorRecord {
  return writeRecord(id, { status: 'error', lastError: reason })
}

/** Drops every token of a connector but keeps the configured client. */
export function clearConnectorConnection(id: string): ConnectorRecord {
  return writeRecord(id, {
    accessToken: '',
    refreshToken: '',
    apiKey: '',
    expiresAt: '',
    scopes: [],
    status: '',
    lastError: '',
    connectedAt: '',
  })
}

export function getConnectorClientSecret(id: string): string {
  return opened(getConnectorRecord(id).clientSecret, `client secret of connector "${id}"`)
}

export function getConnectorRefreshToken(id: string): string {
  return opened(getConnectorRecord(id).refreshToken, `refresh token of connector "${id}"`)
}

export function getConnectorAccessTokenRaw(id: string): string {
  return opened(getConnectorRecord(id).accessToken, `access token of connector "${id}"`)
}

export function getConnectorApiKey(id: string): string {
  return opened(getConnectorRecord(id).apiKey, `API key of connector "${id}"`)
}

export function resolveConnectorStatus(manifest: ConnectorManifest, record: ConnectorRecord): ConnectorStatus {
  if (record.status === 'error') return 'error'
  if (record.status === 'reauth_required') return 'reauth_required'

  if (manifest.auth === 'oauth2') {
    if (!record.clientId || !record.clientSecret) return 'not_configured'
    return record.refreshToken ? 'connected' : 'disconnected'
  }
  return record.apiKey ? 'connected' : 'not_configured'
}

/**
 * Projects the manifest's setup checklist for the browser.
 *
 * A step keeps its text (the id resolves to the locale files) but loses a url
 * that is not absolute `http(s)`: a manifest is code, yet the projection is the
 * last place before the value becomes an `href`, and a `javascript:` or `data:`
 * link there would execute in the admin's session.
 */
function toSafeSetupSteps(manifest: ConnectorManifest): SafeConnectorSetupStep[] {
  return (manifest.setup?.steps ?? []).map(step => ({
    id: step.id,
    url: isHttpUrl(step.url) ? step.url : '',
    copy: step.copy ?? '',
  }))
}

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

export function toSafeConnectorState(
  manifest: ConnectorManifest,
  record: ConnectorRecord,
  redirectUri: string,
): SafeConnectorState {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    auth: manifest.auth,
    scopes: manifest.scopes,
    dataClass: manifest.dataClass,
    status: resolveConnectorStatus(manifest, record),
    clientId: record.clientId,
    clientSecretSet: Boolean(record.clientSecret),
    clientSecretMasked: record.clientSecret ? maskApiKey(opened(record.clientSecret, `client secret of connector "${manifest.id}"`)) : '',
    hasTest: typeof manifest.test === 'function',
    scopesGranted: record.scopes,
    lastError: record.lastError,
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    redirectUri,
    setupSteps: toSafeSetupSteps(manifest),
  }
}
