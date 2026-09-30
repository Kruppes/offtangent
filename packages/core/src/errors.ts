/**
 * Typed error classes for stable error identification.
 *
 * Use these instead of matching on error message strings so that
 * HTTP routes (and other callers) can reliably map errors to status codes.
 */

export class NotFoundError extends Error {
  // Public API for callers that need stable error identification without instanceof.
  // fallow-ignore-next-line unused-class-member
  readonly code = 'NOT_FOUND' as const

  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class InvalidInputError extends Error {
  // Public API for callers that need stable error identification without instanceof.
  // fallow-ignore-next-line unused-class-member
  readonly code = 'INVALID_INPUT' as const

  constructor(message: string) {
    super(message)
    this.name = 'InvalidInputError'
  }
}

/**
 * Wire codes for a refused explicit thread selection (Offtangent Stufe 1).
 * These are the exact strings the WebSocket chat sends as
 * `{ type: 'error', code }`, so the value is API, not an internal detail.
 */
export type SessionAccessErrorCode =
  | 'session_not_found'
  | 'session_agent_mismatch'
  | 'session_forbidden'

/**
 * Base class for "you may not talk in that session" failures raised by
 * `SessionManager.activateSession`. Transport layers map `code` to their own
 * status codes (WS frame code / HTTP 404, 409, 403).
 */
export abstract class SessionAccessError extends Error {
  abstract readonly code: SessionAccessErrorCode
}

/** The session id is unknown, or not an interactive session (= not a thread). */
export class SessionNotFoundError extends SessionAccessError {
  readonly code = 'session_not_found' as const

  constructor(message = 'Session not found') {
    super(message)
    this.name = 'SessionNotFoundError'
  }
}

/** The session exists but belongs to a different persona than the message. */
export class SessionAgentMismatchError extends SessionAccessError {
  readonly code = 'session_agent_mismatch' as const

  constructor(message = 'Session belongs to another persona') {
    super(message)
    this.name = 'SessionAgentMismatchError'
  }
}

/** The session belongs to another user, or is archived (not writable). */
export class SessionForbiddenError extends SessionAccessError {
  readonly code = 'session_forbidden' as const

  constructor(message = 'Session is not accessible') {
    super(message)
    this.name = 'SessionForbiddenError'
  }
}

const SESSION_ACCESS_ERROR_CODES: readonly string[] = [
  'session_not_found',
  'session_agent_mismatch',
  'session_forbidden',
]

/**
 * Duck-typed guard for the errors above. Used by the transport layers instead
 * of a bare `instanceof` so a duplicated module instance (dist vs. src) can
 * never silently degrade a 404 into a 500.
 */
export function isSessionAccessError(err: unknown): err is SessionAccessError {
  if (err instanceof SessionAccessError) return true
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && SESSION_ACCESS_ERROR_CODES.includes(code)
}

/**
 * A thread was pointed at a project that the caller may not use: unknown id,
 * another user's project, or an archived one. `code` is the wire contract
 * (`400 { error, code: 'project_not_found' }`), so the three cases stay
 * indistinguishable to the client on purpose.
 */
export class ProjectNotFoundError extends Error {
  readonly code = 'project_not_found' as const

  constructor(message = 'Project not found') {
    super(message)
    this.name = 'ProjectNotFoundError'
  }
}

/**
 * Duck-typed guard for {@link ProjectNotFoundError} — same reasoning as
 * {@link isSessionAccessError}: a duplicated module instance (dist vs. src)
 * must not turn a 400 into a 500.
 */
export function isProjectNotFoundError(err: unknown): err is ProjectNotFoundError {
  if (err instanceof ProjectNotFoundError) return true
  if (typeof err !== 'object' || err === null) return false
  return (err as { code?: unknown }).code === 'project_not_found'
}
