/**
 * The OAuth redirect URI must match what the operator registered upstream
 * character by character, so it is derived from exactly one place: the public
 * base URL of the instance (`PUBLIC_BASE_URL`), or the request host when that
 * variable is unset.
 */
export function normalizeBaseUrl(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  if (!/^https?:\/\/[^\s'"]+$/.test(trimmed)) return ''
  return trimmed.replace(/\/+$/, '')
}

export function getConfiguredPublicBaseUrl(): string {
  return normalizeBaseUrl(process.env.PUBLIC_BASE_URL)
}

export function connectorRedirectUri(connectorId: string, baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl)
  if (!base) return ''
  return `${base}/api/connectors/${connectorId}/callback`
}
