/**
 * Interaction card telemetry (S0-B/B1).
 *
 * Counters only: a channel, an event name and a number. No message content, no
 * block id, no question text, no user id ever enters this module — the call
 * sites hand over nothing but the two enum values, so a log line or the admin
 * snapshot cannot leak what a card asked.
 *
 * In-memory per process (reset on restart) plus one log line per event, so a
 * longer window can be summed from the log. The admin health endpoint
 * (`GET /api/health`, field `interactionTelemetry`) returns the snapshot.
 */

export const INTERACTION_TELEMETRY_CHANNELS = ['web', 'android', 'telegram', 'other'] as const
export type InteractionTelemetryChannel = typeof INTERACTION_TELEMETRY_CHANNELS[number]

export const INTERACTION_TELEMETRY_EVENTS = [
  /** Client: an unterminated card fence was drawn as a placeholder while streaming. */
  'stream_placeholder',
  /** Client: an unterminated card fence was visible as raw JSON while streaming. */
  'stream_raw',
  /** Client: a stream ended (abort/error) while a card fence was still open. */
  'stream_cut',
  /** Server: a persisted card fence parsed strictly. */
  'parse_ok',
  /** Server: a persisted card fence parsed only after the repair pass. */
  'parse_repaired',
  /** Server: a persisted card fence did not parse at all (stays text). */
  'parse_broken',
  /** Client: a card button was tapped before the message had its id. */
  'click_not_ready',
  /** Server: an answer was filed through `POST /api/interactions`. */
  'answered',
  /** Server/client: a card was dismissed explicitly (QW6, S1-A). */
  'dismissed',
  /** Client: a card was shown closed as "skipped" by the shared stale rule. */
  'superseded',
] as const
export type InteractionTelemetryEvent = typeof INTERACTION_TELEMETRY_EVENTS[number]

/** Events a client may report itself (`POST /api/interactions/telemetry`). */
export const CLIENT_INTERACTION_TELEMETRY_EVENTS: readonly InteractionTelemetryEvent[] = [
  'stream_placeholder', 'stream_raw', 'stream_cut', 'click_not_ready', 'superseded',
]

export type InteractionTelemetrySnapshot = {
  since: string
  counters: Record<InteractionTelemetryChannel, Record<InteractionTelemetryEvent, number>>
}

function emptyRow(): Record<InteractionTelemetryEvent, number> {
  const row = {} as Record<InteractionTelemetryEvent, number>
  for (const event of INTERACTION_TELEMETRY_EVENTS) row[event] = 0
  return row
}

function emptyCounters(): InteractionTelemetrySnapshot['counters'] {
  const counters = {} as InteractionTelemetrySnapshot['counters']
  for (const channel of INTERACTION_TELEMETRY_CHANNELS) counters[channel] = emptyRow()
  return counters
}

let counters = emptyCounters()
let since = new Date().toISOString()
let logger: ((line: string) => void) | null = line => console.info(line)

/**
 * Map a turn source / client name onto a telemetry channel. Unknown values
 * land in `other`, never in a new bucket, so a client cannot grow the map.
 */
export function normalizeInteractionChannel(value: unknown): InteractionTelemetryChannel {
  if (typeof value !== 'string') return 'other'
  const v = value.trim().toLowerCase()
  if (v === 'web' || v.startsWith('web:')) return 'web'
  if (v === 'android' || v === 'app' || v.startsWith('app:') || v.startsWith('android:')) return 'android'
  if (v === 'telegram' || v.startsWith('telegram:')) return 'telegram'
  return 'other'
}

export function isInteractionTelemetryEvent(value: unknown): value is InteractionTelemetryEvent {
  return typeof value === 'string' && (INTERACTION_TELEMETRY_EVENTS as readonly string[]).includes(value)
}

/** Count one event. Never throws. */
export function recordInteractionEvent(channel: unknown, event: InteractionTelemetryEvent, count = 1): void {
  try {
    if (!isInteractionTelemetryEvent(event) || !Number.isFinite(count) || count <= 0) return
    const bucket = normalizeInteractionChannel(channel)
    counters[bucket][event] += Math.floor(count)
    logger?.(`[interaction-telemetry] channel=${bucket} event=${event} count=${Math.floor(count)}`)
  } catch {
    // Telemetry must never break a turn.
  }
}

export function getInteractionTelemetry(): InteractionTelemetrySnapshot {
  const copy = emptyCounters()
  for (const channel of INTERACTION_TELEMETRY_CHANNELS) Object.assign(copy[channel], counters[channel])
  return { since, counters: copy }
}

/** Tests only: reset the counters and optionally swap the log sink. */
export function resetInteractionTelemetry(options: { logger?: ((line: string) => void) | null } = {}): void {
  counters = emptyCounters()
  since = new Date().toISOString()
  if ('logger' in options) logger = options.logger ?? null
}
