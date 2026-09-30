/**
 * Regressions from the two adversarial reviews of 2026-09-26 (P4).
 *
 * Every fixture is synthetic: Alice, Bob, `example.com`, invented ids. The
 * upstream is a hand-written `fetchImpl` per test, so each case is exactly the
 * one response shape the review complained about.
 */
import { describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createGmailSearchTool, createGmailReadThreadTool } from './gmail.js'
import {
  decodeBase64Url,
  GMAIL_FORWARD_MARKER,
  InvalidBase64UrlError,
  messageBodyText,
  trimQuotes,
} from './gmail.js'
import { createCalendarEventsTool, CALENDAR_MAX_EVENTS } from './calendar.js'
import { toRfc3339, resolveWallClock } from './time.js'
import type { ConnectorToolContext } from '../types.js'

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3/'

function b64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function ctxWith(fetchImpl: typeof fetch): ConnectorToolContext {
  return {
    connectorId: 'google-review',
    dataClass: 'local_only',
    getAccessToken: async () => 'access-token-synthetic',
    fetchImpl,
  }
}

async function run(tool: AgentTool, params: Record<string, unknown>): Promise<string> {
  const result = await (tool as unknown as {
    execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }>
  }).execute('call-1', params)
  return result.content.map(part => part.text).join('\n')
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

// ── H2: charsets ──────────────────────────────────────────────────────

describe('part charsets (H2)', () => {
  const message = (charset: string, bytes: Buffer) => ({
    id: 'm-1',
    payload: {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }],
      body: { size: bytes.length, data: b64url(bytes) },
    },
  })

  it('decodes an iso-8859-1 body with umlauts', () => {
    // "Grüße, Bob — Äpfel" in latin-1 bytes.
    const bytes = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x2c, 0x20, 0xc4, 0x70, 0x66, 0x65, 0x6c])
    expect(messageBodyText(message('iso-8859-1', bytes))).toBe('Grüße, Äpfel')
  })

  it('decodes an iso-8859-15 body with a euro sign', () => {
    // 0xa4 is € in latin-9, ¤ in latin-1.
    const bytes = Buffer.from([0x32, 0x34, 0x38, 0x2c, 0x35, 0x30, 0x20, 0xa4])
    expect(messageBodyText(message('iso-8859-15', bytes))).toBe('248,50 €')
  })

  it('decodes a windows-1252 body with umlauts and a euro sign', () => {
    // 0x80 is € in cp1252 and undefined in latin-1.
    const bytes = Buffer.from([0xdc, 0x62, 0x65, 0x72, 0x77, 0x65, 0x69, 0x73, 0x75, 0x6e, 0x67, 0x3a, 0x20, 0x80])
    expect(messageBodyText(message('windows-1252', bytes))).toBe('Überweisung: €')
  })

  it('falls back to utf-8 for a missing or unknown charset', () => {
    const utf8 = Buffer.from('Grüße, Bob', 'utf-8')
    expect(messageBodyText({
      id: 'm-2',
      payload: { mimeType: 'text/plain', body: { size: utf8.length, data: b64url(utf8) } },
    })).toBe('Grüße, Bob')
    expect(messageBodyText(message('x-not-a-charset', utf8))).toBe('Grüße, Bob')
  })
})

// ── N1: base64url validation ──────────────────────────────────────────

describe('decodeBase64Url (N1)', () => {
  it('decodes valid data, padded or not', () => {
    expect(decodeBase64Url('SGFsbG8gQm9i')).toBe('Hallo Bob')
    expect(decodeBase64Url('YT9iP2M-ZD9l')).toBe('a?b?c>d?e')
    expect(decodeBase64Url('')).toBe('')
  })

  it('rejects data outside the alphabet instead of returning garbage', () => {
    expect(() => decodeBase64Url('nicht base64!! *** <html>')).toThrow(InvalidBase64UrlError)
    expect(() => decodeBase64Url('SGFsbG8gQm9i!!')).toThrow(InvalidBase64UrlError)
    expect(() => decodeBase64Url('A')).toThrow(InvalidBase64UrlError)
  })

  it('keeps an unreadable part from killing the whole body', () => {
    const text = messageBodyText({
      id: 'm-3',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { size: 3, data: '###' } },
          { mimeType: 'text/plain', body: { size: 5, data: b64url(Buffer.from('Hallo', 'utf-8')) } },
        ],
      },
    })
    expect(text).toContain('unreadable part')
    expect(text).toContain('Hallo')
  })
})

