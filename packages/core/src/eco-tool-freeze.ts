import type { Database } from './database.js'
import { projectToolResultSafe, toolResultText, type EcoProjectionOptions } from './eco-tool-projection.js'

/**
 * Eco freeze-at-birth (plan 2026-10-05-real-eco).
 *
 * Called from the agent's `afterToolCall` hook — after the tool ran, BEFORE
 * the result becomes a message the model can see. When it returns a value,
 * the caller replaces the tool result with it; that replacement then flows
 * into the agent state, the transcript row and every later request, so the
 * projection is sent identically forever (Eco on/off, restart, resume).
 *
 * Persistence comes first: the tool row is written in ONE transaction with the
 * verbatim original in `chat_messages.eco_original` and the projection (which
 * names that row id) in `metadata.toolResult`. Only after the commit is the
 * projection handed back. Any failure keeps the original (returns null) — no
 * saving is claimed then. The persistence paths (turn-runner / task-runner)
 * see `details.eco.rowId` and reuse that row instead of inserting a second one.
 */

export interface EcoFreezeInput {
  db: Database
  sessionId: string
  /** Stored `chat_messages.user_id` (task rows keep NULL, as before). */
  userId: number | null
  /**
   * Trusted owner of the session (resolved via {@link resolveEcoOwner}).
   * Without one nothing is frozen and no raw original is stored (fail closed);
   * a stored userId that disagrees with it also keeps the original.
   */
  ownerUserId: number | undefined
  agentId: string
  toolName: string
  toolCallId: string
  args: unknown
  /** Executed result before any override. */
  content: unknown
  details: unknown
  isError: boolean
  options?: EcoProjectionOptions
}

export interface EcoFrozenDetails {
  rowId: number
  originalChars: number
  projectedChars: number
}

export interface EcoFreezeResult {
  content: { type: 'text'; text: string }[]
  details: Record<string, unknown> & { eco: EcoFrozenDetails }
  eco: EcoFrozenDetails
}

class KeepOriginal extends Error {}

/**
 * Numeric owner of a session, following `parent_session_id` up (task session ->
 * strand). `sessions.user_id` wins, else `session_user` (user id as string).
 * Undefined when nothing on the chain names an owner, or on any DB error.
 */
export function resolveEcoOwner(db: Database, sessionId: string): number | undefined {
  let current: string | null = sessionId
  for (let depth = 0; current && depth < 8; depth++) {
    let s: { user_id: number | null; session_user: string | null; parent_session_id: string | null } | undefined
    try {
      s = db.prepare('SELECT user_id, session_user, parent_session_id FROM sessions WHERE id = ?').get(current) as typeof s
    } catch {
      return undefined
    }
    if (!s) return undefined
    if (typeof s.user_id === 'number') return s.user_id
    if (s.session_user && /^\d+$/.test(s.session_user)) return Number(s.session_user)
    current = s.parent_session_id
  }
  return undefined
}

/**
 * Trusted owner for a web/runtime turn: the turn's user (AsyncLocalStorage)
 * must agree with the session owner from the DB. If the ALS context is lost
 * the DB owner is used; if they disagree, or neither exists -> undefined
 * (the caller then freezes nothing).
 */
export function resolveTurnEcoOwner(db: Database, sessionId: string, turnUserId: number | undefined): number | undefined {
  const sessionOwner = resolveEcoOwner(db, sessionId)
  if (turnUserId !== undefined && sessionOwner !== undefined && turnUserId !== sessionOwner) return undefined
  return turnUserId ?? sessionOwner
}

/**
 * Tools whose result IS the recovery path for an earlier projection. Projecting
 * them again would turn "give me the original" into another partial view (a
 * recall loop that never yields the omitted lines), so they always pass through.
 */
export const ECO_PASSTHROUGH_TOOLS: ReadonlySet<string> = new Set(['recall_message', 'read_chat_history'])

/**
 * Canonical recovery / paging paths that must reach the model verbatim:
 * `recall_message` (the documented way back to an Eco original),
 * `read_chat_history` (the history pager) and `read_file` called with an
 * explicit `offset`/`limit` — the way to page a long file or a shell spill
 * file. The model asked for exactly that slice; another partial view of it
 * would make the omitted lines unreachable.
 */
