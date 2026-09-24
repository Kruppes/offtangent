import { randomUUID } from 'node:crypto'
import type { Database } from './database.js'
import { maskTranscript, DEFAULT_MASK_OPTIONS, RECALLED_MARKER } from './message-digest.js'
import type { DigestableMessage, MaskTranscriptOptions } from './message-digest.js'
import { appendToDailyFile, resolveAgentMemoryDir } from './memory.js'
import { logToolCall } from './token-logger.js'
import {
  extractTopicTags,
  getSessionMessages,
  detectTopicShift,
  queryMemoriesFts,
  buildFactInjection,
  estimateTokens,
  hasAttachmentMarker,
} from './session-store.js'
import type { SessionMessage } from './session-store.js'
import {
  SessionAgentMismatchError,
  SessionForbiddenError,
  SessionNotFoundError,
} from './errors.js'
import { resolveAssignableProjectId } from './project-manager.js'
import { clearStrandProjectSuggestion, getStrandProjectSuggestion } from './project-assignment-store.js'
import type { StrandProjectSuggestion } from './project-assignment-store.js'
import { countStrandLinks, getNowRank, getNowSet, getStrandTags, strandIdsWithTag } from './strand-store.js'
import { deriveStrandTitle } from './strand-title.js'
import { loadHeuristics } from './heuristics.js'
import { toIsoUtc } from './timestamps.js'

/** Options for `SessionManager.buildConversationHistory`. */
export interface BuildConversationHistoryOptions {
  /** Follow `parent_session_id` into task and other child sessions (default true). */
  includeDescendants?: boolean
  /** Render tool result rows as digest lines (default false: skipped as before). */
  includeToolResults?: boolean
  /** Masking budgets; defaults to `DEFAULT_MASK_OPTIONS`. */
  mask?: MaskTranscriptOptions
}

interface TranscriptRow {
  id: number
  session_id: string
  role: string
  content: string
  metadata: string | null
  timestamp: string
}

/**
 * The single canonical session ID generator. All new sessions — interactive,
 * task, heartbeat, consolidation, loop_detection — must obtain their ID from
 * this function so that ID format is uniform across the system.
 */
export function generateSessionId(): string {
  return randomUUID()
}

/** Raw `sessions` row checked by {@link SessionManager.assertSessionAccess}. */
export interface ThreadAccessRow {
  id: string
  user_id: number | null
  session_user: string | null
  source: string
  type: string
  started_at: string
  last_activity: string | null
  ended_at: string | null
  message_count: number
  summary_written: number
  agent_id: string | null
  archived: number
}

/** Raw `sessions` columns a thread is built from. */
interface ThreadRow {
  id: string
  agent_id: string | null
  title: string | null
  pinned: number
  archived: number
  project_id: string | null
  started_at: string
  last_activity: string | null
  ended_at: string | null
  message_count: number
}

/** Columns every thread read selects (kept in one place, used three times). */
const THREAD_COLUMNS =
  'id, agent_id, title, pinned, archived, project_id, started_at, last_activity, ended_at, message_count'

/**
 * Normalize a user-supplied thread title: trimmed, capped, and `null` for
 * empty input (so "clear the title" and "no title" are the same state).
 */
function normalizeThreadTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined) return null
  const trimmed = String(title).trim()
  if (!trimmed) return null
  return trimmed.slice(0, THREAD_TITLE_MAX_LENGTH)
}

/**
 * Merge incoming topic tags into an existing list, de-duplicating and
 * capping at 8 to keep the sliding-window signal bounded.
 */
function mergeTopicTags(existing: string[], incoming: string[]): string[] {
  const merged = [...existing]
  for (const tag of incoming) {
    if (!merged.includes(tag)) {
      merged.push(tag)
    }
  }
  return merged.slice(0, 8)
}

export type SessionType =
  | 'interactive'
  | 'task'
  | 'heartbeat'
  | 'consolidation'
  | 'loop_detection'

export interface CreateSessionOptions {
  type: SessionType
  source: string
  userId?: string
  parentSessionId?: string
  /**
   * Persona that owns this background session. Defaults to 'main'.
   * Without this, task/heartbeat/consolidation sessions spawned for a
   * persona (e.g. Warren's portfolio scan) are mislabeled as 'main' in the
   * `sessions` table, which lets persona content bleed into main-scoped
   * reads (multi-persona bleeding, 2026-07-24).
   */
  agentId?: string
}

export interface SessionInfo {
  id: string
  userId: string
  source: string
  startedAt: number // timestamp ms
  lastActivity: number // timestamp ms
  messageCount: number
  summaryWritten: boolean
  /** True if this session was restored from DB after a server restart */
  restored: boolean
  /** Cached topic tags for the current session (topic-shift detection) */
  topicTags?: string[]
  /** Agent ID for multi-persona support (default: 'main') */
  agentId: string
}

/**
 * A named, explicitly selectable conversation (Offtangent Stufe 1).
 * Threads are exactly the `interactive` rows of the `sessions` table; the
 * shape below is the wire contract of `/api/threads` (camelCase, ISO-8601 UTC
 * timestamps) and must not change field names without updating the frontend.
 */
export interface Thread {
  id: string
  agentId: string
  title: string | null
  pinned: boolean
  archived: boolean
  startedAt: string
  lastActivity: string
  endedAt: string | null
  messageCount: number
  lastMessage: { role: 'user' | 'assistant'; content: string; timestamp: string } | null
  /** True when this thread currently occupies the (user, agent) session slot. */
  active: boolean
  /** Project this thread is grouped under, `null` when ungrouped. */
  projectId: string | null
  /**
   * Open project proposal of the running assignment (Stufe 2): a container
   * the classifier found plausible but not certain. Always `null` while
   * `projectId` is set. The client shows it as a chip with one tap to accept
   * and one to dismiss; the server never applies it by itself.
   */
  projectSuggestion: StrandProjectSuggestion | null
  /** Offtangent strand fields (SPEC 6.2), additive: tag names, now set rank (1 first) and link count. */
  tags: string[]
  nowRank: number | null
  links: number
}

export interface ListThreadsOptions {
  agentId?: string
  includeArchived?: boolean
  limit?: number
  offset?: number
  /**
   * Project filter (Offtangent Stufe 2). `undefined` = no filter, a string
   * restricts to that project, `null` lists only threads WITHOUT a project.
   */
  projectId?: string | null
  /** Offtangent strands (SPEC 6.2): only strands carrying this tag name. */
  tag?: string
  /**
   * Restrict to this explicit list of strand ids (the computed now set, whose
   * order is applied by the caller). An empty list matches nothing.
   */
  ids?: string[]
  /** Only strands in the now set, ordered by rank. */
  nowOnly?: boolean
}

export interface UpdateThreadPatch {
  title?: string | null
  pinned?: boolean
  archived?: boolean
  /**
   * Move the thread into a project (`null` detaches it). The project must
   * exist, belong to the caller and not be archived, otherwise
   * {@link ProjectNotFoundError} is thrown (route: 400 `project_not_found`).
   */
  projectId?: string | null
}

/** Preview length of `Thread.lastMessage.content` (contract: max 200 chars). */
const THREAD_PREVIEW_LENGTH = 200
/** Upper bound for a user-supplied thread title. */
const THREAD_TITLE_MAX_LENGTH = 200

export interface SessionManagerOptions {
  db: Database
  timeoutMinutes?: number
  /**
   * How long a PARKED thread (interactive, `ended_at IS NULL`, not in the
   * (user, agent) slot) may stay idle before the sweep summarizes and closes
   * it. Parked threads carry no inactivity timer — without this sweep they
   * would stay open forever and every restart would iterate all of them.
   * `0` (or negative) disables the sweep entirely.
   */
  parkedTimeoutHours?: number
  /** How often the parked-thread sweep runs. Default 10 minutes. */
  parkedSweepIntervalMinutes?: number
  memoryDir?: string
  /** Base directory containing persona dirs (tests only; default /data/agents). */
  agentsBaseDir?: string
  /**
   * Force-enable/disable scoped per-persona memory for daily-summary writes,
   * bypassing settings (tests / DI). Undefined = resolve from settings.
   */
  scopedAgentMemory?: boolean
  /**
   * Called to generate a summary of the session. Returns the summary text.
   * conversationHistory is built from chat_messages in the DB (single source of truth).
   */
  onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  /**
   * Called when a session is disposed (after summary if applicable).
   *
   * `options.background` is true when the session was ended via
   * `handleNewCommandAsync()` and the summary was generated asynchronously
   * after the new session had already been announced to the client.
   * Listeners use this to deliver the summary as a *late* update event
   * instead of a fresh session_end divider that would duplicate the one
   * already rendered when the new session was opened.
   */
  onSessionEnd?: (
    session: SessionInfo,
    summary: string | null,
    options?: SessionEndCallbackOptions,
  ) => void
  /**
   * Called when a topic shift is detected (or facts are injected on a fresh
   * session). Lets the caller surface the injected memory context to the UI.
   */
  onTopicShift?: (session: SessionInfo, factInjection: string) => void
}

