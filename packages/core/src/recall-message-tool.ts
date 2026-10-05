import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { resolveAgentReadScope } from './agent-read-scope.js'
import { RECALLED_MARKER } from './message-digest.js'
import { toolResultText } from './eco-tool-projection.js'
import { resolveEcoOwner } from './eco-tool-freeze.js'

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/**
 * One page of `body`. Offsets are UTF-16 indices (what the Eco projection
 * names), but a page never starts or ends inside a surrogate pair: a lone
 * surrogate would be persisted into the transcript and replayed forever.
 * An offset that points at the low half moves back one unit (reported), an
 * end that would cut a pair stops before it (the "next offset" stays exact).
 */
function recallPage(body: string, rawOffset: number | undefined, maxChars: number): { slice: string; offset: number; remaining: number; note: string } {
  let offset = Math.min(Math.max(0, Math.floor(rawOffset ?? 0)), body.length)
  if (offset > 0 && offset < body.length && isLow(body.charCodeAt(offset)) && isHigh(body.charCodeAt(offset - 1))) offset--
  let end = Math.min(body.length, offset + Math.max(1, maxChars))
  if (end < body.length && end > offset && isHigh(body.charCodeAt(end - 1)) && isLow(body.charCodeAt(end))) {
    // Never return an empty page (offset would never advance): keep the pair whole instead.
    end = end - 1 > offset ? end - 1 : end + 1
  }
  const slice = body.slice(offset, end)
  const remaining = Math.max(0, body.length - offset - slice.length)
  const note = `${offset > 0 ? `, from offset ${offset}` : ''}${remaining > 0 ? `; ${remaining} more chars — call again with offset ${offset + slice.length}` : ''}`
  return { slice, offset, remaining, note }
}

export interface RecallMessageToolOptions {
  db: Database
  /** Persona of the calling runtime. Non-'main' personas only recall their own rows. */
  getCurrentAgentId?: () => string | undefined
  /** Numeric user of the calling turn. When set, rows of other users are invisible. */
  getCurrentUserId?: () => number | undefined
  /** Hard cap on returned characters (the caller can page with `offset`). */
  maxChars?: number
}

interface RecallRow {
  id: number
  session_id: string
  user_id: number | null
  role: string
  content: string
  metadata: string | null
  timestamp: string
  agent_id: string | null
  /** Real Eco: verbatim original of a result compacted at creation (additive column). */
  eco_original?: string | null
}

const DEFAULT_MAX_CHARS = 16000

/**
 * `recall_message`: reload the verbatim content of one chat message by id.
 *
 * This is the restore half of restorable compression (SPEC 11.1). Digest
 * lines in prompts look like `[msg:123] assistant, 5400 chars: ...`; the
 * model passes 123 here and gets the original back. Tool rows return the
 * stored tool result. The output is prefixed with the recalled marker so a
 * later fact extraction does not treat it as new information.
 */
