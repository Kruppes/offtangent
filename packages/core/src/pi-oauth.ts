import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { OAuthAuth, OAuthCredential, OAuthCredentials } from '@earendil-works/pi-ai'

let authByProviderId: Map<string, OAuthAuth> | undefined

export function getOAuthAuth(id: string): OAuthAuth | undefined {
  if (!authByProviderId) {
    authByProviderId = new Map(
      builtinProviders()
        .flatMap(p => (p.auth.oauth ? [[p.id, p.auth.oauth] as const] : [])),
    )
  }
  return authByProviderId.get(id)
}

function toCredential(credentials: OAuthCredentials): OAuthCredential {
  return { ...credentials, type: 'oauth' }
}

/**
 * Resolve request auth from stored OAuth credentials, refreshing an expired
 * token first. Returns the possibly-rotated credentials so callers persist them.
 */
export async function getOAuthApiKey(
  providerId: string,
  credentials: OAuthCredentials,
): Promise<{ apiKey: string; baseUrl?: string; newCredentials: OAuthCredentials }> {
  const auth = getOAuthAuth(providerId)
  if (!auth) throw new Error(`Unknown OAuth provider: ${providerId}`)

  let creds = toCredential(credentials)
  if (Date.now() >= creds.expires) {
    try {
      creds = await auth.refresh(creds, AbortSignal.timeout(30_000))
    } catch {
      throw new Error(`Failed to refresh OAuth token for ${providerId}`)
    }
  }

  const modelAuth = await auth.toAuth(creds)
  return { apiKey: modelAuth.apiKey ?? '', baseUrl: modelAuth.baseUrl, newCredentials: creds }
}

export interface OAuthLoginCallbacks {
  onAuth(info: { url: string; instructions?: string }): void
  onDeviceCode(info: { userCode: string; verificationUri: string }): void
  onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>
  onProgress?(message: string): void
  onSelect?(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>
  onManualCodeInput?(): Promise<string>
  signal?: AbortSignal
}

/** Runs a pi-ai OAuth login flow against the legacy callback surface used by the API layer. */
export async function oauthLogin(
  providerId: string,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const auth = getOAuthAuth(providerId)
  if (!auth) throw new Error(`Unknown OAuth provider: ${providerId}`)

  return auth.login({
    signal: callbacks.signal ?? new AbortController().signal,
    notify: (event) => {
      if (event.type === 'auth_url') callbacks.onAuth({ url: event.url, instructions: event.instructions })
      else if (event.type === 'device_code') {
        callbacks.onDeviceCode({ userCode: event.userCode, verificationUri: event.verificationUri })
      } else if (event.type === 'progress') callbacks.onProgress?.(event.message)
    },
    prompt: async (prompt) => {
      if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
        return callbacks.onManualCodeInput()
      }
      if (prompt.type === 'select') {
        const options = prompt.options.map(o => ({ id: o.id, label: o.label }))
        const picked = await callbacks.onSelect?.({ message: prompt.message, options })
        return picked ?? options[0]?.id ?? ''
      }
      return callbacks.onPrompt({
        message: prompt.message,
        placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
      })
    },
  })
}