export function isEcoPassthrough(toolName: string, args: unknown): boolean {
  if (ECO_PASSTHROUGH_TOOLS.has(toolName)) return true
  if (toolName === 'read_file' && args && typeof args === 'object') {
    const a = args as { offset?: unknown; limit?: unknown }
    return typeof a.offset === 'number' || typeof a.limit === 'number'
  }
  return false
}

export function freezeEcoToolResult(input: EcoFreezeInput): EcoFreezeResult | null {
  if (isEcoPassthrough(input.toolName, input.args)) return null
  // Fail closed on ownership: a raw original is only stored for a trusted
  // owner (see resolveEcoOwner). Without one the result stays as is.
  if (typeof input.ownerUserId !== 'number') return null
  if (input.userId !== null && input.userId !== input.ownerUserId) return null
  try {
    // Inside the try: odd tool content (a throwing getter, a non-JSON-able
    // value) must keep the original, never break the tool loop.
    const text = toolResultText(input.content)
    if (text === null || !input.sessionId || !input.toolCallId) return null
    // Cheap pre-check so tiny results never touch the DB.
    if (text.length <= (input.options?.minChars ?? 6000)) return null
    return input.db.transaction((): EcoFreezeResult => {
      const existing = input.db.prepare(
        `SELECT id FROM chat_messages WHERE session_id = ? AND role = 'tool' AND json_valid(metadata)
           AND json_extract(metadata, '$.toolCallId') = ? LIMIT 1`,
      ).get(input.sessionId, input.toolCallId)
      // A row for this call already exists (replay/duplicate event): never
      // create a second reference, keep the original path.
      if (existing) throw new KeepOriginal()
      const original = JSON.stringify({ content: input.content, details: input.details ?? null })
      const inserted = input.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, eco_original) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(input.sessionId, input.userId, 'tool', `Tool: ${input.toolName}`, '{}', input.agentId, original)
      const rowId = Number(inserted.lastInsertRowid)
      const projection = projectToolResultSafe({
        toolName: input.toolName, args: input.args, text, isError: input.isError, refId: rowId,
        exitCode: input.details && typeof input.details === 'object' && typeof (input.details as { exitCode?: unknown }).exitCode === 'number'
          ? (input.details as { exitCode: number }).exitCode : undefined,
      }, input.options)
      if (!projection) throw new KeepOriginal()
      const eco: EcoFrozenDetails = { rowId, originalChars: projection.originalChars, projectedChars: projection.projectedChars }
      const baseDetails = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
        ? input.details as Record<string, unknown> : {}
      const details = { ...baseDetails, eco }
      const content = [{ type: 'text' as const, text: projection.text }]
      input.db.prepare('UPDATE chat_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        toolArgs: input.args ?? null,
        toolResult: { content, details },
        toolIsError: input.isError,
      }), rowId)
      return { content, details, eco }
    })()
  } catch (err) {
    if (!(err instanceof KeepOriginal)) {
      console.error(`[eco] freezing tool result ${input.toolCallId} failed; keeping the original:`, err)
    }
    return null
  }
}

/**
 * Row id of a result frozen by {@link freezeEcoToolResult} for exactly this
 * session + call, or undefined. Used by the persistence paths to skip their
 * own insert (no duplicate tool rows).
 */
export function frozenEcoRowId(db: Database, sessionId: string, toolCallId: string, result: unknown): number | undefined {
  const eco = result && typeof result === 'object'
    ? ((result as { details?: { eco?: { rowId?: unknown } } }).details?.eco)
    : undefined
  const rowId = eco && typeof eco.rowId === 'number' ? eco.rowId : undefined
  if (rowId === undefined) return undefined
  try {
    const row = db.prepare(
      `SELECT id FROM chat_messages WHERE id = ? AND session_id = ? AND role = 'tool' AND eco_original IS NOT NULL
         AND json_extract(metadata, '$.toolCallId') = ?`,
    ).get(rowId, sessionId, toolCallId) as { id: number } | undefined
    return row?.id
  } catch {
    return undefined
  }
}