export function createRecallMessageTool(options: RecallMessageToolOptions): AgentTool {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  return {
    name: 'recall_message',
    label: 'Recall Message',
    description:
      'Reload the full, verbatim content of one earlier message by its id. Use this when the context shows a ' +
      'shortened line like "[msg:123] assistant, 5400 chars: ..." and you need the original text or the full tool ' +
      'result. Long messages are paged: pass `offset` to continue.',
    parameters: Type.Object({
      message_id: Type.Number({ description: 'The numeric id from the "[msg:<id>]" digest line.' }),
      offset: Type.Optional(Type.Number({ description: 'Character offset to continue a long message from (default 0).' })),
    }),
    execute: async (_toolCallId, params) => {
      // Schema frozen (legacy contract): the tool description and parameters
      // are part of every request's cached prefix, so they never change here.
      const { message_id, offset: rawOffset } = params as { message_id: number; offset?: number }
      const id = Number(message_id)
      if (!Number.isInteger(id) || id <= 0) {
        return { content: [{ type: 'text' as const, text: 'Error: message_id must be a positive integer.' }], details: { error: true } }
      }

      const scope = resolveAgentReadScope({ requested: undefined, callerAgentId: options.getCurrentAgentId?.() })
      if (!scope.ok) {
        return { content: [{ type: 'text' as const, text: scope.error }], details: { error: true } }
      }

      let row: RecallRow | undefined
      try {
        row = options.db.prepare(
          'SELECT * FROM chat_messages WHERE id = ?',
        ).get(id) as RecallRow | undefined
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error reading message: ${err instanceof Error ? err.message : String(err)}` }], details: { error: true } }
      }

      const currentUserId = options.getCurrentUserId?.()
      const visible = row
        && (scope.agentId === undefined || row.agent_id === scope.agentId || row.agent_id === 'shared')
        && (currentUserId === undefined || row.user_id === currentUserId
          // Rows without a user (task sessions write user_id NULL) stay visible
          // as before — EXCEPT a raw Eco original: its owner is resolved from
          // the session tree and the original is denied (fail closed) to any
          // other user or when no owner can be resolved.
          || (row.user_id === null && (typeof row.eco_original !== 'string'
            || resolveEcoOwner(options.db, row.session_id) === currentUserId)))
      if (!row || !visible) {
        return { content: [{ type: 'text' as const, text: `Error: message ${id} not found.` }], details: { error: true, notFound: true } }
      }

      let body = row.content
      // Tool caps run inside the tool, BEFORE the result is stored: the stored
      // text is then the capped output, never the raw one. Say so.
      let toolCapNote = ''
      if (row.role === 'tool' && row.metadata) {
        try {
          const meta = JSON.parse(row.metadata) as { toolName?: string; toolResult?: unknown; toolArgs?: unknown }
          // Real Eco: the model saw a projection; recall hands back the
          // verbatim original stored before the projection was shown.
          // The body is then the original text itself, so the char offsets the
          // projection names ("recall_message offset ≈ N") hit exactly.
          if (typeof row.eco_original === 'string') {
            let originalText: string | null = null
            let ecoCapNote = ''
            try {
              const parsed = JSON.parse(row.eco_original) as { content?: unknown; details?: { truncated?: unknown; totalChars?: unknown; fullOutputPath?: unknown } | null }
              originalText = toolResultText(parsed.content)
              // The original may itself be tool-capped (shell spill): say so,
              // exactly like the non-Eco path, so "verbatim" is not misread as "complete".
              const d = parsed.details
              if (d && typeof d === 'object' && d.truncated === true) {
                ecoCapNote = `, tool-capped before storage${typeof d.totalChars === 'number' ? ` (tool output was ${d.totalChars} chars)` : ''}` +
                  (typeof d.fullOutputPath === 'string' ? `; full output file: ${d.fullOutputPath}` : '')
              }
            } catch { /* fall through to the stored row */ }
            if (originalText !== null) {
              const page = recallPage(originalText, rawOffset, maxChars)
              return {
                content: [{ type: 'text' as const, text: `${RECALLED_MARKER} message ${row.id} (tool ${meta.toolName ?? 'unknown'}, verbatim original of an Eco-compacted result, ${originalText.length} chars${ecoCapNote}${page.note})\n${page.slice}` }],
                details: { messageId: row.id, role: row.role, totalChars: originalText.length, offset: page.offset, returnedChars: page.slice.length, remainingChars: page.remaining, ecoOriginal: true },
              }
            }
          }
          const result = meta.toolResult
          const resultText = typeof result === 'string' ? result : result == null ? '' : JSON.stringify(result, null, 2)
          const details = result && typeof result === 'object' ? (result as { details?: { truncated?: unknown; totalChars?: unknown; fullOutputPath?: unknown } }).details : undefined
          if (details && details.truncated === true) {
            toolCapNote = `, tool-capped before storage${typeof details.totalChars === 'number' ? ` (tool output was ${details.totalChars} chars)` : ''}: stored text is the capped output, not the raw output` +
              (typeof details.fullOutputPath === 'string' ? `; full output file: ${details.fullOutputPath}` : '')
          }
          body = `Tool: ${meta.toolName ?? 'unknown'}\nArgs: ${meta.toolArgs == null ? '' : JSON.stringify(meta.toolArgs)}\nResult:\n${resultText}`
        } catch {
          // keep raw content
        }
      }

      // Same surrogate-safe paging as the Eco original (no lone surrogate half).
      const { offset, slice, remaining } = recallPage(body, rawOffset, maxChars)
      const header = `${RECALLED_MARKER} message ${row.id} (${row.role}, ${row.timestamp}, ${body.length} chars` +
        toolCapNote +
        (offset > 0 ? `, from ${offset}` : '') + `)`
      const footer = remaining > 0 ? `\n\n[${remaining} more chars, call again with offset=${offset + slice.length}]` : ''

      return {
        content: [{ type: 'text' as const, text: `${header}\n${slice}${footer}` }],
        details: { messageId: row.id, role: row.role, sessionId: row.session_id, offset, returned: slice.length, remaining },
      }
    },
  }
}
