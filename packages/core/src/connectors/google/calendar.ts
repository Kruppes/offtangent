/**
 * Read-only calendar tool of the Google connector.
 *
 * `singleEvents=true` + `orderBy=startTime` is mandatory: without expansion a
 * recurring series comes back as one master entry with a recurrence rule, which
 * a small local model cannot unfold, and `orderBy=startTime` is only legal
 * together with the expansion.
 */
import { Type } from '@earendil-works/pi-ai'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ConnectorToolContext } from '../types.js'
import { buildUrl, googleGetJson } from './api.js'
import { toolError, toolText } from './result.js'
import { formatInZone, toRfc3339 } from './time.js'

/** Hard ceiling on returned events. */
export const CALENDAR_MAX_EVENTS = 50
export const CALENDAR_DEFAULT_CALENDAR_ID = 'primary'

interface CalendarEventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

interface CalendarEvent {
  id?: string
  summary?: string
  location?: string
  status?: string
  start?: CalendarEventTime
  end?: CalendarEventTime
}

interface CalendarListResponse {
  items?: CalendarEvent[]
  nextPageToken?: string
}

/** Pages per request; the cap is enforced on VALID events, not on page size. */
export const CALENDAR_PAGE_SIZE = 50
/** Safety net so a calendar full of cancelled entries cannot page forever. */
export const CALENDAR_MAX_PAGES = 10

export interface NormalizedEvent {
  start: string
  end: string
  title: string
  location: string
  allDay: boolean
}

/**
 * An all-day event carries `date` instead of `dateTime`, and its `end.date` is
 * EXCLUSIVE — a single-day event on the 29th ends on the 30th. The exclusive day
 * is folded back so a model never reports a two-day holiday.
 */
export function normalizeEvent(event: CalendarEvent, timeZone: string): NormalizedEvent {
  const allDay = Boolean(event.start?.date && !event.start?.dateTime)
  const title = (event.summary ?? '').trim() || '(no title)'
  const location = (event.location ?? '').trim()

  if (allDay) {
    const start = event.start?.date ?? ''
    const endExclusive = event.end?.date ?? ''
    let end = endExclusive
    if (endExclusive) {
      const parsed = new Date(`${endExclusive}T00:00:00Z`)
      if (!Number.isNaN(parsed.getTime())) {
        parsed.setUTCDate(parsed.getUTCDate() - 1)
        end = parsed.toISOString().slice(0, 10)
      }
    }
    return { start, end: end || start, title, location, allDay: true }
  }

  const format = (value: string | undefined): string => {
    if (!value) return ''
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : formatInZone(parsed, timeZone)
  }
  return { start: format(event.start?.dateTime), end: format(event.end?.dateTime), title, location, allDay: false }
}

export function renderEventLine(event: NormalizedEvent): string {
  return [
    event.start || '(unknown)',
    event.end || '(unknown)',
    event.title,
    event.location || '-',
    event.allDay ? 'all_day=yes' : 'all_day=no',
  ].join(' | ')
}

export interface CalendarToolOptions {
  ctx: ConnectorToolContext
  baseUrl: string
  /** Resolved once per tool creation so one run stays consistent. */
  timeZone: string
  counters?: { refreshes: number }
}

export function createCalendarEventsTool(options: CalendarToolOptions): AgentTool {
  const { ctx, baseUrl, timeZone, counters } = options
  return {
    name: 'calendar_events',
    label: 'List calendar events',
    description: [
      'List calendar entries in a time range. One line per entry:',
      'start, end, title, location, all-day flag.',
      'Example: `calendar_events(from: "2026-09-28", to: "2026-09-28")` for one day,',
      'or `from: "2026-09-28T08:00", to: "2026-09-28T18:00"` for a window.',
      `Dates without a time cover the whole day in ${timeZone}. At most ${CALENDAR_MAX_EVENTS} entries,`,
      'recurring series are already expanded and sorted by start.',
    ].join(' '),
    parameters: Type.Object({
      from: Type.String({ description: 'Start of the range, YYYY-MM-DD or ISO date-time.' }),
      to: Type.String({ description: 'End of the range, YYYY-MM-DD or ISO date-time.' }),
      calendarId: Type.Optional(Type.String({
        description: `Calendar id, default "${CALENDAR_DEFAULT_CALENDAR_ID}" (the main calendar).`,
      })),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const raw = (params ?? {}) as { from?: unknown; to?: unknown; calendarId?: unknown }
      const from = typeof raw.from === 'string' ? raw.from.trim() : ''
      const to = typeof raw.to === 'string' ? raw.to.trim() : ''
      if (!from || !to) return toolError('`from` and `to` are required, e.g. from "2026-09-28" to "2026-09-28".')
      const calendarId = typeof raw.calendarId === 'string' && raw.calendarId.trim()
        ? raw.calendarId.trim()
        : CALENDAR_DEFAULT_CALENDAR_ID

      try {
        const timeMin = toRfc3339(from, 'start', timeZone)
        const timeMax = toRfc3339(to, 'end', timeZone)

        // Google decides how many entries fit on a page, and cancelled entries
        // are dropped AFTER that. One page is therefore not "the first 50" —
        // it can be two real events plus 48 cancellations. Follow the pages
        // until the cap of VALID events is full, then say so.
        const events: NormalizedEvent[] = []
        let pageToken = ''
        let truncated = false
        for (let page = 0; page < CALENDAR_MAX_PAGES; page += 1) {
          const response = await googleGetJson<CalendarListResponse>(
            ctx,
            buildUrl(baseUrl, `calendars/${encodeURIComponent(calendarId)}/events`, {
              timeMin,
              timeMax,
              singleEvents: 'true',
              orderBy: 'startTime',
              maxResults: CALENDAR_PAGE_SIZE,
              timeZone,
              ...(pageToken ? { pageToken } : {}),
            }),
            counters,
            signal,
          )
          for (const event of response.items ?? []) {
            if (event.status === 'cancelled') continue
            if (events.length >= CALENDAR_MAX_EVENTS) {
              truncated = true
              break
            }
            events.push(normalizeEvent(event, timeZone))
          }
          pageToken = response.nextPageToken ?? ''
          if (truncated || !pageToken) break
          if (page === CALENDAR_MAX_PAGES - 1) truncated = true
        }

        if (events.length === 0) {
          return toolText(`No entries between ${from} and ${to} in calendar "${calendarId}".`, { events: 0 })
        }
        const note = truncated
          ? ` Achtung: mehr als ${CALENDAR_MAX_EVENTS} Termine in diesem Zeitraum — die Liste ist abgeschnitten, Zeitraum eingrenzen.`
          : ''
        return toolText(
          [
            `${events.length} entr(y|ies) between ${from} and ${to} in "${calendarId}" (${timeZone}).${note}`,
            'start | end | title | location | all_day',
            ...events.map(renderEventLine),
          ].join('\n'),
          { events: events.length, truncated },
        )
      } catch (err) {
        return toolError(err)
      }
    },
  } as AgentTool
}
