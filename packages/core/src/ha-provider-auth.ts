/** Sanitized HA auth observations. Central provider config remains the ONLY credential store. */
import { createHash } from 'node:crypto'
import { loadProvidersDecrypted, getApiKeyForProvider, getPiOAuthAuth, refreshOAuthCredentialsLocked, storedToOAuthCredentials, type ProviderConfig } from './provider-config.js'
export type HaAuthState = 'unknown' | 'ready' | 'access_expired' | 'access_rejected' | 'refresh_unavailable' | 'relogin_required' | 'provider_unavailable'
export class HaProviderFault extends Error {
  constructor(public status: number, public code: string, public authState?: HaAuthState) { super(code) }
}
const observations = new Map<string, { stamp: string; state: HaAuthState }>()
function stamp(p: ProviderConfig): string {
  return createHash('sha256').update(JSON.stringify(p.oauthCredentials ?? null)).digest('hex')
}
function observe(p: ProviderConfig): void {
  const identity = stamp(p), previous = observations.get(p.id)
  if (!previous || previous.stamp !== identity) observations.set(p.id, { stamp: identity, state: 'unknown' })
}
export function recordHaAuthState(providerId: string, state: HaAuthState): void {
  const previous = observations.get(providerId)
  if (previous) observations.set(providerId, { ...previous, state })
}
export function refreshNeedsLogin(error: unknown): boolean {
  // Explicit refresh rejection, NOT access expiry, timeout, 5xx or arbitrary prose.
  const e = error as { status?: number; message?: string; code?: string }
  return e?.status === 401 || e?.code === 'invalid_grant' || /\binvalid_grant\b|\bstatus=401\b|refresh token (?:has )?(?:expired|revoked|invalid)|(?:invalid|expired|revoked) refresh token/i.test(e?.message ?? '')
}
function refreshFault(providerId: string, error: unknown): HaProviderFault {
  const login = refreshNeedsLogin(error)
  const state = login ? 'relogin_required' : 'refresh_unavailable'
  recordHaAuthState(providerId, state)
  return new HaProviderFault(503, login ? 'provider_relogin_required' : 'provider_refresh_unavailable', state)
}
export async function resolveHaCredential(provider: ProviderConfig): Promise<string> {
  observe(provider)
  if (!provider.oauthCredentials || (!provider.oauthCredentials.refresh && Date.now() >= provider.oauthCredentials.expires)) {
    recordHaAuthState(provider.id, 'relogin_required')
    throw new HaProviderFault(503, 'provider_relogin_required', 'relogin_required')
  }
  try {
    const key = await getApiKeyForProvider(provider)
    // The existing resolver may have refreshed/persisted credentials. Capture ONLY a fingerprint.
    const fresh = loadProvidersDecrypted().providers.find(p => p.id === provider.id)
    if (!fresh) throw new HaProviderFault(503, 'subscription_provider_unavailable', 'provider_unavailable')
    observe(fresh)
    return key
  } catch (e) { if (e instanceof HaProviderFault) throw e; throw refreshFault(provider.id, e) }
}
const rejectedRepairs = new Map<string, { at: number; rejectedHash: string; result: Promise<never> }>()
/** Repair central auth for the NEXT turn only. Never replay this inference/any tool. */
export function repairHaRejectedAccess(provider: ProviderConfig, rejectedAccess: string): Promise<never> {
  const rejectedHash = createHash('sha256').update(rejectedAccess).digest('hex')
  const previous = rejectedRepairs.get(provider.id)
  if (previous && previous.rejectedHash === rejectedHash && Date.now() - previous.at < 60_000) return previous.result
  const result = repair(provider, rejectedAccess)
  rejectedRepairs.set(provider.id, { at: Date.now(), rejectedHash, result })
  return result
}
async function repair(provider: ProviderConfig, rejectedAccess: string): Promise<never> {
  const fresh = loadProvidersDecrypted().providers.find(p => p.id === provider.id) ?? provider
  observe(fresh)
  const auth = getPiOAuthAuth(provider.providerType === 'anthropic-oauth' ? 'anthropic' : 'openai-codex')
  if (!auth || !fresh.oauthCredentials) {
    recordHaAuthState(provider.id, 'relogin_required')
    throw new HaProviderFault(503, 'provider_relogin_required', 'relogin_required')
  }
  try {
    await refreshOAuthCredentialsLocked(provider.id, auth, { type: 'oauth', ...storedToOAuthCredentials(fresh.oauthCredentials), access: rejectedAccess }, { force: true, expectedProviderType: provider.providerType })
  } catch (e) { throw refreshFault(provider.id, e) }
  observe(loadProvidersDecrypted().providers.find(p => p.id === provider.id) ?? fresh)
  recordHaAuthState(provider.id, 'access_rejected')
  throw new HaProviderFault(503, 'provider_access_rejected', 'access_rejected')
}
export function inspectHaAuth(providerId: string): { state: HaAuthState; reloginRequired: boolean; accessExpiresAt?: string; refreshExpiresAt: null } {
  const p = loadProvidersDecrypted().providers.find(p => p.id === providerId)
  if (!p || p.authMethod !== 'oauth') return { state: 'provider_unavailable', reloginRequired: false, refreshExpiresAt: null }
  const creds = p.oauthCredentials
  if (!creds) return { state: 'relogin_required', reloginRequired: true, refreshExpiresAt: null }
  const known = observations.get(providerId)
  if (known && known.stamp !== stamp(p)) observations.delete(providerId) // Central re-login/rotation invalidates old warnings.
  const expired = Date.now() >= creds.expires
  const observed = known?.stamp === stamp(p) ? known.state : 'unknown'
  const state = expired && ['unknown', 'ready'].includes(observed) ? (!creds.refresh ? 'relogin_required' : 'access_expired') : observed
  return { state, reloginRequired: state === 'relogin_required', accessExpiresAt: new Date(creds.expires).toISOString(), refreshExpiresAt: null }
}
