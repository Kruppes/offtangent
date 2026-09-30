/**
 * A fake Google API, used by the tests of the Google connector and by the dev
 * smoke script. Never part of the production registry or of any build output.
 *
 * It answers on the REAL production URLs (`gmail.googleapis.com`,
 * `www.googleapis.com/calendar/v3`, `oauth2.googleapis.com/token`) so a test
 * exercises the same URL building the instance uses. Nothing ever reaches the
 * network: the object is handed in as `fetchImpl`.
 *
 * Every address, subject, body and calendar entry is invented (Alice, Bob,
 * `example.com`). One body carries a canary string so the canary gate can prove
 * that mail content never reaches a cloud model.
 */

/** Marker that only the local model may ever see. */
export const GOOGLE_FAKE_CANARY = 'CANARY-4b81e5a2-google-do-not-leak'

export const FAKE_GOOGLE_ACCOUNT = 'bob@example.com'

function b64url(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface FakePart {
  mimeType: string
  filename?: string
  body: { size: number; data?: string; attachmentId?: string }
  parts?: FakePart[]
}

interface FakeMessage {
  id: string
  threadId: string
  snippet: string
  internalDate: string
  headers: { From: string; To: string; Subject: string; Date: string }
  payload: FakePart
}

function textPart(mimeType: string, text: string): FakePart {
  const data = b64url(text)
  return { mimeType, body: { size: text.length, data } }
}

function longBody(): string {
  const paragraph = 'Line of a very long delivery report about order 8821 with nothing secret in it. '
  return `Hello Bob,\n\n${paragraph.repeat(160)}\n\nRegards, Alice`
}

const QUOTED_REPLY = [
  'Payment is out, value date 2026-09-24.',
  '',
  'On 2026-09-21 Alice <alice@example.com> wrote:',
  '> Hello Bob,',
  '> invoice 2026-114 for 248.50 EUR is due on 2026-09-30.',
  '> Please confirm.',
  '> Regards, Alice',
  '> --',
  '> Alice, Example Company',
].join('\n')

export const FAKE_GOOGLE_MESSAGES: FakeMessage[] = [
  {
    id: 'msg-1001a',
    threadId: 'thr-1001',
    snippet: 'Invoice 2026-114 for 248.50 EUR is due on 2026-09-30.',
    internalDate: '1789023120000',
    headers: {
      From: 'Alice <alice@example.com>',
      To: 'Bob <bob@example.com>',
      Subject: 'Invoice 2026-114',
      Date: 'Mon, 21 Sep 2026 09:12:00 +0200',
    },
    payload: textPart(
      'text/plain',
      `Hello Bob,\n\ninvoice 2026-114 for 248.50 EUR is due on 2026-09-30.\nInternal reference: ${GOOGLE_FAKE_CANARY}.\n\nRegards, Alice`,
    ),
  },
  {
    id: 'msg-1001b',
    threadId: 'thr-1001',
    snippet: 'Payment is out, value date 2026-09-24.',
    internalDate: '1789135380000',
    headers: {
      From: 'Bob <bob@example.com>',
      To: 'Alice <alice@example.com>',
      Subject: 'Re: Invoice 2026-114',
      Date: 'Tue, 22 Sep 2026 14:03:00 +0200',
    },
    payload: textPart('text/plain', QUOTED_REPLY),
  },
  {
    id: 'msg-1002a',
    threadId: 'thr-1002',
    snippet: 'The workshop appointment is on Thursday 2026-09-25 at 08:30.',
    internalDate: '1789192800000',
    headers: {
      From: 'Bob <bob@example.com>',
      To: 'Alice <alice@example.com>',
      Subject: 'Workshop appointment',
      Date: 'Wed, 23 Sep 2026 07:45:00 +0200',
    },
    payload: {
      mimeType: 'multipart/alternative',
      body: { size: 0 },
      parts: [
        textPart('text/plain', 'The workshop appointment is on Thursday 2026-09-25 at 08:30.\nPlease bring the spare key.'),
        textPart('text/html', '<html><body><p>HTML variant that must not win.</p></body></html>'),
      ],
    },
  },
  {
    id: 'msg-1003a',
    threadId: 'thr-1003',
    snippet: 'Delivery 8821 arrives on 2026-09-26.',
    internalDate: '1789254000000',
    headers: {
      From: 'Office <office@example.com>',
      To: 'Bob <bob@example.com>',
      Subject: 'Delivery 8821',
      Date: 'Thu, 24 Sep 2026 11:00:00 +0200',
    },
    payload: {
      mimeType: 'multipart/mixed',
      body: { size: 0 },
      parts: [
        textPart(
          'text/html',
          '<html><body><h1>Delivery 8821</h1><p>Arrives on <b>2026-09-26</b>.</p>'
          + '<ul><li>Between 10:00 and 16:00</li><li>Signature required</li></ul>'
          + '<style>p{color:red}</style></body></html>',
        ),
        {
          mimeType: 'application/pdf',
          filename: 'delivery-note.pdf',
          body: { size: 20480, attachmentId: 'att-1' },
        },
      ],
    },
  },
  {
    id: 'msg-1004a',
    threadId: 'thr-1004',
    snippet: 'A very long delivery report.',
    internalDate: '1789340400000',
    headers: {
      From: 'Alice <alice@example.com>',
      To: 'Bob <bob@example.com>',
      Subject: 'Long delivery report',
      Date: 'Fri, 25 Sep 2026 11:00:00 +0200',
    },
    payload: textPart('text/plain', longBody()),
  },
]

export const FAKE_CALENDAR_EVENTS = [
  {
    id: 'ev-1',
    summary: 'Team sync',
    location: 'Meeting room 2',
    status: 'confirmed',
    start: { dateTime: '2026-09-28T09:00:00+02:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-09-28T09:45:00+02:00', timeZone: 'Europe/Berlin' },
  },
  {
    id: 'ev-2',
    summary: 'Public holiday',
    status: 'confirmed',
    start: { date: '2026-09-29' },
    end: { date: '2026-09-30' },
  },
  {
    id: 'ev-3',
    summary: 'Call with Alice',
    location: 'Phone',
    status: 'confirmed',
    start: { dateTime: '2026-09-29T16:30:00+02:00' },
    end: { dateTime: '2026-09-29T17:00:00+02:00' },
  },
  {
    id: 'ev-4',
    summary: 'Cancelled slot',
    status: 'cancelled',
    start: { dateTime: '2026-09-28T13:00:00+02:00' },
    end: { dateTime: '2026-09-28T13:30:00+02:00' },
  },
]

export interface FakeGoogleOptions {
  /** How many API requests answer `401` before the normal answer is served. */
  unauthorizedApiRequests?: number
  /** The token endpoint answers `invalid_grant` instead of a new token. */
  invalidGrantOnRefresh?: boolean
  /** Access token the fake accepts after a refresh. */
  refreshedAccessToken?: string
  messages?: FakeMessage[]
  events?: unknown[]
}

export interface FakeGoogleRequest {
  method: string
  url: string
  authorization: string
  body: string
}

export interface FakeGoogle {
  fetchImpl: typeof fetch
  requests: FakeGoogleRequest[]
  /** Requests against the token endpoint. */
  refreshCalls: number
  /** Requests against a data endpoint (including the ones answered with 401). */
  apiCalls: number
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function messageMetadata(message: FakeMessage, wanted: string[]): unknown {
  const headers = Object.entries(message.headers)
    .filter(([name]) => wanted.length === 0 || wanted.some(w => w.toLowerCase() === name.toLowerCase()))
    .map(([name, value]) => ({ name, value }))
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    internalDate: message.internalDate,
    payload: { mimeType: message.payload.mimeType, headers },
  }
}

function messageFull(message: FakeMessage): unknown {
  const headers = Object.entries(message.headers).map(([name, value]) => ({ name, value }))
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    internalDate: message.internalDate,
    payload: { ...message.payload, headers },
  }
}

