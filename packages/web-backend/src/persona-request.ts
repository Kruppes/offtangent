/**
 * Request-level validation shared by the WebSocket chat and the REST chat
 * routes (Axiom-Companion M1): which persona a message targets and the
 * client's idempotency key. One module so both entry points answer the
 * question identically (two code paths for one question drift).
 */
import { listPersonaIds } from '@axiom/core'

/** Upper bound for a client-supplied idempotency key (UUIDs are 36 chars). */
const CLIENT_MESSAGE_ID_MAX_LENGTH = 64
/** Only opaque ids: no whitespace/control chars, nothing that needs escaping. */
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * Validate an inbound `clientMessageId`. Returns the id, `undefined` when
 * absent, or `null` when present but malformed (caller rejects the frame).
 */
export function normalizeClientMessageId(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') return null
  if (raw.length > CLIENT_MESSAGE_ID_MAX_LENGTH) return null
  if (!CLIENT_MESSAGE_ID_PATTERN.test(raw)) return null
  return raw
}

/** Upper bound for an inbound session id (UUIDs are 36 chars). */
const SESSION_ID_MAX_LENGTH = 64
/** Session ids are UUIDs; accept the same opaque alphabet as message keys. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/

/**
 * Validate an inbound `sessionId` (Offtangent Stufe 1: explicit thread
 * selection). Returns the id, `undefined` when absent (legacy clients keep
 * the heuristic session), or `null` when present but malformed — callers
 * refuse those the same way they refuse a bad `agentId`, rather than
 * silently falling back to another thread.
 */
export function normalizeSessionId(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw !== 'string') return null
  if (raw.length > SESSION_ID_MAX_LENGTH) return null
  if (!SESSION_ID_PATTERN.test(raw)) return null
  return raw
}

/**
 * Resolve the persona an inbound frame/request targets. `undefined`/empty
 * means 'main' (legacy clients). Unknown ids return `null` so the caller can
 * refuse instead of silently creating rows for a persona that does not exist.
 */
export function resolveAgentId(raw: unknown, personaIds: () => string[] = listPersonaIds): string | null {
  if (raw === undefined || raw === null || raw === '') return 'main'
  if (typeof raw !== 'string') return null
  if (raw === 'main') return 'main'
  return personaIds().includes(raw) ? raw : null
}
