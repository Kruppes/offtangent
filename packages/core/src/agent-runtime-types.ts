export const STALL_OUTCOMES = ['recovered', 'aborted'] as const

/** How a provider stall ended: the stream came back, or the turn was killed. */
export type StallOutcome = (typeof STALL_OUTCOMES)[number]

/**
 * Machine-readable payload of `stall_warning` / `stall_resolved` chunks and of
 * the `provider_stall` chat row they persist. `messageId` is what lets a
 * channel update the already-rendered warning in place instead of appending a
 * second bubble when the stall resolves.
 */
export interface StallInfo {
  /** `chat_messages` row id of the persisted stall notice, when persisted. */
  messageId?: number
  /** ISO timestamp of the last provider activity before the silence. */
  startedAt: string
  /** ISO timestamp of the moment the stall ended. */
  resolvedAt?: string
  /** Silence duration in ms — elapsed idle time so far while unresolved. */
  durationMs: number
  outcome?: StallOutcome
}

/**
 * Machine-readable payload of a `retry_scheduled` chunk: the turn failed with
 * a retryable provider error and will be restarted after `delayMs`. Live-only
 * status — retry notices are never persisted as chat rows.
 */
export interface RetryInfo {
  /** 1-indexed retry attempt. */
  attempt: number
  /** Retry budget of the active policy. */
  maxRetries: number
  /** Backoff delay before the restart. */
  delayMs: number
  /** Provider error that triggered the retry. */
  error: string
}

export const TURN_ERROR_CAUSES = ['non_retryable', 'retry_exhausted', 'agent_unavailable'] as const

/**
 * Why a turn ended terminally:
 * - `non_retryable`: the provider error is deterministic (auth, quota, billing)
 * - `retry_exhausted`: transient error, but the retry budget ran out (or
 *   auto-retry is disabled)
 * - `agent_unavailable`: no agent runtime was available to run the turn
 */
export type TurnErrorCause = (typeof TURN_ERROR_CAUSES)[number]

/**
 * Machine-readable payload of a terminal `error` chunk and of the `turn_error`
 * chat row it persists. `messageId` identifies the persisted row, which is what
 * lets a channel match the live bubble to the one rebuilt from history (and,
 * later, hang a manual-retry action off it).
 */
export interface TurnErrorInfo {
  /** `chat_messages` row id of the persisted error notice, when persisted. */
  messageId?: number
  /**
   * Id of the manual-retry chat action hanging off this error. Persisted with
   * the row, so the Retry button can be rebuilt after a page reload.
   */
  retryActionId?: string
  cause: TurnErrorCause
  /** Full provider error text, verbatim. */
  error: string
  /** Retries spent before giving up (0 when the turn failed fast). */
  attempts: number
  /** Whether the provider error was classified as transient. */
  retryable: boolean
  /** ISO timestamp of the moment the turn failed. */
  occurredAt: string
}

export interface ResponseChunk {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_end' | 'error' | 'done' | 'stall_warning' | 'stall_resolved' | 'retry_scheduled'
  text?: string
  /** Streamed thinking/reasoning delta (for `type: 'thinking'`) */
  thinking?: string
  toolName?: string
  toolCallId?: string
  toolArgs?: unknown
  toolResult?: unknown
  toolIsError?: boolean
  error?: string
  /** Session ID associated with this chunk (used by task-injection streaming). */
  sessionId?: string
  /**
   * Unique per-injection correlation token for task-injection streams.
   * Callers that need to correlate chunks against pre-registered metadata
   * (see `runtime-composition.ts`) must key off this — NOT `sessionId` —
   * because multiple concurrent injections for the same user share the
   * same cached session id, which would otherwise collide.
   */
  injectionId?: string
  /** Stall details (for `type: 'stall_warning' | 'stall_resolved'`). */
  stall?: StallInfo
  /** Retry details (for `type: 'retry_scheduled'`). */
  retry?: RetryInfo
  /** Terminal-error details (for `type: 'error'`), when the turn persisted one. */
  errorInfo?: TurnErrorInfo
}

/**
 * Control signals that bracket the process-wide queue wait of a turn. They
 * are deliberately NOT part of {@link ResponseChunk}: they never reach a
 * transcript, a client or the wire — the TurnRunner consumes them and drops
 * them. `queue_waiting` is emitted before the turn waits for the queue lock,
 * `queue_started` once it holds it and a provider call can actually happen.
 */
export type QueueSignalChunk =
  | { type: 'queue_waiting' }
  | { type: 'queue_started' }

/** What an agent's turn stream yields: response chunks plus queue signals. */
export type TurnStreamChunk = ResponseChunk | QueueSignalChunk

/**
 * Narrows an abort to one session (and optionally one persona). An empty/
 * absent scope keeps the historical process-wide behaviour, so existing
 * callers (`/stop`, provider swaps) are unchanged.
 */
export interface AbortScope {
  sessionId?: string
  agentId?: string
}

export interface AgentRuntimeStateSnapshot {
  modelId: string
  toolNames: string[]
  messageCount: number
}