/** Naive Gmail query matching: `from:` / `subject:` plus free-text substrings. */
function matchesQuery(message: FakeMessage, query: string): boolean {
  const haystack = [
    message.headers.From,
    message.headers.To,
    message.headers.Subject,
    message.snippet,
  ].join(' ').toLowerCase()

  for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const [key, ...rest] = token.split(':')
    const value = rest.join(':')
    if (value && key === 'from') {
      if (!message.headers.From.toLowerCase().includes(value)) return false
      continue
    }
    if (value && key === 'subject') {
      if (!message.headers.Subject.toLowerCase().includes(value)) return false
      continue
    }
    if (value && ['after', 'before', 'newer_than', 'older_than', 'is', 'has', 'label', 'in', 'to'].includes(key)) {
      continue
    }
    if (!haystack.includes(token)) return false
  }
  return true
}

/**
 * Build the fake. The returned `fetchImpl` is a drop-in for `fetch` and refuses
 * every URL it does not know, so a typo in a test fails loudly instead of
 * silently reaching the internet.
 */
export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const messages = options.messages ?? FAKE_GOOGLE_MESSAGES
  const events = options.events ?? FAKE_CALENDAR_EVENTS
  const refreshedAccessToken = options.refreshedAccessToken ?? 'access-token-after-refresh'
  let unauthorizedLeft = options.unauthorizedApiRequests ?? 0

  const state: FakeGoogle = {
    fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    requests: [],
    refreshCalls: 0,
    apiCalls: 0,
  }

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = new Headers(init?.headers ?? {})
    const body = typeof init?.body === 'string' ? init.body : ''
    state.requests.push({
      method,
      url: url.toString(),
      authorization: headers.get('authorization') ?? '',
      body,
    })

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      state.refreshCalls += 1
      if (options.invalidGrantOnRefresh) {
        return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
      }
      return json({ access_token: refreshedAccessToken, expires_in: 3599, scope: '', token_type: 'Bearer' })
    }

    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/revoke') {
      return new Response('', { status: 200 })
    }

    state.apiCalls += 1
    if (unauthorizedLeft > 0) {
      unauthorizedLeft -= 1
      return json({ error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } }, 401)
    }

    // ── Gmail ──
    if (url.hostname === 'gmail.googleapis.com') {
      const path = url.pathname.replace(/^\/gmail\/v1\//, '')
      if (path === 'users/me/profile') {
        return json({
          emailAddress: FAKE_GOOGLE_ACCOUNT,
          messagesTotal: 1234,
          threadsTotal: 456,
          historyId: '99',
        })
      }
      if (path === 'users/me/messages') {
        const query = url.searchParams.get('q') ?? ''
        const max = Number(url.searchParams.get('maxResults') ?? '10')
        const hits = messages.filter(message => matchesQuery(message, query)).slice(0, max)
        return json({
          messages: hits.map(message => ({ id: message.id, threadId: message.threadId })),
          resultSizeEstimate: hits.length,
        })
      }
      const messageMatch = /^users\/me\/messages\/(.+)$/.exec(path)
      if (messageMatch) {
        const found = messages.find(message => message.id === decodeURIComponent(messageMatch[1]))
        if (!found) return json({ error: { code: 404, message: 'Not Found' } }, 404)
        const format = url.searchParams.get('format') ?? 'full'
        const wanted = url.searchParams.getAll('metadataHeaders')
        return json(format === 'metadata' ? messageMetadata(found, wanted) : messageFull(found))
      }
      const threadMatch = /^users\/me\/threads\/(.+)$/.exec(path)
      if (threadMatch) {
        const id = decodeURIComponent(threadMatch[1])
        const inThread = messages.filter(message => message.threadId === id)
        if (inThread.length === 0) return json({ error: { code: 404, message: 'Not Found' } }, 404)
        return json({ id, messages: inThread.map(messageFull) })
      }
    }

    // ── Calendar ──
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/calendar/v3/calendars/')) {
      const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname)
      if (match) {
        const calendarId = decodeURIComponent(match[1])
        if (calendarId !== 'primary' && calendarId !== 'work@example.com') {
          return json({ error: { code: 404, message: 'Not Found' } }, 404)
        }
        const timeMin = Date.parse(url.searchParams.get('timeMin') ?? '')
        const timeMax = Date.parse(url.searchParams.get('timeMax') ?? '')
        const items = (events as Array<{ start?: { date?: string; dateTime?: string } }>).filter(event => {
          const raw = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : '')
          const at = Date.parse(raw)
          if (Number.isNaN(at) || Number.isNaN(timeMin) || Number.isNaN(timeMax)) return true
          return at >= timeMin && at <= timeMax
        })
        return json({ kind: 'calendar#events', timeZone: url.searchParams.get('timeZone') ?? 'UTC', items })
      }
    }

    return json({ error: { code: 404, message: `fake google: unknown route ${url.pathname}` } }, 404)
  }

  state.fetchImpl = impl as unknown as typeof fetch
  return state
}
