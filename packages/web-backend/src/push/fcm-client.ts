/**
 * Minimal FCM HTTP v1 client.
 *
 * Two things happen here and nothing else:
 *
 *  1. a service account JSON is turned into an OAuth2 access token with the
 *     JWT bearer grant (RS256 signed with `node:crypto`, no extra dependency),
 *     cached until shortly before it expires,
 *  2. a message envelope is POSTed to
 *     `https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`.
 *
 * The client knows nothing about strands, devices or coalescing. It reports
 * what the wire said (HTTP status, message name, FCM error code) and lets the
 * sender decide what that means for a device row.
 */
import fs from 'node:fs'
import crypto from 'node:crypto'

const TOKEN_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** Google issues one hour tokens; refresh a minute early to avoid a race with the clock. */
const TOKEN_SKEW_MS = 60_000

export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string
}

export interface FcmMessage {
  token: string
  data: Record<string, string>
  /** `high` wakes the device immediately, `normal` may be batched by Android. */
  priority: 'high' | 'normal'
  /** Seconds the message may wait for an offline device. */
  ttlSeconds: number
  /** Later doorbells for the same strand replace the earlier one. */
  collapseKey?: string
}

export interface FcmSendResult {
  ok: boolean
  status: number
  /** `projects/<project>/messages/<id>` when FCM accepted the message. */
  name?: string
  /** The `error.status` field, e.g. `UNREGISTERED`, `INVALID_ARGUMENT`, `UNAVAILABLE`. */
  errorCode?: string
  errorMessage?: string
}

export interface FcmClientOptions {
  /** Path to the service account JSON. Read lazily on the first send. */
  serviceAccountFile: string
  /** Injected in tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch
  now?: () => number
}

export class FcmConfigError extends Error {}

export class FcmClient {
  private readonly serviceAccountFile: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private account: ServiceAccount | null = null
  private accessToken: { value: string; expiresAtMs: number } | null = null
  private pendingToken: Promise<string> | null = null

  constructor(options: FcmClientOptions) {
    this.serviceAccountFile = options.serviceAccountFile
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
  }

  /** True when the configured service account file exists and parses. */
  isConfigured(): boolean {
    try {
      this.loadAccount()
      return true
    } catch {
      return false
    }
  }

  get projectId(): string {
    return this.loadAccount().project_id
  }

  async send(message: FcmMessage): Promise<FcmSendResult> {
    const account = this.loadAccount()
    const accessToken = await this.getAccessToken()
    const body = {
      message: {
        token: message.token,
        android: {
          priority: message.priority === 'high' ? 'HIGH' : 'NORMAL',
          ttl: `${message.ttlSeconds}s`,
          ...(message.collapseKey ? { collapse_key: message.collapseKey } : {}),
        },
        data: message.data,
      },
    }
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    )
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    if (response.ok) {
      const name = (parsed as { name?: string } | null)?.name
      return { ok: true, status: response.status, name }
    }
    const error = (parsed as { error?: { status?: string; message?: string } } | null)?.error
    return {
      ok: false,
      status: response.status,
      errorCode: error?.status ?? String(response.status),
      errorMessage: error?.message ?? text.slice(0, 300),
    }
  }

  /** Drops the cached access token. Used by tests and after an auth failure. */
  resetToken(): void {
    this.accessToken = null
    this.pendingToken = null
  }

  private loadAccount(): ServiceAccount {
    if (this.account) return this.account
    let raw: string
    try {
      raw = fs.readFileSync(this.serviceAccountFile, 'utf-8')
    } catch (err) {
      throw new FcmConfigError(`Cannot read FCM service account at ${this.serviceAccountFile}: ${(err as Error).message}`)
    }
    let parsed: Partial<ServiceAccount>
    try {
      parsed = JSON.parse(raw) as Partial<ServiceAccount>
    } catch (err) {
      throw new FcmConfigError(`FCM service account is not valid JSON: ${(err as Error).message}`)
    }
    if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
      throw new FcmConfigError('FCM service account is missing project_id, client_email or private_key')
    }
    this.account = parsed as ServiceAccount
    return this.account
  }

  private async getAccessToken(): Promise<string> {
    const cached = this.accessToken
    if (cached && cached.expiresAtMs - TOKEN_SKEW_MS > this.now()) return cached.value
    // One in-flight exchange per client; a burst of pushes must not mint a
    // token per message.
    if (this.pendingToken) return this.pendingToken
    this.pendingToken = this.fetchAccessToken().finally(() => { this.pendingToken = null })
    return this.pendingToken
  }

  private async fetchAccessToken(): Promise<string> {
    const account = this.loadAccount()
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token'
    const assertion = this.buildAssertion(account, tokenUri)
    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`OAuth token exchange failed (${response.status}): ${text.slice(0, 300)}`)
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number }
    if (!parsed.access_token) throw new Error('OAuth token exchange returned no access_token')
    const lifetimeMs = (parsed.expires_in ?? 3600) * 1000
    this.accessToken = { value: parsed.access_token, expiresAtMs: this.now() + lifetimeMs }
    return parsed.access_token
  }

  private buildAssertion(account: ServiceAccount, tokenUri: string): string {
    const issuedAt = Math.floor(this.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT' }
    const claims = {
      iss: account.client_email,
      scope: TOKEN_SCOPE,
      aud: tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }
    const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), account.private_key)
    return `${signingInput}.${signature.toString('base64url')}`
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url')
}

/** Resolves the service account path: `FCM_SERVICE_ACCOUNT_FILE`, else the default. */
export function resolveServiceAccountFile(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FCM_SERVICE_ACCOUNT_FILE?.trim()
  return configured && configured.length > 0
    ? configured
    : '/data/secrets/firebase/service-account.json'
}
