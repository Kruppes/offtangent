import { extractUploadsFromToolResult, serializeUploadsMetadata } from '@axiom/core'
import type { Database, UploadDescriptor } from '@axiom/core'

/**
 * The transcript of one task-injection turn.
 *
 * A task injection is the agent reacting to "your background task finished".
 * It is a real turn with real tool calls, but it does not run through
 * `TurnRunner` — its chunks arrive on `agentCore.setOnTaskInjectionChunk`, and
 * the composition writes the assistant row itself. This class is that writer,
 * extracted so the rule "what an injection produced ends up in history" can be
 * tested without booting the whole runtime.
 *
 * It deliberately mirrors `TurnTranscript` in `core/src/turn-runner.ts`:
 * collect text, collect the uploads of every `tool_call_end`, and persist both
 * on one assistant row — files in `metadata.files`, the same envelope an
 * incoming upload uses.
 */
export class TaskInjectionTranscript {
  private text = ''
  private readonly collected: UploadDescriptor[] = []

  /** True when a Telegram delivery was made for this injection. */
  telegramDelivered = false

  /**
   * True when the stream carried an `error` chunk. The durable injection
   * queue (W4) uses this to decide whether the `done` chunk is an ack: a turn
   * that died must stay `pending` so the sweeper re-delivers it, otherwise a
   * provider outage would silently swallow a task result.
   */
  failed = false

  /**
   * Consume one chunk. Returns the uploads this chunk added, so the caller can
   * put an `attachment` frame on the bus for each of them — without that frame
   * a live client shows the answer but not the file it talks about.
   */
  record(chunk: { type: string; text?: string; toolResult?: unknown }): UploadDescriptor[] {
    if (chunk.type === 'error') {
      this.failed = true
      return []
    }
    if (chunk.type === 'text' && chunk.text) {
      this.text += chunk.text
      return []
    }
    if (chunk.type === 'tool_call_end') {
      const uploads = extractUploadsFromToolResult(chunk.toolResult)
        .filter(upload => !this.collected.some(known => known.relativePath === upload.relativePath))
      this.collected.push(...uploads)
      return uploads
    }
    return []
  }

  get responseText(): string {
    return this.text
  }

  get uploads(): readonly UploadDescriptor[] {
    return this.collected
  }

  /** Nothing to persist: no text and no file. */
  get isEmpty(): boolean {
    return !this.text && this.collected.length === 0
  }

  /**
   * The row's metadata. `type` and `telegramDelivered` are what the clients
   * already read for an injection; `files` is the same key an incoming upload
   * (and every other outgoing one) uses, so no client needs a second parser.
   */
  buildMetadata(): string {
    const base = { type: 'task_injection_response', telegramDelivered: this.telegramDelivered }
    if (this.collected.length === 0) return JSON.stringify(base)
    const files = JSON.parse(serializeUploadsMetadata([...this.collected])) as { files: UploadDescriptor[] }
    return JSON.stringify({ ...base, ...files })
  }

  /**
   * Write the assistant row. A turn that produced only a file still gets a row
   * (with empty content), otherwise the file exists on disk with nothing in
   * history pointing at it.
   */
  persist(db: Database, target: { sessionId: string; userId: number; agentId: string }): number | null {
    if (this.isEmpty) return null
    const result = db.prepare(
      'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(target.sessionId, target.userId, 'assistant', this.text, this.buildMetadata(), target.agentId)
    return Number(result.lastInsertRowid)
  }
}
