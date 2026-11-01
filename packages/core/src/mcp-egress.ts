/**
 * MCP egress gate for the whole outgoing conversation (review 2 / B).
 *
 * Policy (deliberately conservative, fail closed): once a strand carries
 * private (`local_only`) MCP material ANYWHERE — a tool result, the arguments
 * of an MCP call, an assistant text written after one, a tool declaration in
 * the transcript, a recalled history row, or a persisted MCP row of the
 * session — NO request of that context goes to a model that is not strictly
 * local. There is no attempt to anonymise quotes: the whole request is
 * refused with a fixed error. Leaving the context (new strand, or switching
 * back to a strictly local model) is the only way out. No user consent is
 * assumed anywhere.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Database } from 'better-sqlite3'
import { MCP_TOOL_PREFIX } from './mcp-client.js'

/** Fixed, remote-text-free error for a refused cloud request. */
export const MCP_PRIVATE_CONTEXT_ERROR =
  'MCP privacy gate: this strand contains private local MCP data (dataClass local_only); '
  + 'the request was NOT sent to the non-local model. Switch this strand back to a strictly '
  + 'local model or continue in a new strand.'

export class McpPrivateContextError extends Error {
  readonly code = 'mcp_private_context'
  constructor() {
    super(MCP_PRIVATE_CONTEXT_ERROR)
    this.name = 'McpPrivateContextError'
  }
}

/** Notice a history tool returns instead of rows of a private MCP strand on a non-local model. */
export const MCP_PRIVATE_HISTORY_NOTICE =
  '[withheld: these messages belong to a strand with private local MCP data (local_only) '
  + 'and are not shown to a non-local model]'

function isMcpName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
}

function detailsOf(m: unknown): Record<string, unknown> | null {
  const d = (m as { details?: unknown } | null)?.details
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : null
}

/**
 * Reason class when `messages` carry private MCP material, else null.
 * `cloudOkToolNames` are the MCP tool names whose server is explicitly
 * `cloud_ok`; a name outside it counts as private.
 */
export function findPrivateMcpEvidence(messages: readonly unknown[], cloudOkToolNames: ReadonlySet<string>): string | null {
  // Calls proven cloud_ok by their own result marker.
  const cloudOkCalls = new Set<string>()
  for (const m of messages) {
    const msg = m as { role?: unknown; toolName?: unknown; toolCallId?: unknown }
    if (msg?.role === 'toolResult' && isMcpName(msg.toolName) && detailsOf(m)?.mcpDataClass === 'cloud_ok' && typeof msg.toolCallId === 'string') {
      cloudOkCalls.add(msg.toolCallId)
    }
  }
  for (const m of messages) {
    const msg = m as { role?: unknown; toolName?: unknown; toolCallId?: unknown; content?: unknown; toolsAdded?: unknown }
    if (!msg || typeof msg !== 'object') continue
    if (msg.role === 'toolResult') {
      if (detailsOf(m)?.mcpPrivate === true) return 'recalled_private_history'
      if (isMcpName(msg.toolName) && detailsOf(m)?.mcpDataClass !== 'cloud_ok') return 'tool_result'
      continue
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type?: unknown; name?: unknown; id?: unknown }>) {
        if (block?.type === 'toolCall' && isMcpName(block.name)) {
          const proven = typeof block.id === 'string' && cloudOkCalls.has(block.id)
          if (!proven && !cloudOkToolNames.has(block.name as string)) return 'tool_call'
        }
      }
      continue
    }
    if (Array.isArray(msg.toolsAdded)) {
      for (const decl of msg.toolsAdded as Array<{ name?: unknown }>) {
        if (isMcpName(decl?.name) && !cloudOkToolNames.has(decl.name as string)) return 'tool_definition'
      }
    }
  }
  return null
}

const PRIVATE_ROW_SQL = `
  SELECT 1 FROM chat_messages
  WHERE session_id = ? AND role = 'tool' AND json_valid(metadata) AND (
    (json_extract(metadata, '$.toolName') LIKE 'mcp\\_%' ESCAPE '\\'
      AND COALESCE(json_extract(metadata, '$.toolResult.details.mcpDataClass'), '') <> 'cloud_ok')
    OR json_extract(metadata, '$.toolResult.details.mcpPrivate') = 1
  )
  LIMIT 1`

/**
 * True when the persisted session holds private MCP material (survives
 * restarts, history reloads, compaction and forks that copy rows).
 * Fail closed: a query error counts as private.
 */
export function isPrivateMcpSession(db: Database | undefined | null, sessionId: string | null | undefined): boolean {
  if (!db || !sessionId) return false
  try {
    if (db.prepare(PRIVATE_ROW_SQL).get(sessionId) !== undefined) return true
    // Review 3 / P1-2: the persistent strand marker (private tool metadata
    // reached a model of this strand, even without any MCP tool call). A
    // marker can only exist once its table does, so an absent table is clean.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mcp_private_sessions'").get() === undefined) return false
    return db.prepare('SELECT 1 FROM mcp_private_sessions WHERE session_id = ?').get(sessionId) !== undefined
  } catch {
    return true
  }
}

