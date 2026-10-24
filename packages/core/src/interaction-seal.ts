/**
 * interaction-seal.ts — the secret boundary for interaction rows on their way
 * OUT of the server (S1-A, privacy V3; moved to core in S1-C review 1 so the
 * web backend and the Telegram bot share one boundary).
 *
 * The `payload` of an interaction is the question block as the model wrote
 * it: question, option labels, descriptions, placeholders. It was never
 * sealed, so a credential in an option label would leak through every
 * response, websocket frame or Telegram message that carries the row. Every
 * string in the payload therefore passes the same `sealText` call the answer
 * path uses for the chosen label (tier `user`, source `interaction`),
 * recursively over all nested objects and arrays. Ids pass too: a handle
 * never replaces anything but a secret, so ordinary ids stay byte-identical.
 *
 * The draft (partial answers, free text the user typed) and the answer
 * (value and label) pass the same boundary (review 1, finding 2).
 */
import { sealText } from './secret-boundary.js'
import type { InteractionRecord } from './interaction-store.js'

export function sealInteractionValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sealText(value, { tier: 'user', source: 'interaction' }).text as T
  }
  if (Array.isArray(value)) return value.map(entry => sealInteractionValue(entry)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sealInteractionValue(entry)
    }
    return out as T
  }
  return value
}

/**
 * The row with every string of its `payload`, its `draft` and its `answer`
 * sealed (review 1, finding 2). The table stays the raw source — backfilled
 * answer labels are imported unsealed — and this function is the boundary:
 * every response body, frame and Telegram card that carries a row goes
 * through it.
 */
export function sealedInteraction(record: InteractionRecord): InteractionRecord {
  return {
    ...record,
    payload: sealInteractionValue(record.payload),
    draft: sealInteractionValue(record.draft),
    answer: sealInteractionValue(record.answer),
  }
}