// ── N2: forwarded messages ────────────────────────────────────────────

describe('forwarded messages (N2)', () => {
  it('marks an embedded message/rfc822 part', () => {
    const own = b64url(Buffer.from('FYI, siehe unten.', 'utf-8'))
    const inner = b64url(Buffer.from('Ursprungstext von Alice.', 'utf-8'))
    const text = messageBodyText({
      id: 'm-4',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { size: 10, data: own } },
          {
            mimeType: 'message/rfc822',
            body: { size: 0 },
            parts: [{ mimeType: 'text/plain', body: { size: 10, data: inner } }],
          },
        ],
      },
    })
    expect(text).toBe(['FYI, siehe unten.', GMAIL_FORWARD_MARKER, 'Ursprungstext von Alice.'].join('\n'))
  })
})

// ── H3: quotes and bottom posting ─────────────────────────────────────

describe('trimQuotes (H3)', () => {
  it('keeps text written BELOW the attribution (bottom posting)', () => {
    const body = [
      'On 2026-09-21 Alice <alice@example.com> wrote:',
      '> Passt der Termin am Donnerstag?',
      '> Viele Grüße, Alice',
      '',
      'Ja, Donnerstag 14:00 passt.',
      'Der Vertrag ist unterschrieben.',
    ].join('\n')
    const out = trimQuotes(body)
    expect(out).toContain('Ja, Donnerstag 14:00 passt.')
    expect(out).toContain('Der Vertrag ist unterschrieben.')
    expect(out).toContain('> Passt der Termin am Donnerstag?')
  })

  it('recognises a Gmail attribution wrapped over a line break (B case 2c)', () => {
    const body = [
      'Antwort oben.',
      'On Mon, Sep 21, 2026 at 9:12 AM Alice Example <',
      'alice@example.com> wrote:',
      '> alte Zeile 1',
      '> alte Zeile 2',
      '> alte Zeile 3',
      '> alte Zeile 4',
      'Und noch ein Nachsatz.',
    ].join('\n')
    const out = trimQuotes(body)
    expect(out).toContain('Antwort oben.')
    expect(out).not.toContain('alice@example.com> wrote:')
    expect(out).toContain('[quoted text shortened: 2 more lines]')
    expect(out).toContain('Und noch ein Nachsatz.')
  })

  it('shortens a German attribution too, without dropping the answer', () => {
    const body = [
      'Am 21.09.2026 um 09:12 schrieb Alice <alice@example.com>:',
      '> Frage?',
      '',
      'Antwort unten drunter.',
    ].join('\n')
    const out = trimQuotes(body)
    expect(out).not.toContain('schrieb Alice')
    expect(out).toContain('Antwort unten drunter.')
  })
})

// ── DST-1 / M1 ────────────────────────────────────────────────────────