/**
 * Review 3 / P1-2: persist that `sessionId` carries private MCP material
 * (rows, tool declarations, metadata). Written BEFORE the material is sent to
 * a (local) model, so every side path, a reload and helpers running in
 * parallel see it. Returns false when the marker could not be written; the
 * caller must then refuse the request (unclear persistence = fail closed).
 */
export function markPrivateMcpSession(db: Database | undefined | null, sessionId: string | null | undefined): boolean {
  if (!db || !sessionId) return false
  try {
    db.exec("CREATE TABLE IF NOT EXISTS mcp_private_sessions (session_id TEXT PRIMARY KEY, marked_at TEXT NOT NULL DEFAULT (datetime('now')))")
    db.prepare('INSERT OR IGNORE INTO mcp_private_sessions (session_id) VALUES (?)').run(sessionId)
    return true
  } catch {
    return false
  }
}

/**
 * Review 3 / P1-2: in-memory privacy state of the running turn. The runtime
 * enters it around its SDK loop; every tool executed in that loop inherits it
 * (same pattern as the secret sealing scope). `private` flips to true before
 * private MCP material (results, declarations, metadata) is sent to a model.
 */
export interface McpPrivacyTurn { sessionId: string | null; private: boolean }
const privacyTurn = new AsyncLocalStorage<McpPrivacyTurn>()

export function runInMcpPrivacyTurn<T>(turn: McpPrivacyTurn, fn: () => T): T {
  return privacyTurn.run(turn, fn)
}

export function currentMcpPrivacyTurn(): McpPrivacyTurn | undefined {
  return privacyTurn.getStore()
}

/**
 * Review 3 / P1-2 + P2: one classification for every side path (tools and
 * automatic helpers). True when the scope is private OR unknown:
 * - the running turn (same strand, or no strand named) is in-memory private;
 * - the strand is persisted as private (rows or marker), or the lookup fails;
 * - no database or no strand id can be resolved (unknown scope: fail closed).
 * A missing session id falls back to the running turn's strand.
 */
export function isPrivateMcpScope(db: Database | undefined | null, sessionId: string | null | undefined): boolean {
  const turn = privacyTurn.getStore()
  const sid = sessionId || turn?.sessionId || null
  if (turn?.private && (!sessionId || sessionId === turn.sessionId)) return true
  if (!db || !sid) return true
  if (!sessionExists(db, sid)) return true
  return isPrivateMcpSession(db, sid)
}

/** Review 4 / P2: a strand id without a `sessions` row is an unknown scope, never clean. */
function sessionExists(db: Database, sessionId: string): boolean {
  try {
    return db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * Review 4: the ONLY tools a strand with private MCP material may run. Each
 * one reads local state (files, history, tasks, cron, skills) or asks the
 * user, and none of them forwards model-written text to another execution
 * context, strand, network service or persistent store that a non-local
 * model reads later. Everything else, including universal tools (shell,
 * codemode), file writes, delegation (create/resume/steer task, ask_agent,
 * fork_strand), schedules, memory/skill writes, boards, artefacts, mail,
 * web, connectors, voice, STT and embedding-backed search, is refused by
 * the runtime's central call guard. New tools are refused until they are
 * reviewed and added here; extend this list, never the other way round.
 */
export const MCP_PRIVATE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'ask_user',
  'read_file',
  'list_files',
  'read_chat_history',
  'recall_message',
  'list_tasks',
  'get_task',
  'list_cronjobs',
  'get_cronjob',
  'list_agent_skills',
])

export const MCP_PRIVATE_TOOL_BLOCKED =
  'MCP privacy gate: this strand holds private local MCP data (dataClass local_only); only read-only '
  + 'local tools and its own MCP tools run here. This tool could forward data out of the strand and was '
  + 'NOT executed. Continue in a new strand without that data.'

/**
 * Review 4: central call decision for a strand that holds private MCP
 * material. `offeredMcpToolNames` are the MCP tools the server policy offers
 * to THIS turn right now (re-read per call); an MCP name outside it is refused.
 */
export function isToolAllowedInPrivateMcpScope(toolName: string, offeredMcpToolNames: ReadonlySet<string>): boolean {
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return offeredMcpToolNames.has(toolName)
  return MCP_PRIVATE_TOOL_ALLOWLIST.has(toolName)
}

/** True when any of the sessions is a private MCP session (fail closed on error). */
export function anyPrivateMcpSession(db: Database, sessionIds: Iterable<string>): boolean {
  for (const id of new Set(sessionIds)) if (isPrivateMcpSession(db, id)) return true
  return false
}

/** Skip reason the background helpers report for a private MCP strand. */
export const MCP_PRIVATE_SKIP_REASON = 'mcp_private' as const

/**
 * Gate for the automatic helpers that read a strand on their own and send it
 * to a model outside the turn (session summary, fact extraction, auto-title,
 * project assignment, capture router candidates, delegation context, plan
 * context, voice summaries). They do not route through the turn's egress
 * gate, so a private MCP strand is left out of them entirely, whatever model
 * they would use. Fail closed through isPrivateMcpSession.
 */
export function skipPrivateMcpSession(db: Database | undefined | null, sessionId: string | null | undefined, site: string): boolean {
  if (!isPrivateMcpScope(db, sessionId)) return false
  console.warn(`[mcp-egress] ${site} skipped: strand holds private MCP data (local_only) or its scope is unknown`)
  return true
}
