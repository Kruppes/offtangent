/**
 * The Google connector manifest (plan 2026-09-26, P3).
 *
 * `dataClass: 'local_only'`: mail and calendar content is private, so the three
 * tools are only ever handed to the local sub-agent — the registry entry itself
 * registers no tool anywhere.
 *
 * `access_type=offline` + `prompt=consent` are not cosmetic: without them the
 * token endpoint returns no refresh token on a repeated consent, and the
 * connection dies the moment the first access token expires.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ConnectorManifest,
  ConnectorSetupStep,
  ConnectorTestResult,
  ConnectorToolContext,
} from '../types.js'
import { resolveGoogleEndpoints } from './api.js'
import type { GoogleEndpoints } from './api.js'
import { createCalendarEventsTool } from './calendar.js'
import { createGmailReadThreadTool, createGmailSearchTool, fetchGmailProfile } from './gmail.js'
import { formatInZone, resolveConnectorTimezone } from './time.js'

export const GOOGLE_CONNECTOR_ID = 'google'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
]

/**
 * Deep links of the one-time client setup, in the order an operator walks them.
 *
 * Only ids and static console URLs live here — every sentence the card shows
 * comes from the locale files (`connectors.setup.google.<stepId>.title|body`),
 * so the core stays free of provider copy.
 *
 * Link sources (checked 2026-09-27):
 * - `/projectcreate`: https://developers.google.com/workspace/guides/create-project
 * - `/apis/enableflow;apiid=<service>`: https://developers.google.com/workspace/guides/enable-apis
 *   (same form in the quickstarts, e.g.
 *   https://developers.google.com/gmail/api/quickstart/python)
 * - `/auth/branding`, `/auth/audience`, `/auth/scopes`:
 *   https://developers.google.com/workspace/guides/configure-oauth-consent
 * - `/auth/clients`: https://support.google.com/cloud/answer/15549257
 * - Seven-day expiry of a "Testing" app's refresh tokens:
 *   https://support.google.com/cloud/answer/15549945
 *
 * The docs link these paths on the `console.developers.google.com` alias; the
 * console itself serves them under `console.cloud.google.com`, which is what an
 * operator sees in the address bar, so that host is used here.
 */
export const GOOGLE_SETUP_STEPS: ConnectorSetupStep[] = [
  { id: 'project', url: 'https://console.cloud.google.com/projectcreate' },
  { id: 'enable-gmail', url: 'https://console.cloud.google.com/apis/enableflow;apiid=gmail.googleapis.com' },
  { id: 'enable-calendar', url: 'https://console.cloud.google.com/apis/enableflow;apiid=calendar-json.googleapis.com' },
  { id: 'branding', url: 'https://console.cloud.google.com/auth/branding' },
  { id: 'audience', url: 'https://console.cloud.google.com/auth/audience' },
  { id: 'scopes', url: 'https://console.cloud.google.com/auth/scopes', copy: 'scopes' },
  { id: 'client', url: 'https://console.cloud.google.com/auth/clients', copy: 'redirectUri' },
  { id: 'credentials' },
]

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export interface GoogleManifestOptions {
  /** Overridden by tests and the dev smoke script; production passes nothing. */
  endpoints?: Partial<GoogleEndpoints>
  /** Injected in tests so an assertion does not depend on the host timezone. */
  resolveTimeZone?: () => string
  /** Counts forced token refreshes across all tools of one context. */
  counters?: { refreshes: number }
}

/** `Date:` header (RFC 2822) or `internalDate` (epoch ms) → `YYYY-MM-DD HH:mm`. */
function formatMessageDate(value: string, timeZone: string): string {
  if (!value) return '(no date)'
  const asEpoch = /^\d{10,}$/.test(value) ? new Date(Number(value)) : null
  const parsed = asEpoch ?? new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return formatInZone(parsed, timeZone)
}

export function createGoogleConnectorManifest(options: GoogleManifestOptions = {}): ConnectorManifest {
  const endpoints = resolveGoogleEndpoints(options.endpoints)
  const resolveTimeZone = options.resolveTimeZone ?? resolveConnectorTimezone

  const buildTools = (ctx: ConnectorToolContext): AgentTool[] => {
    const timeZone = resolveTimeZone()
    const shared = { ctx, counters: options.counters }
    return [
      createGmailSearchTool({
        ...shared,
        baseUrl: endpoints.gmailBaseUrl,
        formatDate: value => formatMessageDate(value, timeZone),
      }),
      createGmailReadThreadTool({
        ...shared,
        baseUrl: endpoints.gmailBaseUrl,
        formatDate: value => formatMessageDate(value, timeZone),
      }),
      createCalendarEventsTool({ ...shared, baseUrl: endpoints.calendarBaseUrl, timeZone }),
    ]
  }

  const runTest = async (ctx: ConnectorToolContext): Promise<ConnectorTestResult> => {
    const profile = await fetchGmailProfile(ctx, endpoints.gmailBaseUrl)
    const address = profile.emailAddress || '(unknown address)'
    return { ok: true, detail: `${address}, ${profile.messagesTotal} messages` }
  }

  return {
    id: GOOGLE_CONNECTOR_ID,
    name: 'Google (Mail & Calendar)',
    description: 'Read-only access to mail and calendar of one Google account, for the local sub-agent.',
    auth: 'oauth2',
    scopes: GOOGLE_SCOPES,
    dataClass: 'local_only',
    setup: { steps: GOOGLE_SETUP_STEPS },
    oauth: {
      authorizeUrl: GOOGLE_AUTHORIZE_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      revokeUrl: GOOGLE_REVOKE_URL,
      authorizeParams: {
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      },
    },
    createTools: buildTools,
    test: runTest,
  }
}