describe('DST boundaries (DST-1 / M1)', () => {
  const BERLIN = 'Europe/Berlin'
  const AUCKLAND = 'Pacific/Auckland'

  it('uses the offset of midnight for start and of 23:59:59 for end (spring)', () => {
    // 2026-03-29: +01:00 at midnight, +02:00 in the evening.
    expect(toRfc3339('2026-03-29', 'start', BERLIN)).toBe('2026-03-29T00:00:00+01:00')
    expect(toRfc3339('2026-03-29', 'end', BERLIN)).toBe('2026-03-29T23:59:59+02:00')
  })

  it('uses the offset of midnight for start and of 23:59:59 for end (autumn)', () => {
    // 2026-10-25: +02:00 at midnight, +01:00 in the evening. The old code used
    // the noon offset for both and lost the first hour of the day.
    expect(toRfc3339('2026-10-25', 'start', BERLIN)).toBe('2026-10-25T00:00:00+02:00')
    expect(toRfc3339('2026-10-25', 'end', BERLIN)).toBe('2026-10-25T23:59:59+01:00')
  })

  it('covers the whole day on a southern-hemisphere transition', () => {
    // 2026-04-05, Auckland: NZDT (+13:00) until 03:00, NZST (+12:00) after.
    expect(toRfc3339('2026-04-05', 'start', AUCKLAND)).toBe('2026-04-05T00:00:00+13:00')
    expect(toRfc3339('2026-04-05', 'end', AUCKLAND)).toBe('2026-04-05T23:59:59+12:00')
    const start = Date.parse(toRfc3339('2026-04-05', 'start', AUCKLAND))
    const end = Date.parse(toRfc3339('2026-04-05', 'end', AUCKLAND))
    // 25 hours minus one second on the long day.
    expect(end - start).toBe(25 * 3_600_000 - 1_000)
  })

  it('gives a wall-clock input the offset of that very time', () => {
    expect(toRfc3339('2026-10-25T01:30', 'start', BERLIN)).toBe('2026-10-25T01:30:00+02:00')
    expect(toRfc3339('2026-10-25T04:30', 'start', BERLIN)).toBe('2026-10-25T04:30:00+01:00')
    expect(toRfc3339('2026-03-29T00:30', 'start', BERLIN)).toBe('2026-03-29T00:30:00+01:00')
    expect(toRfc3339('2026-03-29T12:00', 'start', BERLIN)).toBe('2026-03-29T12:00:00+02:00')
  })

  it('moves a non-existent time to the next valid one and says so', () => {
    // 02:30 does not exist on 2026-03-29 in Berlin: the clock jumps 02:00→03:00.
    const gap = resolveWallClock(BERLIN, '2026-03-29T02:30:00')
    expect(gap.adjusted).toBe(true)
    expect(gap.iso).toBe('2026-03-29T02:30:00+01:00')
    // …which is 03:30 local, i.e. after the gap.
    expect(new Date(gap.iso).toISOString()).toBe('2026-03-29T01:30:00.000Z')
  })

  it('picks the FIRST occurrence of an ambiguous time', () => {
    const doubled = resolveWallClock(BERLIN, '2026-10-25T02:30:00')
    expect(doubled.adjusted).toBe(false)
    expect(doubled.iso).toBe('2026-10-25T02:30:00+02:00')
  })
})

// ── M2: completeness ──────────────────────────────────────────────────

describe('completeness of the answers (M2)', () => {
  it('follows nextPageToken until the cap of VALID events is reached', async () => {
    const urls: string[] = []
    const event = (n: number, cancelled = false) => ({
      id: `e-${n}`,
      summary: `Termin ${n}`,
      ...(cancelled ? { status: 'cancelled' } : {}),
      start: { dateTime: '2026-09-28T09:00:00+02:00' },
      end: { dateTime: '2026-09-28T10:00:00+02:00' },
    })
    const pages = [
      // 40 valid plus 10 cancelled: a page is NOT 50 usable entries.
      { items: [...Array.from({ length: 40 }, (_, i) => event(i)), ...Array.from({ length: 10 }, (_, i) => event(100 + i, true))], nextPageToken: 'p2' },
      { items: Array.from({ length: 30 }, (_, i) => event(200 + i)), nextPageToken: 'p3' },
      { items: Array.from({ length: 5 }, (_, i) => event(300 + i)) },
    ]
    let call = 0
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input))
      return jsonResponse(pages[Math.min(call++, pages.length - 1)])
    }) as unknown as typeof fetch

    const tool = createCalendarEventsTool({ ctx: ctxWith(fetchImpl), baseUrl: CALENDAR_BASE, timeZone: 'Europe/Berlin' })
    const text = await run(tool, { from: '2026-09-28', to: '2026-09-30' })

    expect(urls.length).toBe(2)
    expect(urls[1]).toContain('pageToken=p2')
    expect(text).toContain(`${CALENDAR_MAX_EVENTS} entr(y|ies)`)
    expect(text).toContain(`mehr als ${CALENDAR_MAX_EVENTS} Termine`)
    expect(text).toContain('Zeitraum eingrenzen')
    // Cancelled entries never show up and never consume a slot.
    expect(text).not.toContain('Termin 100')
  })

  it('does not claim truncation when everything fits', async () => {
    const fetchImpl = (async () => jsonResponse({
      items: [{
        id: 'e-1',
        summary: 'Standup',
        start: { dateTime: '2026-09-28T09:00:00+02:00' },
        end: { dateTime: '2026-09-28T09:15:00+02:00' },
      }],
    })) as unknown as typeof fetch
    const tool = createCalendarEventsTool({ ctx: ctxWith(fetchImpl), baseUrl: CALENDAR_BASE, timeZone: 'Europe/Berlin' })
    const text = await run(tool, { from: '2026-09-28', to: '2026-09-28' })
    expect(text).toContain('Standup')
    expect(text).not.toContain('mehr als')
  })

  it('tells the model that more mail hits exist', async () => {
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      if (url.includes('users/me/messages?') || url.endsWith('users/me/messages')) {
        return jsonResponse({
          messages: [{ id: 'm-1', threadId: 't-1' }],
          resultSizeEstimate: 412,
          nextPageToken: 'page-2',
        })
      }
      return jsonResponse({
        id: 'm-1',
        threadId: 't-1',
        snippet: 'Kurzfassung',
        payload: { headers: [{ name: 'Subject', value: 'Rechnung' }, { name: 'From', value: 'Alice <alice@example.com>' }] },
      })
    }) as unknown as typeof fetch

    const tool = createGmailSearchTool({ ctx: ctxWith(fetchImpl), baseUrl: GMAIL_BASE, formatDate: value => value })
    const text = await run(tool, { query: 'from:alice@example.com', limit: 1 })
    expect(text).toContain('weitere Treffer')
    expect(text).toContain('412')
  })
})

