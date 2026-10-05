import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { resolveAgentReadScope } from './agent-read-scope.js'
import { RECALLED_MARKER } from './message-digest.js'
import { toolResultText } from './eco-tool-projection.js'

function recallPage(body: string, rawOffset: number | undefined, maxChars: number): { slice: string; offset: number; remaining: number; note: string } {
  const offset = Math.max(0, Math.floor(rawOffset ?? 0))
  const slice = body.slice(offset, offset + maxChars)
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
        && (currentUserId === undefined || row.user_id === null || row.user_id === currentUserId)
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
            try {
              originalText = toolResultText((JSON.parse(row.eco_original) as { content?: unknown }).content)
            } catch { /* fall through to the stored row */ }
            if (originalText !== null) {
              const page = recallPage(originalText, rawOffset, maxChars)
              return {
                content: [{ type: 'text' as const, text: `${RECALLED_MARKER} message ${row.id} (tool ${meta.toolName ?? 'unknown'}, verbatim original of an Eco-compacted result, ${originalText.length} chars${page.note})\n${page.slice}` }],
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

      const offset = Math.max(0, Math.floor(rawOffset ?? 0))
      const slice = body.slice(offset, offset + maxChars)
      const remaining = Math.max(0, body.length - offset - slice.length)
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
