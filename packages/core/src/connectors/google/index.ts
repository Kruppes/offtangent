export {
  CALENDAR_DEFAULT_CALENDAR_ID,
  CALENDAR_MAX_EVENTS,
  createCalendarEventsTool,
  normalizeEvent,
  renderEventLine,
} from './calendar.js'
export type { CalendarToolOptions, NormalizedEvent } from './calendar.js'

export {
  CALENDAR_BASE_URL,
  GMAIL_BASE_URL,
  GoogleApiError,
  buildUrl,
  googleGetJson,
  resolveGoogleEndpoints,
} from './api.js'
export type { GoogleEndpoints } from './api.js'

export {
  GMAIL_QUOTE_KEEP_LINES,
  GMAIL_SEARCH_MAX_RESULTS,
  GMAIL_SNIPPET_CHARS,
  GMAIL_THREAD_CAP_CHARS,
  capText,
  createGmailReadThreadTool,
  createGmailSearchTool,
  decodeBase64Url,
  fetchGmailProfile,
  headerValue,
  messageAttachments,
  messageBodyText,
  trimQuotes,
} from './gmail.js'
export type { GmailProfileSummary, GmailToolOptions, ThreadAttachment } from './gmail.js'

export {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CONNECTOR_ID,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPES,
  GOOGLE_SETUP_STEPS,
  GOOGLE_TOKEN_URL,
  createGoogleConnectorManifest,
} from './manifest.js'
export type { GoogleManifestOptions } from './manifest.js'

export { InvalidDateInputError, formatInZone, resolveConnectorTimezone, toRfc3339, zoneOffset } from './time.js'
export { toolError, toolText } from './result.js'
export type { ConnectorToolResult } from './result.js'