// ── M3: 403 / 429 ─────────────────────────────────────────────────────

describe('403 and 429 handling (M3)', () => {
  const BODY_CANARY = 'CANARY-body-Betreff-Rechnung-Alice'

  const failing = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    (async () => jsonResponse(body, status, headers)) as unknown as typeof fetch

  it('maps an insufficient scope to reauth_required', async () => {
    const tool = createGmailSearchTool({
      ctx: ctxWith(failing(403, {
        error: {
          code: 403,
          message: `Request had insufficient authentication scopes. ${BODY_CANARY}`,
          errors: [{ reason: 'insufficientPermissions', message: BODY_CANARY }],
          status: 'PERMISSION_DENIED',
        },
      })),
      baseUrl: GMAIL_BASE,
      formatDate: value => value,
    })
    const text = await run(tool, { query: 'from:alice@example.com' })
    expect(text).toContain('reauth_required')
    expect(text).toContain('Neu verbinden nötig (Berechtigung fehlt)')
    expect(text).not.toContain(BODY_CANARY)
  })

  it('maps ACCESS_TOKEN_SCOPE_INSUFFICIENT to reauth_required', async () => {
    const tool = createGmailSearchTool({
      ctx: ctxWith(failing(403, { error: { status: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', message: BODY_CANARY } })),
      baseUrl: GMAIL_BASE,
      formatDate: value => value,
    })
    const text = await run(tool, { query: 'x' })
    expect(text).toContain('reauth_required')
    expect(text).not.toContain(BODY_CANARY)
  })

  it('maps a 403 rate limit to rate_limited with the retry hint and no retry loop', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse(
        { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded', message: BODY_CANARY }] } },
        403,
        { 'retry-after': '42' },
      )
    }) as unknown as typeof fetch
    const tool = createGmailSearchTool({ ctx: ctxWith(fetchImpl), baseUrl: GMAIL_BASE, formatDate: value => value })
    const text = await run(tool, { query: 'x' })
    expect(text).toContain('rate_limited')
    expect(text).toContain('42 Sekunden')
    expect(text).toContain('Nicht sofort wiederholen')
    expect(text).not.toContain(BODY_CANARY)
    expect(calls).toBe(1)
  })

  it('maps a 429 to rate_limited', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return jsonResponse({ error: { code: 429, message: BODY_CANARY } }, 429, { 'retry-after': '7' })
    }) as unknown as typeof fetch
    const tool = createGmailReadThreadTool({ ctx: ctxWith(fetchImpl), baseUrl: GMAIL_BASE, formatDate: value => value })
    const text = await run(tool, { threadId: 't-1' })
    expect(text).toContain('rate_limited')
    expect(text).toContain('7 Sekunden')
    expect(text).not.toContain(BODY_CANARY)
    expect(calls).toBe(1)
  })
})

// ── K1: request deadline ──────────────────────────────────────────────

describe('request deadline (K1)', () => {
  it('aborts a hanging request via the tool signal', async () => {
    const controller = new AbortController()
    let sawSignal: AbortSignal | undefined
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      sawSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    }) as unknown as typeof fetch

    const tool = createGmailSearchTool({ ctx: ctxWith(fetchImpl), baseUrl: GMAIL_BASE, formatDate: value => value })
    const pending = (tool as unknown as {
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text: string }> }>
    }).execute('call-1', { query: 'x' }, controller.signal)

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sawSignal).toBeDefined()
    controller.abort()

    const text = (await pending).content.map(part => part.text).join('\n')
    expect(text).toContain('timeout')
  })
})
