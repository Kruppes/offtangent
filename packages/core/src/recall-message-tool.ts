import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { resolveAgentReadScope } from './agent-read-scope.js'
import { RECALLED_MARKER } from './message-digest.js'

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
          'SELECT id, session_id, user_id, role, content, metadata, timestamp, agent_id FROM chat_messages WHERE id = ?',
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
      if (row.role === 'tool' && row.metadata) {
        try {
          const meta = JSON.parse(row.metadata) as { toolName?: string; toolResult?: unknown; toolArgs?: unknown }
          const result = meta.toolResult
          const resultText = typeof result === 'string' ? result : result == null ? '' : JSON.stringify(result, null, 2)
          body = `Tool: ${meta.toolName ?? 'unknown'}\nArgs: ${meta.toolArgs == null ? '' : JSON.stringify(meta.toolArgs)}\nResult:\n${resultText}`
        } catch {
          // keep raw content
        }
      }

      const offset = Math.max(0, Math.floor(rawOffset ?? 0))
      const slice = body.slice(offset, offset + maxChars)
      const remaining = Math.max(0, body.length - offset - slice.length)
      const header = `${RECALLED_MARKER} message ${row.id} (${row.role}, ${row.timestamp}, ${body.length} chars` +
        (offset > 0 ? `, from ${offset}` : '') + `)`
      const footer = remaining > 0 ? `\n\n[${remaining} more chars, call again with offset=${offset + slice.length}]` : ''

      return {
        content: [{ type: 'text' as const, text: `${header}\n${slice}${footer}` }],
        details: { messageId: row.id, role: row.role, sessionId: row.session_id, offset, returned: slice.length, remaining },
      }
    },
  }
}