/** Extra context handed to `onSessionEnd` listeners. */
export interface SessionEndCallbackOptions {
  /** Summary arrived late, after a new session was already announced. */
  background?: boolean
  /**
   * The session was closed by the parked-thread sweep: it was NOT the active
   * session of its (user, agent) slot, so listeners must not touch live turn
   * state (runtime messages, client session bindings) — only per-session
   * state such as that thread's transcript.
   */
  parked?: boolean
}

export type SessionEndReason = 'timeout' | 'manual' | 'provider_change' | 'topic_shift'

/**
 * Manages active sessions per user with timeout and auto-summarization.
 *
 * After constructing, call `init()` to handle orphaned sessions from
 * a previous server run (restore or summarize them).
 */
export class SessionManager {
  private sessions: Map<string, SessionInfo> = new Map() // sessionKey (userId:agentId) -> session
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map() // sessionKey -> timeout timer
  private db: Database
  private timeoutMs: number
  /** Idle budget of a parked thread before the sweep closes it (0 = disabled). */
  private parkedTimeoutMs: number
  private parkedSweepIntervalMs: number
  private parkedSweepTimer?: ReturnType<typeof setInterval>
  /** Guards against overlapping sweeps (a summary can take seconds). */
  private sweepRunning = false
  /** Warn once when parked threads need a summary but no summarizer is wired. */
  private warnedMissingSweepSummarizer = false
  private memoryDir?: string
  private agentsBaseDir?: string
  private scopedAgentMemory?: boolean
  private onSummarize?: (sessionId: string, userId: string, conversationHistory?: string) => Promise<string>
  private onSessionEnd?: (
    session: SessionInfo,
    summary: string | null,
    options?: SessionEndCallbackOptions,
  ) => void
  private onTopicShift?: (session: SessionInfo, factInjection: string) => void
  /** Pending fact injection text to be included in the next response, keyed by sessionKey */
  private pendingFactInjection: Map<string, string> = new Map()
  /**
   * Raw tail of the previous session's conversation, injected into the first
   * prompt of a fresh session. A summary alone loses the mid-thought state
   * (open questions, "das von vorhin" references) — the verbatim tail keeps
   * continuity across topic-shift and timeout cuts.
   */
  private pendingSessionTail: Map<string, string> = new Map()
  /**
   * Tracks pending background summary jobs spawned by
   * `handleNewCommandAsync` so `dispose()` can drain them on shutdown
   * and tests can deterministically await completion via
   * `awaitBackgroundJobs()`.
   */
  private backgroundJobs: Set<Promise<void>> = new Set()
  /**
   * Sessions with fewer than this many messages are too short to be worth
   * a summary LLM round-trip (typical: ping/pong = 2 messages). For these
   * we still emit a divider so the user sees a visual session boundary,
   * but we use an em-dash placeholder instead of calling the summarizer
   * (which would just return "Empty session." anyway and waste a model call).
   */
  /** Heuristic `summary.minMessages` (SPEC 12.1), default 3. */
  private static get MIN_MESSAGES_FOR_SUMMARY(): number {
    return loadHeuristics().summary.minMessages
  }
  private static readonly SHORT_SESSION_PLACEHOLDER = 'Empty session.'
  /** Default idle budget of a parked thread (Offtangent Stufe 1). */
  private static readonly DEFAULT_PARKED_TIMEOUT_HOURS = 24
  /** Default cadence of the parked-thread sweep. */
  private static readonly DEFAULT_PARKED_SWEEP_INTERVAL_MINUTES = 10

  constructor(options: SessionManagerOptions) {
    this.db = options.db
    this.timeoutMs = (options.timeoutMinutes ?? 15) * 60 * 1000
    this.parkedTimeoutMs = (options.parkedTimeoutHours ?? SessionManager.DEFAULT_PARKED_TIMEOUT_HOURS) * 60 * 60 * 1000
    this.parkedSweepIntervalMs = Math.max(
      1000,
      (options.parkedSweepIntervalMinutes ?? SessionManager.DEFAULT_PARKED_SWEEP_INTERVAL_MINUTES) * 60 * 1000,
    )
    this.memoryDir = options.memoryDir
    this.agentsBaseDir = options.agentsBaseDir
    this.scopedAgentMemory = options.scopedAgentMemory
    this.onSummarize = options.onSummarize
    this.onSessionEnd = options.onSessionEnd
    this.onTopicShift = options.onTopicShift
  }

  /**
   * Compute the session map key. Uses a userId:agentId composite so the same
   * user can hold independent sessions with different persona bots.
   */
  private sessionKey(userId: string, agentId: string = 'main'): string {
    return `${userId}:${agentId}`
  }

  /**
   * Initialize the session manager. Must be called after construction.
   * Handles orphaned sessions from a previous server run:
   * - Sessions whose timeout has elapsed → summarize and close
   * - Sessions whose timeout has NOT elapsed → restore with remaining timer
   */
  async init(): Promise<void> {
    await this.handleOrphanedSessions()
    this.startParkedSweep()
  }

  /**
   * Handle sessions left open from a previous server run.
   */
  private async handleOrphanedSessions(): Promise<void> {
    // Only interactive sessions go through the inactivity-timeout / summarize
    // lifecycle. Background session types (task, heartbeat, consolidation,
    // loop_detection) are owned by their respective producers and must not be
    // auto-summarized or auto-closed by SessionManager on startup.
    const orphaned = this.db.prepare(
      `SELECT id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id
       FROM sessions WHERE ended_at IS NULL AND type = 'interactive'
       ORDER BY COALESCE(last_activity, started_at) ASC`
    ).all() as Array<{
      id: string
      user_id: number | null
      session_user: string | null
      source: string
      type: string
      started_at: string
      last_activity: string | null
      message_count: number
      summary_written: number
      agent_id: string | null
    }>

    if (orphaned.length === 0) return

    // Guard: a SessionManager without `onSummarize` is not configured to
    // manage the interactive-session lifecycle. If an orphan would hit the
    // summarize-and-close path and we proceeded without an onSummarize
    // handler, we would silently close it and lose the daily-file summary
    // — the exact failure mode that makes a mis-routed init() call
    // invisible (see runtime-composition.ts's background-only
    // SessionManager). Fail fast so misuse surfaces immediately.
    //
    // Only orphans whose timeout has already elapsed AND still carry
    // unsummarized messages are at risk. Orphans within the timeout window
    // are restored, and empty/already-summarized ones are closed
    // losslessly, so neither requires onSummarize.
    if (!this.onSummarize) {
      const now = Date.now()
      const needsSummary = orphaned.filter(r => {
        if (r.summary_written || r.message_count === 0) return false
        const lastActivityStr = r.last_activity ?? r.started_at
        const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
        return (now - lastActivity) >= this.timeoutMs
      })
      if (needsSummary.length > 0) {
        throw new Error(
          `[session] ${needsSummary.length} orphaned interactive session(s) need summarization `
          + `but SessionManager was constructed without an onSummarize handler. `
          + `This instance is not configured to manage the interactive-session lifecycle; `
          + `do not call init() on it.`,
        )
      }
    }

    console.log(`[session] Found ${orphaned.length} orphaned session(s) from previous run`)

    for (const row of orphaned) {
      // Determine last activity time (fall back to started_at for pre-migration sessions)
      const lastActivityStr = row.last_activity ?? row.started_at
      const lastActivity = this.parseSqliteTimestamp(lastActivityStr)
      const elapsed = Date.now() - lastActivity

      // Prefer numeric user_id when present (stable canonical key), then
      // fall back to session_user for rows without user_id (e.g. legacy /
      // non-numeric identities). Final fallback keeps sessions distinct.
      const userId = row.user_id != null
        ? String(row.user_id)
        : (row.session_user ?? `orphan:${row.id}`)

      // No-time-reset guarantee: when timeouts are disabled (timeoutMs <= 0),
      // sessions never expire — always force-restore orphans rather than
      // summarizing+closing them, so a restart can't silently reset a user's
      // long-running conversation.
      if (row.message_count === 0) {
        // An empty thread (created via POST /api/threads, never written to)
        // stays OPEN and timer-less, whatever its age:
        //   - it must not win the slot (orphans are restored oldest-first, so
        //     the last restore owns the slot — an empty thread created after
        //     the real conversation would evict it and the next message would
        //     land in the wrong thread);
        //   - and it must not be closed either, or a thread the user created
        //     minutes before a restart would be gone when the app reopens.
        // The parked sweep retires it once it passes the idle budget.
        console.log(`[session] Leaving empty orphaned thread ${row.id} open and parked (user ${userId}, agent ${row.agent_id ?? 'main'})`)
      } else if (this.timeoutMs > 0 && elapsed >= this.timeoutMs) {
        // Timeout already elapsed → summarize and close
        await this.summarizeAndCloseOrphanedSession(row, userId, lastActivity, { reason: 'server_restart' })
      } else {
        // Timeout not yet elapsed (or timeouts disabled) → restore session
        const remainingMs = this.timeoutMs > 0 ? this.timeoutMs - elapsed : 0
        this.restoreSession(row, userId, lastActivity, remainingMs)
      }
    }
  }

