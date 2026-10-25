/**
 * S1-D, D2: the editable status line of a running Telegram turn.
 *
 * At turn start the bot sends one status message ("⏳ Arbeitet… 0 s") and
 * keeps editing it: at every tool call start (tool NAME only, never its
 * arguments) and at least every `tickMs` (elapsed time). Telegram rate
 * limits edits, so at most one edit per `minEditIntervalMs`; a change that
 * arrives inside the window is not dropped but drawn by one trailing edit
 * at the end of the window, so the line always catches up with the latest
 * state. At turn end the line is deleted (default) or set to
 * "✅ fertig nach N s".
 *
 * Tool names pass the same vocabulary rule as the task HANDOFF
 * (`handoffToolName`): only a plain, registered tool name is shown,
 * anything else becomes `other_tool`.
 *
 * Every Telegram call is best effort: a failed send leaves no line, a
 * failed edit (message deleted by the user, "message is not modified", rate
 * limit) is swallowed and never reaches the turn.
 */
import { handoffToolName } from '@axiom/core'

export interface StatusLineApi {
  sendMessage(chatId: string | number, text: string): Promise<{ message_id: number }>
  editMessageText(chatId: string | number, messageId: number, text: string): Promise<unknown>
  deleteMessage(chatId: string | number, messageId: number): Promise<unknown>
}

export type StatusLineEndMode = 'delete' | 'done'

export interface TurnStatusLineOptions {
  api: StatusLineApi
  chatId: string | number
  /** What happens to the line at turn end. Default 'delete'. */
  onEnd?: StatusLineEndMode
  /** Registered tool names; `null` = unknown (shape check only). Read at every tool start. */
  knownTools?: () => ReadonlySet<string> | null
  /** Minimum gap between two edits (Telegram rate limit). Default 3000 ms. */
  minEditIntervalMs?: number
  /** Elapsed-time refresh. Default 5000 ms. */
  tickMs?: number
  now?: () => number
}

export const STATUS_MIN_EDIT_INTERVAL_MS = 3000
export const STATUS_TICK_MS = 5000

export function formatStatusText(elapsedMs: number, tool: string | null): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  return tool ? `⏳ Arbeitet… ${seconds} s · 🔧 ${tool}` : `⏳ Arbeitet… ${seconds} s`
}

export function formatDoneText(elapsedMs: number): string {
  return `✅ fertig nach ${Math.max(0, Math.round(elapsedMs / 1000))} s`
}

export class TurnStatusLine {
  private readonly api: StatusLineApi
  private readonly chatId: string | number
  private readonly onEnd: StatusLineEndMode
  private readonly knownTools: () => ReadonlySet<string> | null
  private readonly minEditIntervalMs: number
  private readonly tickMs: number
  private readonly now: () => number

  private startedAt = 0
  private tool: string | null = null
  private messageId: number | null = null
  private sent: Promise<void> | null = null
  private lastEditAt = Number.NEGATIVE_INFINITY
  private lastText = ''
  private trailing: ReturnType<typeof setTimeout> | null = null
  private ticker: ReturnType<typeof setInterval> | null = null
  private editing: Promise<void> = Promise.resolve()
  private ended = false
  /** The message is gone (deleted by the user): no further edits. */
  private dead = false

  constructor(options: TurnStatusLineOptions) {
    this.api = options.api
    this.chatId = options.chatId
    this.onEnd = options.onEnd ?? 'delete'
    this.knownTools = options.knownTools ?? (() => null)
    this.minEditIntervalMs = options.minEditIntervalMs ?? STATUS_MIN_EDIT_INTERVAL_MS
    this.tickMs = options.tickMs ?? STATUS_TICK_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Send the initial line and start the elapsed-time ticker. */
  start(): void {
    if (this.sent) return
    this.startedAt = this.now()
    const text = formatStatusText(0, null)
    this.lastText = text
    this.sent = this.api.sendMessage(this.chatId, text).then((msg) => {
      this.messageId = typeof msg?.message_id === 'number' ? msg.message_id : null
      this.lastEditAt = this.now()
    }).catch(() => {
      this.dead = true
    })
    this.ticker = setInterval(() => this.requestUpdate(), this.tickMs)
  }

  /** A tool call started: show its (vocabulary-checked) name, never arguments. */
  toolStarted(name: unknown): void {
    if (this.ended) return
    let known: ReadonlySet<string> | null = null
    try {
      known = this.knownTools()
    } catch {
      known = null
    }
    this.tool = handoffToolName(name, known)
    this.requestUpdate()
  }

  /** Current text of the line (for tests and diagnostics). */
  currentText(): string {
    return formatStatusText(this.now() - this.startedAt, this.tool)
  }

  /**
   * Draw the latest state now when the rate window allows it, otherwise
   * once at the end of the window (one trailing edit, always the latest).
   */
  private requestUpdate(): void {
    if (this.ended || this.dead) return
    if (this.trailing) return
    const wait = this.lastEditAt + this.minEditIntervalMs - this.now()
    if (wait <= 0 && this.messageId !== null) {
      this.flush()
      return
    }
    this.trailing = setTimeout(() => {
      this.trailing = null
      if (this.messageId === null) {
        // Initial send still pending: try again after the next window.
        if (!this.dead && !this.ended) this.requestUpdate()
        return
      }
      this.flush()
    }, Math.max(wait, this.minEditIntervalMs / 10))
  }

  private flush(): void {
    if (this.ended || this.dead || this.messageId === null) return
    const text = this.currentText()
    // Telegram refuses an edit to the same text ("message is not modified").
    if (text === this.lastText) return
    this.lastText = text
    this.lastEditAt = this.now()
    const messageId = this.messageId
    this.editing = this.editing.then(() => this.api.editMessageText(this.chatId, messageId, text)).then(
      () => undefined,
      (err: unknown) => {
        // Deleted by the user: stop editing. Any other error: skip this edit.
        if (/not found|to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(String((err as Error)?.message ?? err))) {
          this.dead = true
        }
      },
    )
  }

  /** The turn ended: stop timers, then delete the line or set it to "fertig". */
  async finish(): Promise<void> {
    if (this.ended) return
    this.ended = true
    if (this.ticker) clearInterval(this.ticker)
    if (this.trailing) clearTimeout(this.trailing)
    this.ticker = null
    this.trailing = null
    try {
      await this.sent
      await this.editing
    } catch {
      // Both are already caught; defensive.
    }
    if (this.messageId === null) return
    const messageId = this.messageId
    try {
      if (this.onEnd === 'done') {
        if (!this.dead) {
          // Same rate window as the intermediate edits (REVIEW-S1-D,
          // finding 4): the final edit waits until the last one is
          // `minEditIntervalMs` old. The duration is the turn's, not the wait's.
          const text = formatDoneText(this.now() - this.startedAt)
          const wait = this.lastEditAt + this.minEditIntervalMs - this.now()
          if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
          if (!this.dead) await this.api.editMessageText(this.chatId, messageId, text)
        }
      } else {
        await this.api.deleteMessage(this.chatId, messageId)
      }
    } catch {
      // Already deleted or too old to delete: nothing left to clean up.
    }
  }
}
