/**
 * Interactive chat messages with action buttons.
 *
 * A feature (e.g. email approval) publishes a message with buttons, registers
 * one handler per `kind`, and resolves the message once the underlying decision
 * was made — no matter which channel made it. The registry itself knows nothing
 * about the domain; it only routes button clicks back to the handler and keeps
 * the live clients in sync.
 *
 * State is in-memory only: after a restart old bubbles stay visible but a click
 * answers "no longer available", the same trade-off the Telegram channel makes.
 */

export interface ChatActionButton {
  actionId: string
  label: string
  style?: 'primary' | 'danger'
}

export interface ChatActionMessage {
  messageId: string
  /** Handler key, e.g. `email_approval`. */
  kind: string
  /** Id of the domain object the buttons act on. */
  refId: string
  text: string
  actions: ChatActionButton[]
  /** Set once decided — the frontend replaces the buttons with this text. */
  resolution?: string
}

export interface ChatActionUser {
  userId: number
  username: string
}

export interface ChatActionOutcome {
  ok: boolean
  /** Text shown in place of the buttons. */
  resolution: string
}

export type ChatActionHandler = (input: {
  refId: string
  actionId: string
  user: ChatActionUser
}) => ChatActionOutcome | Promise<ChatActionOutcome>

export type ChatActionInvocation =
  | { status: 'ok'; resolution: string }
  | { status: 'rejected'; resolution: string }
  | { status: 'not_found' }

export interface ChatActionRegistryDeps {
  /** Fan the message out to every connected web client. */
  publishToClients: (event: {
    type: 'chat_action' | 'chat_action_resolved'
    message: ChatActionMessage
  }) => void
}

/** Bounds in-memory growth for long-running processes. */
const MAX_TRACKED_MESSAGES = 200

export class ChatActionRegistry {
  private handlers = new Map<string, ChatActionHandler>()
  private messages = new Map<string, ChatActionMessage>()
  private counter = 0

  constructor(private deps: ChatActionRegistryDeps) {}

  // Used by email-approval-chat.ts; Fallow does not resolve the call site.
  // fallow-ignore-next-line unused-class-member
  registerHandler(kind: string, handler: ChatActionHandler): () => void {
    this.handlers.set(kind, handler)
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind)
    }
  }

  // Used by email-approval-chat.ts; Fallow does not resolve the call site.
  // fallow-ignore-next-line unused-class-member
  publish(payload: Omit<ChatActionMessage, 'messageId' | 'resolution'>): ChatActionMessage {
    const message: ChatActionMessage = { messageId: `cam-${++this.counter}`, ...payload }
    this.messages.set(message.messageId, message)
    this.prune()
    this.deps.publishToClients({ type: 'chat_action', message })
    return message
  }

  /**
   * Register buttons for a message the channel renders itself (e.g. the
   * persisted turn-error row): unlike `publish` this emits no `chat_action`
   * bubble, and the caller owns `messageId` so the buttons can be rebuilt
   * from persisted data after a page reload. Resolutions are broadcast the
   * usual way.
   */
  // Used by turn-retry-chat.ts; Fallow does not resolve the call site.
  // fallow-ignore-next-line unused-class-member
  attach(message: ChatActionMessage): ChatActionMessage {
    this.messages.set(message.messageId, message)
    this.prune()
    return message
  }

  /** Called when any channel decided — disables the buttons everywhere. */
  resolve(kind: string, refId: string, resolution: string): ChatActionMessage | null {
    const message = [...this.messages.values()]
      .find(candidate => candidate.kind === kind && candidate.refId === refId && !candidate.resolution)
    if (!message) return null

    message.resolution = resolution
    this.deps.publishToClients({ type: 'chat_action_resolved', message })
    return message
  }

  // Used by routes/chat.ts; Fallow does not resolve the call site.
  // fallow-ignore-next-line unused-class-member
  async invoke(messageId: string, actionId: string, user: ChatActionUser): Promise<ChatActionInvocation> {
    const message = this.messages.get(messageId)
    if (!message) return { status: 'not_found' }

    const handler = this.handlers.get(message.kind)
    if (!handler) return { status: 'not_found' }

    if (!message.actions.some(action => action.actionId === actionId)) return { status: 'not_found' }

    // The handler owns first-action-wins; a stale click simply loses there.
    const outcome = await handler({ refId: message.refId, actionId, user })

    // Handlers that announce their outcome cross-channel resolve the message
    // through `resolve()` while still running; broadcasting the identical
    // result again would duplicate the event for every client.
    const alreadyBroadcast = message.resolution === outcome.resolution

    // A losing click must not overwrite the winner's result for everyone; it
    // still gets the handler's answer back over HTTP.
    if (!alreadyBroadcast && (outcome.ok || !message.resolution)) {
      message.resolution = outcome.resolution
      this.deps.publishToClients({ type: 'chat_action_resolved', message })
    }

    return outcome.ok
      ? { status: 'ok', resolution: outcome.resolution }
      : { status: 'rejected', resolution: outcome.resolution }
  }

  private prune(): void {
    while (this.messages.size > MAX_TRACKED_MESSAGES) {
      const oldest = this.messages.keys().next()
      if (oldest.done) return
      this.messages.delete(oldest.value)
    }
  }
}