  /**
   * Canonical user key of a raw `sessions` row: prefer the numeric `user_id`,
   * fall back to `session_user`, and keep unknown rows distinct.
   */
  private rowUserId(row: { id: string; user_id?: number | null; session_user: string | null }): string {
    if (row.user_id != null) return String(row.user_id)
    return row.session_user ?? `orphan:${row.id}`
  }

  /** True when this session currently occupies any (user, agent) slot. */
  private isSessionInSlot(sessionId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.id === sessionId) return true
    }
    return false
  }

  /**
   * Start the periodic sweep that retires parked threads.
   *
   * Parked threads (explicitly switched away from, or left open by a restart)
   * deliberately carry NO inactivity timer — otherwise a thread would be
   * closed while the user is writing in a sibling thread. Without a sweep they
   * would never be summarized, the set of `ended_at IS NULL` rows would grow
   * without bound and every startup would iterate all of them.
   */
  private startParkedSweep(): void {
    if (this.parkedSweepTimer || this.parkedTimeoutMs <= 0) return
    const timer = setInterval(() => {
      this.sweepParkedThreads().catch(err => {
        console.error('[session] Parked-thread sweep failed:', err)
      })
    }, this.parkedSweepIntervalMs)
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }
    this.parkedSweepTimer = timer
    console.log(
      `[session] Parked-thread sweep armed: every ${Math.round(this.parkedSweepIntervalMs / 60000)}min, `
      + `idle budget ${Math.round(this.parkedTimeoutMs / 3600000)}h`,
    )
  }

  /**
   * Close parked threads that have been idle longer than `parkedTimeoutHours`.
   *
   * A parked thread is an interactive session with `ended_at IS NULL` that does
   * NOT occupy a (user, agent) slot. Closing follows the regular lifecycle:
   * summary (unless already written or the thread is empty), `ended_at`, a
   * `session_timeout` tool-call entry and `onSessionEnd` — so AgentCore drops
   * the thread's transcript. The thread stays in the list with `endedAt` set
   * and is reopened by the next explicit message (`activateSession`).
   *
   * Sessions held in a slot are never touched, not even when they are idle:
   * those are owned by the inactivity timer.
   *
   * Returns the number of threads closed (tests / diagnostics).
   */
  async sweepParkedThreads(now: number = Date.now()): Promise<number> {
    if (this.parkedTimeoutMs <= 0) return 0
    // A sweep can await several summaries; never let a second one interleave.
    if (this.sweepRunning) return 0
    this.sweepRunning = true

    try {
      const rows = this.db.prepare(
        `SELECT id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id
         FROM sessions WHERE ended_at IS NULL AND type = 'interactive'
         ORDER BY COALESCE(last_activity, started_at) ASC`
      ).all() as Array<{
        id: string
        user_id: number | null
        session_user: string | null
        source: string
        type: string
        started_at: string
        last_activity: string | null
        message_count: number
        summary_written: number
        agent_id: string | null
      }>

      let closed = 0
      for (const row of rows) {
        if (this.isSessionInSlot(row.id)) continue

        const lastActivity = this.parseSqliteTimestamp(row.last_activity ?? row.started_at)
        if (!Number.isFinite(lastActivity)) continue
        if (now - lastActivity < this.parkedTimeoutMs) continue

        // A manager without a summarizer still has to retire parked threads —
        // otherwise they would live forever. The thread is closed without a
        // daily-log entry; warn once so the misconfiguration is visible.
        if (row.message_count > 0 && !row.summary_written && !this.onSummarize) {
          if (!this.warnedMissingSweepSummarizer) {
            this.warnedMissingSweepSummarizer = true
            console.warn('[session] Closing parked threads without a summary: no onSummarize handler is configured')
          }
        }

        const didClose = await this.summarizeAndCloseOrphanedSession(
          row,
          this.rowUserId(row),
          lastActivity,
          { reason: 'parked_timeout' },
        )
        if (didClose) closed++
      }

      if (closed > 0) console.log(`[session] Parked-thread sweep closed ${closed} thread(s)`)
      return closed
    } finally {
      this.sweepRunning = false
    }
  }

  /**
   * Parse a SQLite datetime string to a timestamp in ms.
   * SQLite stores as 'YYYY-MM-DD HH:MM:SS' in UTC without timezone marker.
   */
  private parseSqliteTimestamp(str: string): number {
    // Append 'Z' to treat as UTC if no timezone info present
    const normalized = str.includes('Z') || str.includes('+') ? str : str + 'Z'
    return new Date(normalized).getTime()
  }

  /**
   * Summarize an orphaned session that has already timed out, then close it.
   * Uses the lastActivity timestamp to write to the correct daily file.
   */
  private async summarizeAndCloseOrphanedSession(
    row: { id: string; started_at: string; message_count: number; summary_written: number; source: string; agent_id: string | null },
    userId: string,
    lastActivity: number,
    options: { reason?: 'server_restart' | 'parked_timeout' } = {},
  ): Promise<boolean> {
    const reason = options.reason ?? 'server_restart'
    const parked = reason === 'parked_timeout'
    let summary: string | null = null
    let summaryWritten = !!row.summary_written
    const startedAt = this.parseSqliteTimestamp(row.started_at)

    if (row.message_count > 0 && !summaryWritten && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(row.id)
        if (history) {
          summary = await this.onSummarize(row.id, userId, history)
          if (summary) {
            this.writeSummaryToDailyFile(summary, lastActivity, row.agent_id ?? 'main')
            summaryWritten = true
            console.log(`[session] Summary written for orphaned session ${row.id} (at ${new Date(lastActivity).toISOString()})`)
          }
        }
      } catch (err) {
        console.error(`[session] Failed to summarize orphaned session ${row.id}:`, err)
      }
    }

    // Summarizing is an LLM round-trip; the user may have re-entered this
    // thread meanwhile (activateSession puts it back into the slot). Closing it
    // now would kill a live conversation, so the sweep backs off instead.
    if (parked && this.isSessionInSlot(row.id)) {
      console.log(`[session] Parked sweep skipped ${row.id}: it was reactivated while summarizing`)
      return false
    }

    // Close session in DB. The session stopped being live at its last
    // activity, not at server-restart time — dating it `now` would sort the
    // divider after messages that were written days later.
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime(? / 1000, 'unixepoch'), summary_written = ? WHERE id = ?`
    ).run(lastActivity, summaryWritten ? 1 : 0, row.id)

    // Log to tool_calls for activity log visibility
    logToolCall(this.db, {
      sessionId: row.id,
      toolName: 'session_timeout',
      input: JSON.stringify({
        reason,
        messageCount: row.message_count,
      }),
      output: JSON.stringify({
        summaryWritten,
        summary,
        note: parked
          ? (summary ? 'Parked thread summarized and closed' : 'Parked thread closed after idle timeout')
          : (summary ? 'Orphaned session summarized on startup' : 'Session closed due to server restart'),
      }),
      durationMs: 0,
      status: 'success',
    })

    // Only fire onSessionEnd for sessions that actually had messages.
    // Empty orphaned sessions (message_count = 0) produce no useful divider
    // and would spam the chat history with blank "New Session" entries.
    if (row.message_count > 0 && this.onSessionEnd) {
      const ended: SessionInfo = {
        id: row.id,
        userId,
        source: row.source,
        startedAt,
        lastActivity,
        messageCount: row.message_count,
        summaryWritten,
        restored: true,
        agentId: row.agent_id ?? 'main',
      }
      // Keep the 2-argument call shape for the startup path: listeners (and
      // their tests) match on exactly those arguments.
      if (parked) this.onSessionEnd(ended, summary, { parked: true })
      else this.onSessionEnd(ended, summary)
    }

    return true
  }

  /**
   * Restore an orphaned session whose timeout has not yet elapsed.
   * Recreates the in-memory session and starts a timer with the remaining time.
   */
  private restoreSession(
    row: {
      id: string
      source: string
      started_at: string
      message_count: number
      summary_written: number
      agent_id: string | null
    },
    userId: string,
    lastActivity: number,
    remainingMs: number,
  ): void {
    const startedAt = this.parseSqliteTimestamp(row.started_at)
    const agentId = row.agent_id ?? 'main'
    const key = this.sessionKey(userId, agentId)

    const session: SessionInfo = {
      id: row.id,
      userId,
      source: row.source,
      startedAt,
      lastActivity,
      messageCount: row.message_count,
      summaryWritten: !!row.summary_written,
      restored: true,
      agentId,
    }

    this.sessions.set(key, session)

    // No-time-reset guarantee: when timeouts are disabled, restore without a
    // timer so the session never expires.
    if (this.timeoutMs <= 0) {
      console.log(`[session] Restored session ${row.id} for user ${userId} agent ${agentId} (no time-based expiry)`)
      return
    }

    const remainingMinutes = Math.round(remainingMs / 60000)
    console.log(`[session] Restored session ${row.id} for user ${userId} agent ${agentId} (${remainingMinutes}min remaining)`)

    // With threads a (user, agent) can have SEVERAL open interactive sessions
    // (parked ones keep `ended_at IS NULL`). Orphans are restored oldest-first,
    // so each new restore for the same key must retire the previous timer —
    // otherwise a stale timer fires later and ends whichever session happens to
    // occupy the slot at that moment.
    this.clearTimer(key)

    // Start timer with remaining time
    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for restored session of user ${userId} agent ${agentId}`)
      this.endSession(key).catch(err => {
        console.error(`[session] Timeout error for user ${userId} agent ${agentId}:`, err)
      })
    }, remainingMs)

    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  /**
   * Write a summary to the daily memory file at the given timestamp.
   *
   * RC5 (multi-persona bleeding): summaries of non-main persona sessions go
   * to the persona's own memory root (/data/agents/<id>/memory/daily/) when
   * scoped memory is enabled — NOT into main's shared daily files. Main and
   * legacy (scoping disabled) behavior is unchanged.
   */
  private writeSummaryToDailyFile(summary: string, timestamp: number, agentId?: string): void {
    const activityDate = new Date(timestamp)
    const hh = String(activityDate.getHours()).padStart(2, '0')
    const mm = String(activityDate.getMinutes()).padStart(2, '0')
    const formattedSummary = `\n## ${hh}:${mm}\n\n${summary}\n`
    const targetDir = resolveAgentMemoryDir(agentId, {
      fallbackMemoryDir: this.memoryDir,
      agentsBaseDir: this.agentsBaseDir,
      scopedAgentMemory: this.scopedAgentMemory,
    })
    appendToDailyFile(formattedSummary, activityDate, targetDir)
  }

  /**
   * Build a conversation history string from chat_messages in the DB.
   *
   * Includes:
   * - All messages in the given session
   * - All messages in descendant sessions (children, grandchildren, ...)
   *   linked via `sessions.parent_session_id`
   *
   * This subsumes the previous time-window heuristic for pulling in task
   * result notifications and task injection responses: those messages now
   * live in child/task sessions (or — when merged — in this session
   * directly via `processTaskInjection`).
   */
  buildConversationHistory(sessionId: string, options: BuildConversationHistoryOptions = {}): string | null {
    const messages = this.loadTranscriptRows(sessionId, options.includeDescendants ?? true)
    if (messages.length === 0) return null

    const digestable: DigestableMessage[] = []
    for (const msg of messages) {
      let metadata: Record<string, unknown> | null = null
      try {
        metadata = msg.metadata ? JSON.parse(msg.metadata) as Record<string, unknown> : null
      } catch {
        metadata = null
      }

      if (msg.role === 'user') {
        digestable.push({ id: msg.id, role: 'user', content: msg.content })
      } else if (msg.role === 'assistant') {
        const label = metadata?.type === 'task_injection_response' ? 'Assistant (task update)' : 'Assistant'
        digestable.push({ id: msg.id, role: 'assistant', content: msg.content, label })
      } else if (msg.role === 'system' && metadata?.type === 'task_result') {
        const taskStatus = typeof metadata.taskResultStatus === 'string'
          ? metadata.taskResultStatus
          : typeof metadata.taskStatus === 'string'
            ? metadata.taskStatus
            : 'completed'
        const taskName = typeof metadata.taskName === 'string' ? metadata.taskName.trim() : ''
        const taskLabel = taskName ? `: ${taskName}` : ''
        digestable.push({ id: msg.id, role: 'task', content: msg.content, label: `Background task (${taskStatus}${taskLabel})` })
      } else if (msg.role === 'tool' && options.includeToolResults) {
        // Tool rows carry the result in metadata; the digest line names the
        // tool and its size, recall_message returns the full result.
        const toolName = typeof metadata?.toolName === 'string' ? metadata.toolName : 'unknown'
        const result = metadata?.toolResult
        const resultText = typeof result === 'string' ? result : result == null ? '' : JSON.stringify(result)
        digestable.push({ id: msg.id, role: 'tool', content: `${toolName}: ${resultText}` })
      }
    }

    if (digestable.length === 0) return null

    // Observation masking (SPEC 11.1): oversized and old messages become
    // "[msg:<id>] ..." digest lines instead of being cut silently. The
    // summary and fact extraction models can reload any of them with
    // recall_message. Budgets default to the previous hard cuts (2000 chars
    // per assistant message, 12000 chars total) so the prompt size is
    // unchanged; what changes is that nothing is lost any more.
    const mask = maskTranscript(digestable, options.mask ?? DEFAULT_MASK_OPTIONS)
    return mask.text || null
  }

  /**
   * Load the chat_messages rows that make up a session transcript.
   *
   * With `includeDescendants` (the default, used by the session summary) the
   * recursive CTE follows `parent_session_id` so task, loop_detection and
   * other child sessions are part of the transcript. Fact extraction passes
   * `false` (SPEC 11.4 gate 1): only the interactive session's own messages
   * may produce durable facts.
   */
  private loadTranscriptRows(sessionId: string, includeDescendants: boolean): TranscriptRow[] {
    if (!includeDescendants) {
      return this.db.prepare(
        `SELECT id, session_id, role, content, metadata, timestamp
         FROM chat_messages
         WHERE session_id = ?
         ORDER BY timestamp ASC, id ASC`
      ).all(sessionId) as TranscriptRow[]
    }
    // Use UNION (distinct) so accidental cycles in parent_session_id cannot
    // recurse forever.
    return this.db.prepare(
      `WITH RECURSIVE session_tree(id) AS (
         SELECT ?
         UNION
         SELECT s.id FROM sessions s
         JOIN session_tree st ON s.parent_session_id = st.id
       )
       SELECT id, session_id, role, content, metadata, timestamp
       FROM chat_messages
       WHERE session_id IN (SELECT id FROM session_tree)
       ORDER BY timestamp ASC, id ASC`
    ).all(sessionId) as TranscriptRow[]
  }

  /**
   * Update the timeout duration (in minutes)
   */
  setTimeoutMinutes(minutes: number): void {
    this.timeoutMs = minutes * 60 * 1000
  }

  /**
   * Get or create an interactive session for a user. Always creates sessions
   * with `type='interactive'` — background session types (task, heartbeat,
   * consolidation, loop_detection) must use `createSession()` instead so they
   * are not cached per-user and do not occupy the interactive-session
   * lifecycle slot.
   */
  getOrCreateSession(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    return this.resolveSession(userId, source, undefined, agentId)
  }

  /**
   * Resolve the active interactive session for a (user, agent), running
   * topic-shift detection when `messageText` is supplied.
   *
   * - No active session → create a fresh one and (if messageText) inject facts.
   * - Active session + messageText + topic shift → end the current session
   *   (fire-and-forget summary) and start a fresh one with fact injection.
   * - Active session, no shift → continue it, refreshing topic tags + timer.
   *
   * ALWAYS creates a fresh session on shift (never reactivates an old one).
   */
  resolveSession(userId: string, source: string = 'web', messageText?: string, agentId: string = 'main'): SessionInfo {
    const key = this.sessionKey(userId, agentId)
    const existingSession = this.sessions.get(key)

    if (existingSession && messageText) {
      const history = getSessionMessages(this.db, existingSession.id)

      if (history.length > 0) {
        const newMsg: SessionMessage = {
          content: messageText,
          timestampMs: Date.now(),
          tokens: estimateTokens(messageText),
          hasAttachment: hasAttachmentMarker(messageText),
        }

        const result = detectTopicShift(history, newMsg)

        if (result.shiftDetected) {
          console.log(`[session] Topic shift detected for user ${userId} agent ${agentId} (score=${result.score}, signals=${JSON.stringify(result.signals)})`)

          // End current session (fire-and-forget the summary)
          this.endSession(key, 'topic_shift').catch(err => {
            console.error(`[session] Error ending session on topic shift:`, err)
          })

          // Create fresh session and inject facts
          const newSession = this.createFreshSession(userId, source, agentId)
          this.injectFacts(key, messageText, agentId)
          return newSession
        }
      }

      // No shift — update topic tags incrementally and continue
      const newTags = extractTopicTags([messageText])
      existingSession.topicTags = mergeTopicTags(existingSession.topicTags ?? [], newTags)
      existingSession.lastActivity = Date.now()
      this.resetTimer(key)
      return existingSession
    }

    if (existingSession) {
      // No message text — just continue the existing session
      existingSession.lastActivity = Date.now()
      this.resetTimer(key)
      return existingSession
    }

    // No active session — create a new one and inject facts
    const session = this.createFreshSession(userId, source, agentId)
    if (messageText) {
      this.injectFacts(key, messageText, agentId)
    }
    return session
  }

  /**
   * Create a fresh interactive session for a (user, agent) and cache it.
   */
  private createFreshSession(userId: string, source: string, agentId: string = 'main'): SessionInfo {
    const id = generateSessionId()
    const key = this.sessionKey(userId, agentId)

    // Carry a verbatim tail of the previous session (if recent) into the
    // first prompt of this one — consumed via consumeFactInjection.
    this.prepareSessionTail(key, userId, agentId)

    const session: SessionInfo = {
      id,
      userId,
      source,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0,
      summaryWritten: false,
      restored: false,
      agentId,
    }
    this.sessions.set(key, session)

    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written, agent_id)
       VALUES (?, ?, ?, 'interactive', NULL, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0, ?)`
    ).run(session.id, null, source, session.startedAt, session.lastActivity, userId, agentId)

    logToolCall(this.db, {
      sessionId: session.id,
      toolName: 'session_start',
      input: JSON.stringify({ userId, source, agentId }),
      output: JSON.stringify({ sessionId: session.id }),
      durationMs: 0,
      status: 'success',
    })

    // No resetTimer here: every interactive entry point calls recordMessage
    // (which resets the timer) right after session resolution — resetting
    // here too double-arms the timer for every first message (regression
    // guarded by session-manager.test "sets the inactivity timer exactly
    // once per incoming user message").
    return session
  }

  /**
   * Query memories FTS5 for relevant facts based on message text and store
   * the injection for the next response (consumed via consumeFactInjection).
   */
  private injectFacts(key: string, messageText: string, agentId?: string): void {
    try {
      const keywords = extractTopicTags([messageText])
      if (keywords.length === 0) return

      const facts = queryMemoriesFts(this.db, keywords, loadHeuristics().factInjection.limit, agentId)
      if (facts.length === 0) return

      const injection = buildFactInjection(facts)
      this.pendingFactInjection.set(key, injection)

      const session = this.sessions.get(key)
      if (session && this.onTopicShift) {
        this.onTopicShift(session, injection)
      }

      console.log(`[session] Injected ${facts.length} facts for key ${key} (keywords: ${keywords.join(', ')})`)
    } catch (err) {
      console.error('[session] Fact injection error:', err)
    }
  }

  /**
   * Store a compact verbatim tail of the user's PREVIOUS interactive session
   * so the fresh session doesn't start with hard amnesia. Only when the
   * previous session was recently active (stale tails are noise).
   */
  private prepareSessionTail(key: string, userId: string, agentId: string): void {
    try {
      const prev = this.db.prepare(
        `SELECT id, last_activity FROM sessions
         WHERE session_user = ? AND agent_id = ? AND type = 'interactive'
         ORDER BY started_at DESC LIMIT 1`
      ).get(userId, agentId) as { id: string; last_activity: string | null } | undefined
      if (!prev) return

      // Freshness window: 12h. `last_activity` is stored as UTC datetime text.
      if (prev.last_activity) {
        const lastMs = new Date(prev.last_activity.replace(' ', 'T') + 'Z').getTime()
        if (Number.isFinite(lastMs) && Date.now() - lastMs > loadHeuristics().sessionTail.freshnessHours * 3600_000) return
      }

      const tail = this.buildSessionTail(prev.id)
      if (tail) this.pendingSessionTail.set(key, tail)
    } catch (err) {
      console.error('[session] Session-tail carryover error:', err)
    }
  }

  /**
   * Build the verbatim tail (last 5 user/assistant messages) of a session.
   * Returns null when the session has no usable messages.
   */
  private buildSessionTail(sessionId: string): string | null {
    const rows = this.db.prepare(
      `SELECT role, content FROM chat_messages
       WHERE session_id = ? AND role IN ('user','assistant') AND content != ''
       ORDER BY id DESC LIMIT ?`
    ).all(sessionId, loadHeuristics().sessionTail.messages) as Array<{ role: string; content: string }>
    if (rows.length === 0) return null

    const lines = rows
      .map((row) => {
        const text = row.content.length > 400 ? `${row.content.slice(0, 400)}…` : row.content
        return `${row.role === 'user' ? 'User' : 'You'}: ${text}`
      })
      .reverse()

    return [
      '<previous_session_tail>',
      `${RECALLED_MARKER} Last messages of the previous session (a summary of it is in your memory). Use this only to resolve references — the user may have moved on to a new topic:`,
      ...lines.map(line => `${RECALLED_MARKER} ${line}`),
      '</previous_session_tail>',
    ].join('\n')
  }

  /**
   * Consume and clear any pending injection (previous-session tail and/or
   * fact injection) for a (user, agent).
   */
  consumeFactInjection(userId: string, agentId: string = 'main'): string | null {
    const key = this.sessionKey(userId, agentId)
    const parts: string[] = []
    const tail = this.pendingSessionTail.get(key)
    if (tail) {
      this.pendingSessionTail.delete(key)
      parts.push(tail)
    }
    const injection = this.pendingFactInjection.get(key)
    if (injection) {
      this.pendingFactInjection.delete(key)
      parts.push(injection)
    }
    return parts.length > 0 ? parts.join('\n\n') : null
  }

  /**
   * Create a non-interactive session (task, heartbeat, consolidation,
   * loop_detection). Unlike `getOrCreateSession`, this does NOT cache the
   * session per-user and does NOT start an inactivity timer — background
   * sessions are owned and closed by their producers.
   */
  createSession(options: CreateSessionOptions): SessionInfo {
    const id = generateSessionId()
    const now = Date.now()
    const agentId = options.agentId ?? 'main'
    const session: SessionInfo = {
      id,
      userId: options.userId ?? 'system',
      source: options.source,
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
      summaryWritten: false,
      restored: false,
      agentId,
    }

    this.db.prepare(
      `INSERT INTO sessions (id, user_id, source, type, parent_session_id, started_at, last_activity, session_user, message_count, summary_written, agent_id)
       VALUES (?, NULL, ?, ?, ?, datetime(? / 1000, 'unixepoch'), datetime(? / 1000, 'unixepoch'), ?, 0, 0, ?)`
    ).run(
      id,
      options.source,
      options.type,
      options.parentSessionId ?? null,
      now,
      now,
      options.userId ?? null,
      agentId,
    )

    return session
  }

  /**
   * Record a message in the active session
   */
  recordMessage(userId: string, agentId: string = 'main'): void {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (session) {
      session.messageCount++
      session.lastActivity = Date.now()
      this.resetTimer(key)

      // Update SQLite (message count and last activity)
      this.db.prepare(
        `UPDATE sessions SET message_count = ?, last_activity = datetime(? / 1000, 'unixepoch') WHERE id = ?`
      ).run(session.messageCount, session.lastActivity, session.id)
    }
  }

  /**
   * Get the active session for a (user, agent) (without creating one)
   */
  getSession(userId: string, agentId: string = 'main'): SessionInfo | undefined {
    return this.sessions.get(this.sessionKey(userId, agentId))
  }

  /**
   * Check if a (user, agent) has an active session
   */
  hasActiveSession(userId: string, agentId: string = 'main'): boolean {
    return this.sessions.has(this.sessionKey(userId, agentId))
  }

  /**
   * Handle /new command: immediately summarize and reset (blocking).
   *
   * The returned Promise resolves only AFTER the summary has been
   * generated and persisted. Prefer `handleNewCommandAsync()` for
   * interactive UIs where blocking on summary generation is
   * user-visible.
   */
  async handleNewCommand(userId: string, agentId: string = 'main'): Promise<string | null> {
    const key = this.sessionKey(userId, agentId)
    const session = this.sessions.get(key)
    if (!session) {
      return null
    }

    return this.endSession(key, 'manual')
  }

  /**
   * Non-blocking variant of `handleNewCommand`. Detaches the current
   * interactive session synchronously (clears the timer + removes it
   * from the active-session map + clears in-memory agent state via the
   * onSessionEnd callback in the next tick), creates a fresh session
   * for the user, and returns it immediately.
   *
   * Summary generation and persistence (daily log + DB UPDATE + tool
   * call log + onSessionEnd callback) run in the background. When the
   * summary is ready, `onSessionEnd` fires with `options.background = true`
   * so the listener can deliver the summary as a follow-up event without
   * duplicating the divider that was already rendered when the new
   * session was opened.
   */
  // Used by the websocket chat /new command handler for instant session switch.
  handleNewCommandAsync(userId: string, source: string = 'web', agentId: string = 'main'): SessionInfo {
    const key = this.sessionKey(userId, agentId)
    const oldSession = this.sessions.get(key)
    // Snapshot the OLD session's id as a primitive *before* we mint the new
    // one, so every downstream write (daily-log, chat_messages divider,
    // tool_calls row, onSessionEnd callback) is unambiguously bound to the
    // session the user just left — never to the freshly-created session
    // that replaces it. The previous code threaded the captured object
    // reference through, but it's easier to reason about (and impossible
    // to accidentally re-resolve via `this.sessions.get(userId)` at
    // callback time) when the id is also passed explicitly.
    const oldSessionId = oldSession?.id
    // The session ends HERE, not when the background summary resolves
    // seconds later. Everything derived from the end time (sessions.ended_at
    // and, through it, the divider row's position in the chat history) must
    // use this timestamp, otherwise the divider sorts after the messages the
    // user already sent in the new session.
    const endedAt = Date.now()

    if (oldSession && oldSessionId) {
      this.clearTimer(key)
      this.sessions.delete(key)

      // Defer the finalize one microtask so that `onSessionEnd` (and any
      // resulting broadcast) NEVER fires on the synchronous stack of this
      // call. The short-session placeholder branch has no `await` before
      // `onSessionEnd`, so without this it would fire synchronously here —
      // before the caller (ws-chat) has had a chance to emit the immediate
      // `session_end`, causing the late `session_summary` to overtake it and
      // render a duplicate divider on the originating client.
      const job = Promise.resolve().then(() => this.finalizeDetachedSession(
        oldSession,
        oldSessionId,
        userId,
        'manual',
        endedAt,
      )).catch((err) => {
        console.error(
          `[session] Background finalize failed for session ${oldSessionId}:`,
          err,
        )
      })
      this.backgroundJobs.add(job)
      job.finally(() => {
        this.backgroundJobs.delete(job)
      })
    }

    return this.getOrCreateSession(userId, source, agentId)
  }

  /**
   * Run the summary-and-persist tail of a session that has already been
   * detached from `this.sessions` (timer cleared, map entry removed).
   * Mirrors `endSession`'s tail but is callable without holding the
   * session in the active map.
   */
  private async finalizeDetachedSession(
    session: SessionInfo,
    oldSessionId: string,
    userId: string,
    reason: SessionEndReason,
    endedAt: number,
  ): Promise<void> {
    // `oldSessionId` is the primitive id captured at trigger time in
    // `handleNewCommandAsync` (or wherever this method is called from).
    // We deliberately do NOT re-resolve the session via
    // `this.sessions.get(userId)` here — by the time the awaited summary
    // resolves, the user is already chatting in a new session under that
    // map key, and writing the divider / daily-log entry against the
    // current session would clobber the new session instead of the one
    // that actually ended.
    console.log(
      `[session] Finalizing detached session ${oldSessionId} for user ${userId} `
      + `(${session.messageCount} messages, background)`,
    )

    let summary: string | null = null

    if (
      session.messageCount > 0
      && session.messageCount < SessionManager.MIN_MESSAGES_FOR_SUMMARY
    ) {
      // Ping/pong session (typically 2 messages: one user turn + one
      // assistant reply). Calling the summarizer for this just produces
      // "Empty session." — wasting an LLM round-trip and cluttering the
      // daily activity log. Substitute an em-dash placeholder so the
      // divider still renders in place of the old session, but don't
      // write a daily-log entry.
      summary = SessionManager.SHORT_SESSION_PLACEHOLDER
      console.log(
        `[session] Skipping summary for short session ${oldSessionId} `
        + `(${session.messageCount} < ${SessionManager.MIN_MESSAGES_FOR_SUMMARY} messages); `
        + `using placeholder divider`,
      )
    } else if (session.messageCount > 0 && this.onSummarize) {
      try {
        const history = this.buildConversationHistory(oldSessionId) ?? undefined
        summary = await this.onSummarize(oldSessionId, userId, history)
        if (summary) {
          this.writeSummaryToDailyFile(summary, session.lastActivity, session.agentId)
          session.summaryWritten = true
          console.log(
            `[session] Background summary written to daily log for session ${oldSessionId}`,
          )
        }
      } catch (err) {
        console.error('[session] Failed to generate background session summary:', err)
      }
    } else {
      console.log(
        `[session] Skipping background summary: messageCount=${session.messageCount}, `
        + `onSummarize=${!!this.onSummarize}`,
      )
    }

    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime(? / 1000, 'unixepoch'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(endedAt, session.messageCount, session.summaryWritten ? 1 : 0, oldSessionId)

    const durationMs = endedAt - session.startedAt
    logToolCall(this.db, {
      sessionId: oldSessionId,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId,
        reason,
        messageCount: session.messageCount,
        durationMinutes: Math.round(durationMs / 60000),
        background: true,
      }),
      output: JSON.stringify({
        summaryWritten: session.summaryWritten,
        summary: summary ?? null,
      }),
      durationMs,
      status: 'success',
    })

    if (this.onSessionEnd) {
      // Defensive: ensure the session object handed to the callback
      // carries the captured old id, in case anything later in the
      // callback chain reads `session.id` instead of the explicit
      // sessionId argument. The captured object reference IS already
      // the old session, but pinning the id here makes the intent
      // impossible to misread.
      const endedSession: SessionInfo = session.id === oldSessionId
        ? session
        : { ...session, id: oldSessionId }
      this.onSessionEnd(endedSession, summary, { background: true })
    }
  }

  /**
   * Await all in-flight background summary jobs. Useful for tests that
   * need to deterministically observe the post-summary state after
   * calling `handleNewCommandAsync`.
   */
  async awaitBackgroundJobs(): Promise<void> {
    if (this.backgroundJobs.size === 0) return
    await Promise.allSettled(Array.from(this.backgroundJobs))
  }

  /**
   * End a session: summarize and dispose.
   * Always uses session.lastActivity as the timestamp for the daily file entry.
   */
  private async endSession(key: string, reason: SessionEndReason = 'timeout'): Promise<string | null> {
    const session = this.sessions.get(key)
    if (!session) {
      console.log(`[session] endSession called for key ${key} but no active session found`)
      return null
    }
    const userId = session.userId

    console.log(`[session] Ending session ${session.id} for user ${userId} agent ${session.agentId} (${session.messageCount} messages)`)

    // Captured before the (slow) summarizer call — see `handleNewCommandAsync`.
    const endedAt = Date.now()

    // Clear the timeout timer
    this.clearTimer(key)

    let summary: string | null = null

    // Generate summary if there were messages and a summarizer is configured
    if (session.messageCount > 0 && this.onSummarize) {
      try {
        // Build conversation history from DB (single source of truth).
        // In-memory agent messages are unreliable (lost on provider change, restart, etc.)
        const history = this.buildConversationHistory(session.id) ?? undefined

        summary = await this.onSummarize(session.id, userId, history)
        if (summary) {
          this.writeSummaryToDailyFile(summary, session.lastActivity, session.agentId)
          session.summaryWritten = true
          console.log(`[session] Summary written to daily log for session ${session.id}`)
        }
      } catch (err) {
        console.error('[session] Failed to generate session summary:', err)
      }
    } else {
      console.log(`[session] Skipping summary: messageCount=${session.messageCount}, onSummarize=${!!this.onSummarize}`)
    }

    // Update SQLite with end time and summary flag
    this.db.prepare(
      `UPDATE sessions SET ended_at = datetime(? / 1000, 'unixepoch'), message_count = ?, summary_written = ? WHERE id = ?`
    ).run(endedAt, session.messageCount, session.summaryWritten ? 1 : 0, session.id)

    // Log session end to tool_calls for activity log visibility
    const durationMs = endedAt - session.startedAt
    logToolCall(this.db, {
      sessionId: session.id,
      toolName: reason === 'timeout' ? 'session_timeout' : 'session_end',
      input: JSON.stringify({
        userId,
        reason,
        messageCount: session.messageCount,
        durationMinutes: Math.round(durationMs / 60000),
      }),
      output: JSON.stringify({
        summaryWritten: session.summaryWritten,
        summary: summary ?? null,
      }),
      durationMs,
      status: 'success',
    })

    // Notify listener
    if (this.onSessionEnd) {
      this.onSessionEnd(session, summary)
    }

    // Remove from active sessions — but ONLY if the map still holds THIS
    // session. On topic shift, endSession runs fire-and-forget while
    // createFreshSession has already put the NEW session under the same
    // key; an unconditional delete would evict the fresh session once the
    // (slow) summary finally lands.
    if (this.sessions.get(key) === session) {
      this.sessions.delete(key)
    }

    return summary
  }

  /**
   * End all active sessions.
   */
  async endAllSessions(reason: Exclude<SessionEndReason, 'timeout'> = 'manual'): Promise<void> {
    const keys = Array.from(this.sessions.keys())
    for (const key of keys) {
      await this.endSession(key, reason)
    }
  }

  /**
   * Reset the inactivity timer for a session (keyed by userId:agentId).
   */
  private resetTimer(key: string): void {
    this.clearTimer(key)

    if (this.timeoutMs <= 0) return

    const timeoutMinutes = Math.round(this.timeoutMs / 60000)
    console.log(`[session] Timer set for ${key}: ${timeoutMinutes}min (${this.timeoutMs}ms)`)

    const timer = setTimeout(() => {
      console.log(`[session] Timeout fired for ${key} — ending session`)
      this.endSession(key).catch(err => {
        console.error(`[session] Timeout error for ${key}:`, err)
      })
    }, this.timeoutMs)

    // Unref so it doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) {
      timer.unref()
    }

    this.timers.set(key, timer)
  }

  /**
   * Clear the timeout timer for a session (keyed by userId:agentId).
   */
  private clearTimer(key: string): void {
    const existing = this.timers.get(key)
    if (existing) {
      clearTimeout(existing)
      this.timers.delete(key)
    }
  }

  /**
   * Dispose all sessions and timers (for shutdown). Drains any
   * fire-and-forget background summary jobs first so daily-log writes
   * and DB updates settle before we tear down.
   */
  async dispose(): Promise<void> {
    if (this.parkedSweepTimer) {
      clearInterval(this.parkedSweepTimer)
      this.parkedSweepTimer = undefined
    }

    for (const [key] of this.timers) {
      this.clearTimer(key)
    }

    if (this.backgroundJobs.size > 0) {
      await Promise.allSettled(Array.from(this.backgroundJobs))
    }

    // End all active sessions without summarizing
    for (const [, session] of this.sessions) {
      this.db.prepare(
        `UPDATE sessions SET ended_at = datetime('now'), message_count = ?, summary_written = ? WHERE id = ?`
      ).run(session.messageCount, session.summaryWritten ? 1 : 0, session.id)
    }

    this.sessions.clear()
    this.timers.clear()
  }

  // ---------------------------------------------------------------------
  // Threads (Offtangent Stufe 1): named, explicitly selectable interactive
  // sessions. Only `type = 'interactive'` rows are threads; background
  // sessions (task, heartbeat, ...) are never listed or activatable.
  // ---------------------------------------------------------------------

  /**
   * List a user's threads: pinned first, then newest activity first.
   *
   * The inbox pins rows to the top client-side as well; sorting server-side
   * keeps that order stable across pagination (`limit`/`offset`), where the
   * client only ever sees one page and could not pull a pinned thread up from
   * page 2.
   *
   * `agentId` restricts to one persona, `includeArchived` adds archived rows
   * (hidden by default). `lastMessage` is the newest user/assistant row of the
   * thread, truncated to 200 characters.
   */
  listThreads(userId: string, options: ListThreadsOptions = {}): Thread[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)))
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))

    const where: string[] = ["type = 'interactive'", '(session_user = ? OR CAST(user_id AS TEXT) = ?)']
    const params: unknown[] = [userId, userId]
    if (options.agentId) {
      where.push('agent_id = ?')
      params.push(options.agentId)
    }
    if (!options.includeArchived) {
      where.push('archived = 0')
    }
    // `undefined` = every thread; `null` = only ungrouped ones ('none').
    if (options.projectId === null) {
      where.push('project_id IS NULL')
    } else if (options.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(options.projectId)
    }
    // Tag and now set filters resolve to id lists first; an empty list
    // matches nothing (no existence oracle for foreign tags).
    let idFilter: string[] | null = null
    if (options.tag !== undefined) {
      idFilter = strandIdsWithTag(this.db, userId, options.tag)
    }
    if (options.nowOnly) {
      const now = getNowSet(this.db, userId)
      idFilter = idFilter ? idFilter.filter(id => now.includes(id)) : now
    }
    if (options.ids) {
      const wanted = options.ids
      idFilter = idFilter ? idFilter.filter(id => wanted.includes(id)) : [...wanted]
    }
    if (idFilter) {
      if (idFilter.length === 0) return []
      where.push(`id IN (${idFilter.map(() => '?').join(', ')})`)
      params.push(...idFilter)
    }

    const rows = this.db.prepare(
      `SELECT ${THREAD_COLUMNS}
       FROM sessions
       WHERE ${where.join(' AND ')}
       ORDER BY pinned DESC, COALESCE(last_activity, started_at) DESC, started_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as ThreadRow[]

    const threads = rows.map(row => this.toThread(userId, row))
    if (options.nowOnly) threads.sort((a, b) => (a.nowRank ?? 99) - (b.nowRank ?? 99))
    return threads
  }

  /**
   * Create a new (empty) thread for a persona. The thread is registered in the
   * `sessions` table but is deliberately NOT placed into the (user, agent)
   * session slot — it becomes active on the first message that names it.
   */
  createThread(
    userId: string,
    agentId: string = 'main',
    title?: string | null,
    projectId?: string | null,
  ): Thread {
    // Validate the project BEFORE creating the row: a refused assignment must
    // not leave an orphan thread behind.
    const resolvedProjectId = resolveAssignableProjectId(this.db, userId, projectId)
    // Threads are interactive sessions; `createSession` is used (not
    // `getOrCreateSession`) precisely because it does NOT cache the session
    // per user and does not start an inactivity timer.
    const session = this.createSession({ type: 'interactive', source: 'web', userId, agentId })
    const normalizedTitle = normalizeThreadTitle(title)
    if (normalizedTitle !== null) {
      this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(normalizedTitle, session.id)
    }
    if (resolvedProjectId !== null) {
      this.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(resolvedProjectId, session.id)
    }
    const thread = this.getThread(userId, session.id)
    if (!thread) throw new Error(`[session] Thread ${session.id} vanished right after creation`)
    return thread
  }

  /**
   * Give a titleless interactive strand a title derived from the message that
   * starts the turn. Without this, every strand that a plain chat turn opens
   * (no router, no explicit thread) stays untitled forever: unreadable in the
   * list and, worse, a blank candidate the router can only guess about.
   * Idempotent and write-once: an existing title is never overwritten, so no
   * later message can rename a strand behind the user's back.
   */
  ensureThreadTitle(sessionId: string, firstMessage: string): void {
    const title = deriveStrandTitle(firstMessage)
    if (!title) return
    this.db.prepare(
      `UPDATE sessions SET title = ?
       WHERE id = ? AND type = 'interactive' AND (title IS NULL OR TRIM(title) = '')`,
    ).run(title, sessionId)
  }

  /**
   * Read one thread. Returns `null` when the id is unknown, not interactive,
   * or owned by another user (callers answer 404 for all three).
   */
  getThread(userId: string, sessionId: string): Thread | null {
    const row = this.db.prepare(
      `SELECT ${THREAD_COLUMNS}
       FROM sessions
       WHERE id = ? AND type = 'interactive' AND (session_user = ? OR CAST(user_id AS TEXT) = ?)`
    ).get(sessionId, userId, userId) as ThreadRow | undefined
    return row ? this.toThread(userId, row) : null
  }

  /**
   * Rename / pin / archive / (re)group a thread. Returns the updated thread,
   * or `null` when it does not exist or belongs to someone else (404 at the
   * route). Omitted fields are left untouched. An unusable `projectId` throws
   * {@link ProjectNotFoundError} (400) instead of silently detaching.
   */
  updateThread(userId: string, sessionId: string, patch: UpdateThreadPatch): Thread | null {
    const existing = this.getThread(userId, sessionId)
    if (!existing) return null

    const sets: string[] = []
    const params: unknown[] = []
    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(normalizeThreadTitle(patch.title))
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(patch.pinned ? 1 : 0)
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?')
      params.push(patch.archived ? 1 : 0)
    }
    if (patch.projectId !== undefined) {
      // Throws ProjectNotFoundError for unknown/foreign/archived projects,
      // before anything is written.
      sets.push('project_id = ?')
      params.push(resolveAssignableProjectId(this.db, userId, patch.projectId))
      // The user just answered the question the proposal asked. Keeping the
      // row would make a stale chip pop back up the moment they detach the
      // project again.
      clearStrandProjectSuggestion(this.db, sessionId)
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params, sessionId)
    }

    // Archiving the thread that occupies the slot parks it, otherwise the
    // heuristic (legacy) path would keep appending to an archived thread and
    // the list would show it as active AND archived.
    if (patch.archived === true) {
      const key = this.sessionKey(userId, existing.agentId)
      if (this.sessions.get(key)?.id === sessionId) {
        this.clearTimer(key)
        this.sessions.delete(key)
        console.log(`[session] Parked session ${sessionId} for user ${userId} agent ${existing.agentId} (archived)`)
      }
    }

    return this.getThread(userId, sessionId)
  }

  /**
   * Delete a thread. Only EMPTY threads (no messages) can be deleted — a
   * thread with content is archived, never destroyed, so its history and the
   * daily-log summaries stay consistent.
   *
   * Returns:
   *   'not_found'  unknown id, not interactive, or owned by another user
   *   'not_empty'  the thread carries messages (route answers 409)
   *   'deleted'    the row is gone; if it held the (user, agent) slot, the
   *                slot and its timer are cleared too
   */
  deleteThread(userId: string, sessionId: string): 'not_found' | 'not_empty' | 'deleted' {
    const thread = this.getThread(userId, sessionId)
    if (!thread) return 'not_found'

    // `message_count` is the counter SessionManager maintains; chat_messages is
    // the actual content (a divider row can exist without a counted message).
    // Both must be empty, otherwise deleting would orphan rows.
    const stored = this.db.prepare(
      'SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?'
    ).get(sessionId) as { count: number }
    if (thread.messageCount > 0 || stored.count > 0) return 'not_empty'

    this.releaseSessionSlot(userId, thread.agentId, sessionId)

    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return 'deleted'
  }

  /**
   * Forget the in-memory state of a session that is about to be deleted
   * (SPEC 7.5b): the (user, agent) slot, its inactivity timer and the queued
   * tail/fact injections. Without this the next turn of that persona would
   * still hold the deleted session and write its id back into `sessions`.
   *
   * Returns true when the session actually held the slot.
   */
  releaseSessionSlot(userId: string, agentId: string, sessionId: string): boolean {
    const key = this.sessionKey(userId, agentId)
    if (this.sessions.get(key)?.id !== sessionId) return false
    this.clearTimer(key)
    this.sessions.delete(key)
    this.pendingSessionTail.delete(key)
    this.pendingFactInjection.delete(key)
    console.log(`[session] Released slot of deleted thread ${sessionId} (user ${userId}, agent ${agentId})`)
    return true
  }

  /**
   * Make an existing thread the active session of (user, agent).
   *
   * Explicit selection beats every heuristic: no topic-shift detection runs
   * for the activated session. Guards (in order): the session must exist and
   * be interactive, belong to this user, belong to this persona, and must not
   * be archived. Each failure throws a typed error whose `code` is the wire
   * code the transports send.
   *
   * A session that had already ended is reopened (`ended_at = NULL`); its
   * summary stays written. Because a reopened thread has no in-memory
   * transcript left, it gets the same injection treatment as a fresh session
   * (relevant facts + a verbatim tail of its own last messages).
   *
   * A DIFFERENT session occupying the slot is NOT ended — it is only parked:
   * its inactivity timer is cleared (so it cannot time out while nobody talks
   * in it) and AgentCore keeps its transcript. It becomes active again the
   * next time it is named.
   */
  /**
   * Guards of an explicit thread selection, WITHOUT side effects: the session
   * must exist and be interactive, belong to this user, belong to this
   * persona, and must not be archived. Transports call this before they
   * persist anything; the activation itself (which parks the incumbent) is
   * done inside the serialized turn, so a message queued behind a running
   * turn can never park the thread that turn is still working in.
   */
  assertSessionAccess(userId: string, sessionId: string, agentId: string = 'main'): ThreadAccessRow {
    const row = this.db.prepare(
      `SELECT id, user_id, session_user, source, type, started_at, last_activity, ended_at,
              message_count, summary_written, agent_id, archived
       FROM sessions WHERE id = ?`
    ).get(sessionId) as ThreadAccessRow | undefined

    if (!row || row.type !== 'interactive') {
      throw new SessionNotFoundError(`Session ${sessionId} is not an interactive session`)
    }
    // Same owner rule as listThreads/getThread (either column may carry the
    // user), so a thread the list shows can never be refused here.
    const owned = row.session_user === userId || (row.user_id != null && String(row.user_id) === userId)
    if (!owned) {
      throw new SessionForbiddenError(`Session ${sessionId} belongs to another user`)
    }
    if ((row.agent_id ?? 'main') !== agentId) {
      throw new SessionAgentMismatchError(
        `Session ${sessionId} belongs to persona '${row.agent_id ?? 'main'}', not '${agentId}'`,
      )
    }
    if (row.archived) {
      throw new SessionForbiddenError(`Session ${sessionId} is archived`)
    }
    return row
  }

  /**
   * Make an existing thread the active session of (user, agent).
   *
   * Explicit selection beats every heuristic: no topic-shift detection runs
   * for the activated session. Guards: see {@link assertSessionAccess}.
   *
   * A session that had already ended is reopened (`ended_at = NULL`); its
   * summary stays written.
   *
   * Continuity: a thread whose model transcript is NOT loaded (reopened,
   * parked before a restart, evicted from the transcript cache) starts with
   * an empty context, so it gets the same injection treatment as a fresh
   * session: a verbatim tail of its OWN last messages plus facts matching the
   * incoming message. Callers that hold the transcript say so via
   * `options.hasTranscript` (AgentCore); when the option is absent only a
   * reopen counts as cold.
   *
   * A DIFFERENT session occupying the slot is NOT ended — it is only parked:
   * its inactivity timer is cleared (so it cannot time out while nobody talks
   * in it) and AgentCore keeps its transcript. It becomes active again the
   * next time it is named.
   */
  activateSession(
    userId: string,
    sessionId: string,
    agentId: string = 'main',
    options: { messageText?: string; hasTranscript?: boolean } = {},
  ): SessionInfo {
    const row = this.assertSessionAccess(userId, sessionId, agentId)

    const key = this.sessionKey(userId, agentId)
    const current = this.sessions.get(key)
    const reopened = row.ended_at !== null
    const cold = options.hasTranscript === undefined ? reopened : !options.hasTranscript

    if (current && current.id === sessionId) {
      // Already active — keep it alive. Still cold after a restart (the slot
      // was restored from the DB, the transcript was not), so inject then.
      current.lastActivity = Date.now()
      this.resetTimer(key)
      if (cold) this.injectThreadContinuity(key, sessionId, agentId, options.messageText)
      return current
    }

    if (current) {
      // Park the incumbent: no summary, no ended_at, no transcript loss — but
      // no timer either, so a parked thread is never closed by a timeout it
      // cannot refresh. Its pending injection (if any) must not leak into the
      // thread we are switching to.
      this.clearTimer(key)
      this.sessions.delete(key)
      this.pendingSessionTail.delete(key)
      this.pendingFactInjection.delete(key)
      console.log(`[session] Parked session ${current.id} for user ${userId} agent ${agentId} (explicit switch to ${sessionId})`)
    }

    if (reopened) {
      this.db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(sessionId)
      console.log(`[session] Reopened ended session ${sessionId} for user ${userId} agent ${agentId}`)
    }

    const session: SessionInfo = {
      id: row.id,
      userId,
      source: row.source,
      startedAt: this.parseSqliteTimestamp(row.started_at),
      lastActivity: Date.now(),
      messageCount: row.message_count,
      summaryWritten: !!row.summary_written,
      // Same meaning as after a server restart: the in-memory transcript of
      // this session may be gone, the DB row is the truth.
      restored: true,
      agentId,
    }
    this.sessions.set(key, session)
    this.resetTimer(key)

    if (cold) this.injectThreadContinuity(key, sessionId, agentId, options.messageText)

    return session
  }

  /**
   * Queue the continuity injection for a thread that starts without a model
   * transcript: the verbatim tail of THIS thread (not of the most recent one,
   * as for fresh sessions) plus facts matching the incoming message. Consumed
   * by the next turn via consumeFactInjection().
   */
  private injectThreadContinuity(key: string, sessionId: string, agentId: string, messageText?: string): void {
    const tail = this.buildSessionTail(sessionId)
    if (tail) this.pendingSessionTail.set(key, tail)
    if (messageText) this.injectFacts(key, messageText, agentId)
  }

  /** Map a `sessions` row onto the `Thread` wire shape. */
  private toThread(userId: string, row: ThreadRow): Thread {
    const last = this.db.prepare(
      `SELECT role, content, timestamp FROM chat_messages
       WHERE session_id = ? AND role IN ('user','assistant')
       ORDER BY id DESC LIMIT 1`
    ).get(row.id) as { role: string; content: string; timestamp: string } | undefined

    const agentId = row.agent_id ?? 'main'
    return {
      id: row.id,
      agentId,
      title: row.title ?? null,
      pinned: !!row.pinned,
      archived: !!row.archived,
      startedAt: toIsoUtc(row.started_at),
      lastActivity: toIsoUtc(row.last_activity ?? row.started_at),
      endedAt: row.ended_at ? toIsoUtc(row.ended_at) : null,
      messageCount: row.message_count,
      projectId: row.project_id ?? null,
      projectSuggestion: row.project_id ? null : getStrandProjectSuggestion(this.db, row.id),
      tags: getStrandTags(this.db, row.id),
      nowRank: getNowRank(this.db, userId, row.id),
      links: countStrandLinks(this.db, row.id),
      lastMessage: last
        ? {
          role: last.role === 'user' ? 'user' : 'assistant',
          content: last.content.length > THREAD_PREVIEW_LENGTH
            ? last.content.slice(0, THREAD_PREVIEW_LENGTH)
            : last.content,
          timestamp: toIsoUtc(last.timestamp),
        }
        : null,
      active: this.sessions.get(this.sessionKey(userId, agentId))?.id === row.id,
    }
  }

  /**
   * Get session metadata from SQLite
   */
  getSessionMetadata(sessionId: string): {
    id: string
    started_at: string
    ended_at: string | null
    message_count: number
    summary_written: number
    source: string
    type: string
    parent_session_id: string | null
    last_activity: string | null
    session_user: string | null
    prompt_tokens: number
    completion_tokens: number
    cache_read: number
    cache_write: number
  } | undefined {
    return this.db.prepare(
      `SELECT id, started_at, ended_at, message_count, summary_written, source, type, parent_session_id, last_activity, session_user, prompt_tokens, completion_tokens, cache_read, cache_write
       FROM sessions WHERE id = ?`
    ).get(sessionId) as {
      id: string
      started_at: string
      ended_at: string | null
      message_count: number
      summary_written: number
      source: string
      type: string
      parent_session_id: string | null
      last_activity: string | null
      session_user: string | null
      prompt_tokens: number
      completion_tokens: number
      cache_read: number
      cache_write: number
    } | undefined
  }
}
