/**
 * Gates of the Google connector (plan 2026-09-26, P3).
 *
 * The upstream is the fake Google of `fake-google.fixture.ts`, answering on the
 * production URLs; the token store, the refresh logic and the manifest are the
 * real ones. Every address, subject, body and calendar entry is invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAuthorizeUrl } from '../oauth.js'
import { getConnectorManifest } from '../registry.js'
import { createConnectorToolContext } from '../access.js'
import { getConnectorRecord, saveConnectorTokens, setConnectorClient } from '../store.js'
import { createFakeGoogle, FAKE_GOOGLE_ACCOUNT, GOOGLE_FAKE_CANARY } from './fake-google.fixture.js'
import type { FakeGoogle } from './fake-google.fixture.js'
import {
  createGoogleConnectorManifest,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CONNECTOR_ID,
  GOOGLE_REVOKE_URL,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
} from './manifest.js'
import { GMAIL_THREAD_CAP_CHARS, decodeBase64Url, trimQuotes } from './gmail.js'
import { toRfc3339, zoneOffset } from './time.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'

const TZ = 'Europe/Berlin'
const CLIENT_SECRET = 'client-secret-0123456789'

let dataDir = ''
let previousDataDir: string | undefined
let previousKey: string | undefined

const manifest = createGoogleConnectorManifest({ resolveTimeZone: () => TZ })

function connect(expiresInMs: number): void {
  setConnectorClient(manifest.id, { clientId: 'client-id-from-the-provider', clientSecret: CLIENT_SECRET })
  saveConnectorTokens(manifest.id, {
    accessToken: 'access-token-before-refresh',
    refreshToken: 'refresh-token-abcdefghij',
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    scopes: GOOGLE_SCOPES,
  })
}

function toolsOf(fake: FakeGoogle): Record<string, AgentTool> {
  const ctx = createConnectorToolContext(manifest, { fetchImpl: fake.fetchImpl })
  const out: Record<string, AgentTool> = {}
  for (const tool of manifest.createTools(ctx)) out[tool.name] = tool
  return out
}

async function run(tool: AgentTool, params: Record<string, unknown>): Promise<string> {
  const result = await (tool as unknown as {
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>
  }).execute('call-1', params)
  return result.content.map(part => part.text).join('\n')
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-google-'))
  process.env.DATA_DIR = dataDir
  process.env.ENCRYPTION_KEY = '0'.repeat(64)
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('google manifest', () => {
  it('ships in the production registry as a local-only oauth2 connector', () => {
    const registered = getConnectorManifest(GOOGLE_CONNECTOR_ID)
    expect(registered).not.toBeNull()
    expect(registered?.auth).toBe('oauth2')
    expect(registered?.dataClass).toBe('local_only')
    expect(registered?.oauth?.authorizeUrl).toBe(GOOGLE_AUTHORIZE_URL)
    expect(registered?.oauth?.tokenUrl).toBe(GOOGLE_TOKEN_URL)
    expect(registered?.oauth?.revokeUrl).toBe(GOOGLE_REVOKE_URL)
    expect(registered?.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ])
  })

  it('ships a setup checklist whose steps only link to the vendor console over https', () => {
    const steps = createGoogleConnectorManifest().setup?.steps ?? []
    expect(steps.map(step => step.id)).toEqual([
      'project',
      'enable-gmail',
      'enable-calendar',
      'branding',
      'audience',
      'scopes',
      'client',
      'credentials',
    ])
    for (const step of steps) {
      if (step.url) expect(step.url.startsWith('https://console.cloud.google.com/')).toBe(true)
    }
    expect(steps.find(step => step.id === 'scopes')?.copy).toBe('scopes')
    expect(steps.find(step => step.id === 'client')?.copy).toBe('redirectUri')
    expect(getConnectorManifest(GOOGLE_CONNECTOR_ID)?.setup?.steps).toHaveLength(8)
  })

  it('puts both scopes, access_type=offline and prompt=consent into the authorize url', () => {
    const url = new URL(buildAuthorizeUrl({
      manifest,
      clientId: 'client-id-from-the-provider',
      redirectUri: 'https://instance.example/api/connectors/google/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
    }))
    expect(url.origin + url.pathname).toBe(GOOGLE_AUTHORIZE_URL)
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly',
    )
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('https://instance.example/api/connectors/google/callback')
  })

  it('creates exactly the three read tools', () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    expect(Object.keys(toolsOf(fake))).toEqual(['gmail_search', 'gmail_read_thread', 'calendar_events'])
  })

  it('returns only address and message count from the test call', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const result = await manifest.test?.(createConnectorToolContext(manifest, { fetchImpl: fake.fetchImpl }))
    expect(result).toEqual({ ok: true, detail: `${FAKE_GOOGLE_ACCOUNT}, 1234 messages` })
    expect(fake.requests.at(-1)?.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile')
  })
})

describe('gmail_search', () => {
  it('parses the From, Subject and Date headers of every hit', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_search, { query: 'from:alice@example.com' })

    expect(text).toContain('thread=thr-1001')
    expect(text).toContain('Alice <alice@example.com>')
    expect(text).toContain('Invoice 2026-114')
    expect(text).toContain('2026-09-21 09:12')
    expect(text).toContain('due on 2026-09-30')
    // The metadata format is what keeps a search cheap.
    const metadataUrl = fake.requests.find(r => r.url.includes('/messages/msg-1001a'))?.url ?? ''
    expect(metadataUrl).toContain('format=metadata')
    expect(metadataUrl).toContain('metadataHeaders=From')
    expect(metadataUrl).toContain('metadataHeaders=Subject')
    expect(metadataUrl).toContain('metadataHeaders=Date')
  })

  it('caps the limit at 20 and passes the query through', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    await run(toolsOf(fake).gmail_search, { query: 'invoice', limit: 999 })
    const listUrl = new URL(fake.requests.find(r => r.url.includes('/users/me/messages?'))?.url ?? 'https://x.invalid')
    expect(listUrl.searchParams.get('maxResults')).toBe('20')
    expect(listUrl.searchParams.get('q')).toBe('invoice')
  })

  it('reports an empty result instead of an error', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_search, { query: 'from:nobody@example.com' })
    expect(text).toContain('No message matches')
  })
})

describe('gmail_read_thread', () => {
  it('requests the thread under users/me like the real Gmail API', async () => {
    // The fake used to accept `/gmail/v1/threads/<id>`, which Google answers
    // with 404 — the path is pinned here against the documented endpoint
    // GET /gmail/v1/users/{userId}/threads/{id}.
    connect(3_600_000)
    const fake = createFakeGoogle()
    await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1001' })

    const threadUrl = new URL(fake.requests.find(r => r.url.includes('/threads/'))?.url ?? 'https://x.invalid')
    expect(threadUrl.pathname).toBe('/gmail/v1/users/me/threads/thr-1001')
    expect(threadUrl.searchParams.get('format')).toBe('full')
  })

  it('decodes base64url text/plain and shortens the quote block', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1001' })

    expect(text).toContain('message 1/2')
    expect(text).toContain('invoice 2026-114 for 248.50 EUR is due on 2026-09-30.')
    expect(text).toContain(GOOGLE_FAKE_CANARY)
    expect(text).toContain('Payment is out, value date 2026-09-24.')
    // The attribution line becomes a marker and the quote block is shortened
    // to its first lines — but only `>` lines are dropped (review H3), so a
    // bottom-posted answer would survive.
    expect(text).toContain('[quoted message header omitted]')
    expect(text).not.toContain('Alice, Example Company')
    expect(text).toContain('[quoted text shortened:')
  })

  it('prefers text/plain over the html alternative in a multipart message', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1002' })
    expect(text).toContain('Please bring the spare key.')
    expect(text).not.toContain('HTML variant that must not win')
  })

  it('converts an html-only message and lists attachments without downloading them', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1003' })

    expect(text).toContain('Delivery 8821')
    expect(text).toContain('Between 10:00 and 16:00')
    expect(text).not.toContain('<b>')
    expect(text).not.toContain('color:red')
    expect(text).toContain('attachments: delivery-note.pdf (application/pdf, 20480 bytes)')
    // No attachment endpoint was ever called.
    expect(fake.requests.some(r => r.url.includes('/attachments/'))).toBe(false)
  })

  it('cuts a long thread at the cap and says so', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1004' })
    expect(text.length).toBeLessThan(GMAIL_THREAD_CAP_CHARS + 200)
    expect(text).toContain(`the thread is longer than ${GMAIL_THREAD_CAP_CHARS} characters`)
  })

  it('answers a missing thread with a coarse upstream code, without a body', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-does-not-exist' })
    expect(text).toContain('upstream http_404')
    expect(text).not.toContain('Not Found')
  })
})

describe('calendar_events', () => {
  it('lists a timed and an all-day entry with singleEvents and orderBy', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).calendar_events, { from: '2026-09-28', to: '2026-09-29' })

    expect(text).toContain('2026-09-28 09:00 | 2026-09-28 09:45 | Team sync | Meeting room 2 | all_day=no')
    // The exclusive end date of an all-day event is folded back to the last day.
    expect(text).toContain('2026-09-29 | 2026-09-29 | Public holiday | - | all_day=yes')
    expect(text).toContain('Call with Alice')
    expect(text).not.toContain('Cancelled slot')

    const url = new URL(fake.requests.find(r => r.url.includes('/events?'))?.url ?? 'https://x.invalid')
    expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('maxResults')).toBe('50')
    expect(url.searchParams.get('timeZone')).toBe(TZ)
    expect(url.searchParams.get('timeMin')).toBe('2026-09-28T00:00:00+02:00')
    expect(url.searchParams.get('timeMax')).toBe('2026-09-29T23:59:59+02:00')
  })

  it('accepts an explicit calendar id and an ISO date-time window', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).calendar_events, {
      from: '2026-09-28T08:00',
      to: '2026-09-28T18:00',
      calendarId: 'work@example.com',
    })
    expect(text).toContain('Team sync')
    const url = new URL(fake.requests.find(r => r.url.includes('/events?'))?.url ?? 'https://x.invalid')
    expect(url.pathname).toBe('/calendar/v3/calendars/work%40example.com/events')
    expect(url.searchParams.get('timeMin')).toBe('2026-09-28T08:00:00+02:00')
  })

  it('rejects an unparsable date with a hint, without calling upstream', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).calendar_events, { from: 'tomorrow', to: 'tomorrow' })
    expect(text).toContain('Use YYYY-MM-DD')
    expect(fake.apiCalls).toBe(0)
  })

  it('reports an empty range as empty', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).calendar_events, { from: '2026-10-05', to: '2026-10-06' })
    expect(text).toContain('No entries between 2026-10-05 and 2026-10-06')
  })
})

describe('token handling', () => {
  it('refreshes exactly once after a 401 and then succeeds with the new token', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle({ unauthorizedApiRequests: 1 })
    const text = await run(toolsOf(fake).gmail_search, { query: 'invoice' })

    expect(fake.refreshCalls).toBe(1)
    expect(text).toContain('Invoice 2026-114')
    const retried = fake.requests.filter(r => r.url.includes('/users/me/messages?'))
    expect(retried).toHaveLength(2)
    expect(retried[0].authorization).toBe('Bearer access-token-before-refresh')
    expect(retried[1].authorization).toBe('Bearer access-token-after-refresh')
  })

  it('turns a second 401 into an error instead of a second refresh', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle({ unauthorizedApiRequests: 2 })
    const text = await run(toolsOf(fake).gmail_search, { query: 'invoice' })

    expect(fake.refreshCalls).toBe(1)
    expect(text).toContain('upstream http_401')
  })

  it('turns invalid_grant into reauth_required and marks the connector', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle({ unauthorizedApiRequests: 1, invalidGrantOnRefresh: true })
    const text = await run(toolsOf(fake).gmail_search, { query: 'invoice' })

    expect(text).toContain('reauth_required')
    expect(getConnectorRecord(manifest.id).status).toBe('reauth_required')
    // No retry loop: one token call, no second data call.
    expect(fake.refreshCalls).toBe(1)
  })

  it('refreshes proactively when the stored token is about to expire', async () => {
    connect(-1_000)
    const fake = createFakeGoogle()
    const text = await run(toolsOf(fake).calendar_events, { from: '2026-09-28', to: '2026-09-28' })
    expect(fake.refreshCalls).toBe(1)
    expect(text).toContain('Team sync')
  })

  it('never puts a token into a tool answer', async () => {
    connect(3_600_000)
    const fake = createFakeGoogle({ unauthorizedApiRequests: 1 })
    const answers = [
      await run(toolsOf(fake).gmail_search, { query: 'invoice' }),
      await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1001' }),
      await run(toolsOf(fake).calendar_events, { from: '2026-09-28', to: '2026-09-28' }),
    ].join('\n')
    expect(answers).not.toContain('access-token')
    expect(answers).not.toContain('refresh-token')
    expect(answers).not.toContain(CLIENT_SECRET)
    expect(answers).not.toContain('Bearer ')
  })
})

describe('helpers', () => {
  it('decodes base64url without padding', () => {
    expect(decodeBase64Url('SGFsbG8gQm9i')).toBe('Hallo Bob')
    expect(decodeBase64Url('YT9iP2M-ZD9l')).toBe('a?b?c>d?e')
    expect(decodeBase64Url('')).toBe('')
  })

  it('keeps the first quoted lines and counts the rest', () => {
    const body = ['Answer.', '> one', '> two', '> three', '> four'].join('\n')
    expect(trimQuotes(body)).toBe(['Answer.', '> one', '> two', '[quoted text shortened: 2 more lines]'].join('\n'))
  })

  it('resolves a date to the zone offset of that very day', () => {
    expect(zoneOffset(TZ, new Date('2026-07-01T12:00:00Z'))).toBe('+02:00')
    expect(zoneOffset(TZ, new Date('2026-12-01T12:00:00Z'))).toBe('+01:00')
    expect(toRfc3339('2026-12-01', 'start', TZ)).toBe('2026-12-01T00:00:00+01:00')
    expect(toRfc3339('2026-12-01', 'end', TZ)).toBe('2026-12-01T23:59:59+01:00')
    expect(toRfc3339('2026-07-01T10:00:00Z', 'start', TZ)).toBe('2026-07-01T10:00:00.000Z')
  })
})
