import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy'
import type { Context } from 'grammy'
import type {
  AgentCore,
  Database,
  EmailApprovalNotifier,
  EmailApprovalService,
  EmailSendLogEntry,
  ResponseChunk,
  SlashCommandRegistry,
  SlashCommandPicker,
  StartModelTaskResult,
  SlashCommandAgentTurn,
  TurnEvent,
  TurnRetryService,
} from '@axiom/core'
import {
  createEmailApprovalService,
  createTurnRetryService,
  registerTurnRetryNotifier,
  TurnRunner,
  loadConfig,
  warnConfigReadFailed,
  getConfigDir,
  saveUpload,
  serializeUploadsMetadata,
  parseUploadsMetadata,
  loadSttSettings,
  transcribeAudio,
  synthesizeTts,
  withTimeout,
  SlashCommandRegistry as SlashCommandRegistryCtor,
  registerBuiltInSlashCommands,
  MODEL_TASK_COMMANDS,
  isSlashCommandPicker,
  isSlashCommandAgentTurn,
  TaskStore,
  ScheduledTaskStore,
  renderInteractionMessageAsText,
} from '@axiom/core'
import type { TurnErrorInfo, TurnPreambleToolCall, UploadDescriptor } from '@axiom/core'
import {
  EMAIL_APPROVAL_CALLBACK_PREFIX,
  buildEmailApprovalCallbackData,
  formatEmailApprovalRequest,
  formatEmailApprovalResolution,
  parseEmailApprovalCallbackData,
} from './email-approval.js'
import {
  TURN_RETRY_CALLBACK_PREFIX,
  buildTurnRetryCallbackData,
  formatTurnErrorMessage,
  formatTurnRetryResolution,
  parseTurnRetryCallbackData,
} from './turn-retry.js'

/**
 * Inline-keyboard callbacks live under this prefix. Telegram limits
 * `callback_data` to 64 bytes, so we can't ship the full slash command in
 * the payload — instead we generate a short opaque token, stash the
 * verbatim slash command in `pickerTokenStore`, and resolve it back on
 * the callback. Tokens auto-expire (see `PICKER_TOKEN_TTL_MS`).
 */
const PICKER_CALLBACK_PREFIX = 'pick:'
/** Inline-button callback prefix for task actions: `tsk:<action>:<taskId>` */
const TASK_CALLBACK_PREFIX = 'tsk:'
const PICKER_TOKEN_TTL_MS = 10 * 60 * 1000 // 10 minutes

const POLLING_RETRY_INITIAL_MS = 5_000
const POLLING_RETRY_MAX_MS = 60_000

/**
 * Telegram config stored in /data/config/telegram.json
 */
export interface TelegramConfig {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
  pollingMode: boolean
  webhookUrl: string
  batchingDelayMs: number
  sendVoiceReply?: boolean
}

/**
 * Chat event emitted by the Telegram bot for cross-channel sync.
 *
 * Deliberately narrow: the assistant side of a turn reaches other channels
 * through their own {@link TurnRunner} subscription, so only what the runner
 * does not produce is announced here — the inbound Telegram message, the
 * uploads a turn attached, and bot-initiated outbound messages.
 */
export interface TelegramChatEvent {
  type: 'user_message' | 'text' | 'done' | 'attachment'
  /** Axiom user ID (integer) — only set for linked users */
  userId: number | null
  /** Session ID used for chat_messages */
  sessionId: string
  /** Agent ID for multi-persona routing (default: 'main') */
  agentId?: string
  /** Text content */
  text?: string
  /** Display name of the sender */
  senderName?: string
  /** Uploaded file attached to the current assistant turn (for type='attachment') */
  attachment?: UploadDescriptor
  replyContext?: string
}

export interface TelegramBotOptions {
  agentCore: AgentCore
  db?: Database
  /**
   * Shared turn lifecycle owner. The composition root passes the process-wide
   * runner so web and Telegram consume the very same turns; without one the
   * bot builds a private runner (standalone / test setups).
   */
  turnRunner?: TurnRunner
  /** Overridable for tests; defaults to a service backed by `db`. */
  emailApproval?: EmailApprovalService
  config?: TelegramConfig
  /** Agent ID this bot instance represents (default: 'main') */
  agentId?: string
  /**
   * Host-runtime callback backing the model-pinned task prefix commands
   * (/fable …). Starts a background task on the given model and routes the
   * result back through the normal task-notification pipeline.
   */
  startModelTask?: (input: {
    modelId: string
    prompt: string
    agentId: string
    userId: string | null
    source: string
  }) => Promise<StartModelTaskResult>
  /**
   * Called when the user REPLIES (Telegram reply) to a message the bot sent
   * for a specific task (result, question, status update). Routes the text
   * deterministically to that task — resume if paused, follow-up task if
   * finished — instead of through the chat agent. Returns the reply text
   * shown to the user.
   */
  onTaskReply?: (input: {
    taskId: string
    text: string
    agentId: string
    userId: string | null
    source: string
  }) => Promise<string>
  /**
   * Called after a slash command switched the active provider on disk
   * (/model, /offline, /online) so the host can rebuild the agent core.
   * Invoked AFTER the confirmation reply has been sent — the rebuild
   * restarts this bot.
   */
  onActiveProviderChanged?: () => void
  /**
   * Drafts a short execution plan for a pinned-model task (cheap/triage
   * model). When provided, /fable-style commands show the plan with
   * ✅ Start / ❌ Cancel buttons before the heavy model runs.
   */
  draftTaskPlan?: (input: {
    prompt: string
    agentId: string
    userId: string | null
  }) => Promise<string>
  /**
   * Inline-button actions on task messages: kill a running task, or record
   * 👍/👎 feedback on a delivered result (stored as a memory fact so the
   * nightly consolidation learns from it). Returns a short ack text.
   */
  onTaskAction?: (input: {
    taskId: string
    action: 'kill' | 'feedback_up' | 'feedback_down'
    agentId: string
    userId: string | null
  }) => Promise<string>
  onQueueDepthChanged?: (queueDepth: number) => void
  /** Called for every chat event (user message, response chunks, etc.) for cross-channel sync */
  onChatEvent?: (event: TelegramChatEvent) => void
}

export type TelegramUserStatus = 'pending' | 'approved' | 'rejected'

export interface TelegramUserRow {
  id: number
  telegram_id: string
  telegram_username: string | null
  telegram_display_name: string | null
  status: TelegramUserStatus
  user_id: number | null
  created_at: string
  updated_at: string
}

interface QueuedMessage {
  ctx: Context
  text: string
  attachments?: UploadDescriptor[]
  replyContext?: string
  /**
   * Overrides `text` as the agent-facing message (e.g. `/skill` expands the
   * typed command into the SKILL.md). `text` is still what gets persisted.
   */
  agentText?: string
  preambleToolCalls?: TurnPreambleToolCall[]
}

interface PendingBatch {
  ctx: Context
  text: string
  /** Reply context of the first message in the batch that carried one. */
  replyContext?: string
  timer: ReturnType<typeof setTimeout>
}

interface ChatState {
  pendingBatch: PendingBatch | null
  queue: QueuedMessage[]
  processing: boolean
  abortRequested: boolean
}

/** One turn handed to the shared runner on behalf of a Telegram chat. */
interface TurnRequest {
  chatId: string | number
  agentUserId: string
  userId: number | null
  sessionId: string
  /** Fork multi-persona: the persona this Telegram bot serves. */
  agentId: string
  text: string
  source: string
  attachments?: UploadDescriptor[]
  preambleToolCalls?: TurnPreambleToolCall[]
}

/** What the runner produced, collected for delivery to Telegram. */
interface TurnOutcome {
  text: string
  uploads: UploadDescriptor[]
  error: TurnErrorInfo | null
}

/** Telegram's maximum message length */
const MAX_MESSAGE_LENGTH = 4096

/**
 * Maximum number of characters kept from a replied-to message. Longer texts are
 * truncated with a trailing ellipsis (U+2026) before being stored / forwarded.
 */
const REPLY_CONTEXT_MAX_LENGTH = 500

/**
 * Extract the plain-text excerpt from a Telegram `reply_to_message`, if any.
 * Returns the truncated text (<=500 chars, trailing `…` when truncated) or
 * `undefined` for non-text replies (stickers, voice without caption, …).
 */
export function extractReplyContext(replyTo: unknown): string | undefined {
  if (!replyTo || typeof replyTo !== 'object') return undefined
  const r = replyTo as { text?: unknown; caption?: unknown }
  const raw = (typeof r.text === 'string' && r.text)
    || (typeof r.caption === 'string' && r.caption)
    || ''
  if (!raw) return undefined
  return raw.length > REPLY_CONTEXT_MAX_LENGTH
    ? raw.slice(0, REPLY_CONTEXT_MAX_LENGTH) + '\u2026'
    : raw
}

/**
 * Build the agent-facing prompt string for a Telegram turn. When `replyContext`
 * is present the original user text is prefixed with a `<reply-context>…</reply-context>`
 * wrapper on its own line so the model can see what the user replied to without
 * confusing it with the user's own words. The DB-persisted `content` field
 * stores the user's original text unchanged — the wrapper lives only in the
 * agent-facing string.
 */
export function buildAgentMessage(text: string, replyContext?: string): string {
  if (!replyContext) return text
  return `<reply-context>${replyContext}</reply-context>\n${text}`
}
const STOP_COMMANDS = new Set(['/stop', '/kill'])

/**
 * Render a picker's title + description as the message body. The buttons
 * themselves live in `reply_markup`, so this only handles the lead text.
 */
function formatPickerMessage(picker: SlashCommandPicker): string {
  const lines: string[] = []
  if (picker.title) lines.push(picker.title)
  if (picker.description) lines.push(picker.description)
  return lines.join('\n') || 'Choose an option:'
}

/**
 * Convert standard Markdown to Telegram-compatible HTML.
 * Handles: bold, italic, code, code blocks, links, and escapes HTML entities.
 * Falls back gracefully — if conversion produces invalid HTML, caller should
 * fall back to plain text.
 */
function markdownToTelegramHtml(text: string): string {
  // Interactive blocks (SPEC 7.4c) have no card renderer here: Telegram gets
  // the question as a numbered list (7.11 parity) and the reply is parsed the
  // same way a typed answer is. Raw block JSON must never reach a chat.
  text = renderInteractionMessageAsText(text)

  // Step 1: Extract code blocks and inline code to protect them from other transformations
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // Replace fenced code blocks with placeholders
  let result = text.replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''))
    const block = lang ? `<pre><code class="language-${escapeHtml(lang)}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`
    codeBlocks.push(block)
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`
  })

  // Replace inline code with placeholders
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`)
    return `\x00INLINECODE${inlineCodes.length - 1}\x00`
  })

  // Step 2: Escape HTML entities in the remaining text
  result = escapeHtml(result)

  // Step 3: Apply formatting conversions

  // Headings: # text → bold (Telegram has no heading support)
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

  // Blockquotes: > text → <blockquote>
  // Collect consecutive > lines into a single blockquote
  result = result.replace(/(?:^&gt;\s?(.*)$\n?)+/gm, (match) => {
    const lines = match.split('\n')
      .filter(line => line.startsWith('&gt;'))
      .map(line => line.replace(/^&gt;\s?/, ''))
    return `<blockquote>${lines.join('\n')}</blockquote>\n`
  })

  // Bold+Italic: ***text*** or ___text___
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>')
  result = result.replace(/___(.+?)___/g, '<b><i>$1</i></b>')

  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  result = result.replace(/__(.+?)__/g, '<b>$1</b>')

  // Italic: *text* or _text_ (but not within words for underscores)
  result = result.replace(/(?<!\w)\*([^\n*]+?)\*(?!\w)/g, '<i>$1</i>')
  result = result.replace(/(?<!\w)_([^\n_]+?)_(?!\w)/g, '<i>$1</i>')

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>')

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

  // Step 4: Restore code blocks and inline code.
  // NUL bytes (\x00) are used as placeholder sentinels because they cannot
  // appear in normal Telegram text, so the control characters are intentional.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)])
  // eslint-disable-next-line no-control-regex
  result = result.replace(/\x00INLINECODE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)])

  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function telegramHtmlToPlainText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/**
 * Split a long text into chunks that fit within Telegram's message limit.
 * Tries to split at newline boundaries when possible.
 */
function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text]

  const parts: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining)
      break
    }

    // Try to find a good split point (newline) within the limit
    let splitAt = remaining.lastIndexOf('\n', maxLen)
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // No good newline found; try space
      splitAt = remaining.lastIndexOf(' ', maxLen)
    }
    if (splitAt <= 0 || splitAt < maxLen * 0.5) {
      // Hard split at max length
      splitAt = maxLen
    }

    parts.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }

  return parts
}

/**
 * Get a unique user identifier for session management
 */
function getUserId(ctx: Context): string {
  return `telegram-${ctx.from?.id ?? 'unknown'}`
}

function getChatKey(ctx: Context): string {
  return `telegram-chat-${ctx.chat?.id ?? ctx.from?.id ?? 'unknown'}`
}

function isHandledCommand(text: string): boolean {
  return /^\/(start|new|stop|kill|tts|voice)(?:@[\w_]+)?\b/i.test(text.trim())
}

function isSkillShortcut(text: string): boolean {
  return /^\/skill(?:@[\w_]+)?:/i.test(text.trim())
}

function normalizeCommand(text: string): string {
  return text.trim().split(/\s+/, 1)[0].toLowerCase().replace(/@[\w_]+$/, '')
}

function loadTelegramRuntimeConfig(): TelegramConfig {
  const telegram = loadConfig<TelegramConfig>('telegram.json')
  let batchingDelayMs = telegram.batchingDelayMs
  const isValidDelay = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0

  if (!isValidDelay(batchingDelayMs)) {
    // Legacy fallback: the field used to live at the top level of
    // settings.json. Read it here so an upgrade does not silently revert a
    // customised delay to the 2500 ms default.
    try {
      const settings = loadConfig<{ batchingDelayMs?: number }>('settings.json')
      if (isValidDelay(settings.batchingDelayMs)) {
        batchingDelayMs = settings.batchingDelayMs
      }
    } catch {
      // ignore
    }
  }

  return {
    ...telegram,
    batchingDelayMs: isValidDelay(batchingDelayMs) ? batchingDelayMs : 2500,
  }
}

/**
 * Telegram bot adapter that bridges Telegram messages to Agent Core
 */
export class TelegramBot {
  private bot: Bot
  private agentCore: AgentCore
  private db: Database | null
  private config: TelegramConfig
  private agentId: string
  private startModelTaskCallback?: TelegramBotOptions['startModelTask']
  private onTaskReplyCallback?: TelegramBotOptions['onTaskReply']
  private onActiveProviderChangedCallback?: TelegramBotOptions['onActiveProviderChanged']
  private onTaskActionCallback?: TelegramBotOptions['onTaskAction']
  private draftTaskPlanCallback?: TelegramBotOptions['draftTaskPlan']
  /**
   * Pending plan-approve flows for /fable-style commands, keyed by a
   * one-shot token carried in the ✅/❌ callback data. Entries expire after
   * 15 minutes; bounded like the picker token store.
   */
  private pendingModelTasks = new Map<string, {
    modelId: string
    modelLabel: string
    commandName: string
    prompt: string
    plan: string
    userId: string | null
    expiresAt: number
  }>()
  /**
   * Maps `chatId:messageId` of bot-sent task messages (results, questions,
   * status updates) to their task id, so a Telegram reply to such a message
   * can be routed deterministically to that task. Bounded FIFO (~300).
   */
  private taskMessages = new Map<string, string>()
  private running = false
  private pollingRetryTimer: ReturnType<typeof setTimeout> | null = null
  private pollingRetryDelayMs = POLLING_RETRY_INITIAL_MS
  private chatStates = new Map<string, ChatState>()
  private onQueueDepthChanged?: (queueDepth: number) => void
  private onChatEvent?: (event: TelegramChatEvent) => void
  private slashRegistry: SlashCommandRegistry
  private taskStore: TaskStore | null
  private scheduledTaskStore: ScheduledTaskStore | null
  /**
   * Map of `pick:<token>` callback-data tokens to the verbatim slash command
   * they should re-dispatch when clicked. Bounded by `PICKER_TOKEN_TTL_MS`;
   * pruned opportunistically before each new picker is created so the map
   * doesn't grow unbounded for chats that abandon pickers mid-flow.
   */
  private pickerTokenStore = new Map<string, { command: string; expiresAt: number }>()
  /**
   * Approval prompts we sent, per send-log entry. Needed to edit the buttons
   * away once *any* channel decided. In-memory only — after a restart old
   * prompts stay visible but taps get the "already decided" answer.
   */
  private emailApprovalPrompts = new Map<string, { chatId: string; messageId: number }[]>()
  private emailApproval: EmailApprovalService | null
  private turnRunner: TurnRunner
  private turnRetry: TurnRetryService | null
  private unregisterTurnRetryNotifier: () => void
  /**
   * Retry prompts we sent, per `turn_error` row id, so the keyboard can be
   * edited away once *any* channel answered. In-memory only, like the email
   * approval prompts.
   */
  private retryPrompts = new Map<number, { chatId: string; messageId: number; error: TurnErrorInfo }[]>()

  constructor(options: TelegramBotOptions) {
    this.agentCore = options.agentCore
    this.db = options.db ?? null
    this.config = options.config ?? loadTelegramRuntimeConfig()
    this.agentId = options.agentId ?? 'main'
    this.startModelTaskCallback = options.startModelTask
    this.onTaskReplyCallback = options.onTaskReply
    this.onActiveProviderChangedCallback = options.onActiveProviderChanged
    this.onTaskActionCallback = options.onTaskAction
    this.draftTaskPlanCallback = options.draftTaskPlan
    this.onQueueDepthChanged = options.onQueueDepthChanged
    this.onChatEvent = options.onChatEvent
    this.emailApproval = options.emailApproval ?? (this.db ? createEmailApprovalService({ db: this.db }) : null)
    this.turnRunner = options.turnRunner ?? new TurnRunner({
      db: this.db,
      getAgent: () => this.agentCore,
    })
    this.turnRetry = this.db
      ? createTurnRetryService({ db: this.db, runner: this.turnRunner })
      : null
    this.unregisterTurnRetryNotifier = registerTurnRetryNotifier({
      retryResolved: ({ errorMessageId, resolution }) =>
        this.resolveRetryPrompts(errorMessageId, resolution),
    })
    this.slashRegistry = buildTelegramSlashCommandRegistry()
    this.taskStore = this.db ? new TaskStore(this.db) : null
    this.scheduledTaskStore = this.db ? new ScheduledTaskStore(this.db) : null

    if (!this.config.botToken) {
      throw new Error(
        'Telegram bot token not configured. Set botToken in /data/config/telegram.json or disable Telegram (enabled: false) for web-only mode.'
      )
    }

    this.bot = new Bot(this.config.botToken)
    this.setupHandlers()
    this.setupErrorHandler()
  }

  private getOrCreateChatState(chatKey: string): ChatState {
    const existing = this.chatStates.get(chatKey)
    if (existing) return existing

    const state: ChatState = {
      pendingBatch: null,
      queue: [],
      processing: false,
      abortRequested: false,
    }

    this.chatStates.set(chatKey, state)
    return state
  }

  private cleanupChatState(chatKey: string): void {
    const state = this.chatStates.get(chatKey)
    if (!state) return

    if (!state.processing && !state.pendingBatch && state.queue.length === 0) {
      this.chatStates.delete(chatKey)
    }
  }

  private emitQueueDepthChanged(): void {
    this.onQueueDepthChanged?.(this.getQueueDepth())
  }

  getQueueDepth(): number {
    let total = 0

    for (const state of this.chatStates.values()) {
      total += state.queue.length
      if (state.pendingBatch) total += 1
      if (state.processing) total += 1
    }

    return total
  }

  private setupHandlers(): void {
    // /start command - welcome message
    this.bot.command('start', async (ctx) => {
      // Register the user but don't gate the welcome message
      this.ensureTelegramUser(ctx)

      const welcomeText = [
        '👋 *Welcome to Offtangent!*',
        '',
        'I\'m your AI assistant. You can chat with me directly or type /help to see all available commands.',
        '',
        'Just send me a message to get started!',
      ].join('\n')

      await ctx.reply(welcomeText, { parse_mode: 'Markdown' })
    })

    // /new command - summarize + reset session
    this.bot.command('new', async (ctx) => {
      if (!await this.checkAuthorized(ctx)) return

      const userId = this.resolveUserId(ctx)

      try {
        // Use resetSessionAsync (NOT handleNewCommand): it synchronously calls
        // runtime.clearMessages(), so a poisoned in-memory context (e.g. an
        // orphaned tool_result that wedges every provider — incident
        // 2026-07-20) is actually cleared. handleNewCommand only rotates the
        // session id and would leave the corrupted context in place. The
        // session summary still runs in the background via onSessionEnd.
        this.agentCore.resetSessionAsync(userId, 'telegram', this.agentId)
        await ctx.reply('🔄 Starting fresh conversation!')
      } catch (err) {
        console.error('Error handling /new command:', err)
        await ctx.reply('⚠️ Error resetting session. Please try again.')
      }
    })

    this.bot.command('stop', async (ctx) => {
      await this.handleKillSwitch(ctx)
    })

    this.bot.command('kill', async (ctx) => {
      await this.handleKillSwitch(ctx)
    })

    this.bot.command('help', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'help')
    })
    this.bot.command('tasks', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'tasks')
    })
    this.bot.command('cronjobs', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'cronjobs')
    })
    this.bot.command('cron', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'cron')
    })
    this.bot.command('thinking', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'thinking')
    })
    this.bot.command('model', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'model')
    })
    this.bot.command('provider', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'provider')
    })
    this.bot.command('tts', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'tts')
    })
    this.bot.command('voice', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'voice')
    })
    this.bot.command('skill', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'skill')
    })

    // Model-pinned task prefix commands (/fable …) — one-off background
    // tasks on a heavy model, default chat model stays unchanged. With a
    // plan drafter available, a cheap plan is shown for ✅/❌ approval
    // before the heavy model starts.
    for (const spec of MODEL_TASK_COMMANDS) {
      this.bot.command(spec.name, async (ctx) => {
        await this.handleModelTaskCommand(ctx, spec)
      })
    }

    this.bot.command('offline', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'offline')
    })
    this.bot.command('online', async (ctx) => {
      await this.handleRegistryCommand(ctx, 'online')
    })

    // Inline-keyboard button taps from picker messages (e.g. /model).
    // The original message is edited in place to either show the next
    // picker step or the final text confirmation.
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data
      if (data.startsWith(TASK_CALLBACK_PREFIX)) {
        await this.handleTaskCallback(ctx, data.slice(TASK_CALLBACK_PREFIX.length))
        return
      }
      if (data.startsWith(EMAIL_APPROVAL_CALLBACK_PREFIX)) {
        await this.handleEmailApprovalCallback(ctx, data)
        return
      }
      if (data.startsWith(TURN_RETRY_CALLBACK_PREFIX)) {
        await this.handleTurnRetryCallback(ctx, data)
        return
      }
      if (!data.startsWith(PICKER_CALLBACK_PREFIX)) return
      await this.handlePickerCallback(ctx, data.slice(PICKER_CALLBACK_PREFIX.length))
    })

    this.bot.on('message:text', async (ctx) => {
      await this.handleMessage(ctx)
    })

    this.bot.on('message:document', async (ctx) => {
      await this.handleIncomingAttachment(ctx, 'document')
    })

    this.bot.on('message:photo', async (ctx) => {
      await this.handleIncomingAttachment(ctx, 'photo')
    })

    this.bot.on('message:voice', async (ctx) => {
      await this.handleVoiceMessage(ctx)
    })
  }

  private ensureTelegramUser(ctx: Context): TelegramUserRow | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const username = ctx.from.username ?? null
    const displayName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || null

    const existing = this.db.prepare(
      'SELECT * FROM telegram_users WHERE telegram_id = ?'
    ).get(telegramId) as TelegramUserRow | undefined

    if (existing) {
      // Update username/display name if changed
      if (existing.telegram_username !== username || existing.telegram_display_name !== displayName) {
        this.db.prepare(
          "UPDATE telegram_users SET telegram_username = ?, telegram_display_name = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(username, displayName, existing.id)
      }
      // Refresh avatar if we don't have one yet
      if (!this.hasAvatarFile(telegramId)) {
        this.fetchAndSaveAvatar(ctx.from.id).catch(() => {})
      }
      return existing
    }

    // Insert new pending user
    const result = this.db.prepare(
      'INSERT INTO telegram_users (telegram_id, telegram_username, telegram_display_name, status) VALUES (?, ?, ?, ?)'
    ).run(telegramId, username, displayName, 'pending')

    console.log(`[telegram] New user registered as pending: ${username ?? displayName ?? telegramId}`)

    // Fetch avatar in the background (don't block registration)
    this.fetchAndSaveAvatar(ctx.from.id).catch(() => {})

    return this.db.prepare(
      'SELECT * FROM telegram_users WHERE id = ?'
    ).get(result.lastInsertRowid) as TelegramUserRow
  }

  private hasAvatarFile(telegramId: string): boolean {
    const avatarDir = path.join(process.env.DATA_DIR ?? '/data', 'avatars')
    try {
      const files = fs.readdirSync(avatarDir)
      return files.some(f => f.startsWith(`telegram-${telegramId}.`))
    } catch {
      return false
    }
  }

  private async fetchAndSaveAvatar(telegramId: number): Promise<void> {
    try {
      const photos = await this.bot.api.getUserProfilePhotos(telegramId, { limit: 1 })
      if (!photos.total_count || !photos.photos[0]?.length) return

      // Pick the smallest size that's at least 160px (good for avatars)
      const sizes = photos.photos[0]
      const photo = sizes.find(s => s.width >= 160) ?? sizes[sizes.length - 1]

      const file = await this.bot.api.getFile(photo.file_id)
      if (!file.file_path) return

      const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
      const response = await fetch(url)
      if (!response.ok) return

      const avatarDir = path.join(process.env.DATA_DIR ?? '/data', 'avatars')
      fs.mkdirSync(avatarDir, { recursive: true })

      const ext = file.file_path.split('.').pop() ?? 'jpg'
      const avatarPath = path.join(avatarDir, `telegram-${telegramId}.${ext}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      fs.writeFileSync(avatarPath, buffer)

      console.log(`[telegram] Avatar saved for user ${telegramId}`)
    } catch (err) {
      console.warn(`[telegram] Could not fetch avatar for ${telegramId}:`, (err as Error).message)
    }
  }

  private async checkAuthorized(ctx: Context): Promise<boolean> {
    if (!this.db) return true // No db = no access control

    const user = this.ensureTelegramUser(ctx)
    if (!user) return true

    if (user.status === 'approved') return true

    if (user.status === 'pending') {
      await this.safeSendMessage(ctx, '⏳ Your access request has been sent to the administrator. Please wait for approval.')
      return false
    }

    // rejected — silently ignore
    return false
  }

  private resolveUserId(ctx: Context): string {
    if (!this.db || !ctx.from) return getUserId(ctx)

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(telegramId, 'approved') as { user_id: number | null } | undefined

    if (row?.user_id) {
      return String(row.user_id)
    }

    return getUserId(ctx)
  }

  private resolveNumericUserId(ctx: Context): number | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(telegramId, 'approved') as { user_id: number | null } | undefined

    return row?.user_id ?? null
  }

  private getSenderName(ctx: Context): string {
    const from = ctx.from
    if (!from) return 'Unknown'
    if (from.username) return `@${from.username}`
    return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown'
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const text = ctx.message?.text
    if (!text) return

    const normalizedCommand = normalizeCommand(text)
    if (STOP_COMMANDS.has(normalizedCommand)) {
      await this.handleKillSwitch(ctx)
      return
    }

    if (isHandledCommand(text)) {
      return
    }

    // `/skill:<name>` only reaches here when Telegram did not emit a
    // bot_command entity for it (entity parsing stops at `:`), so route it
    // to the registry explicitly instead of treating it as chat text.
    if (isSkillShortcut(text)) {
      await this.handleRegistryCommand(ctx, 'skill')
      return
    }

    if (!await this.checkAuthorized(ctx)) return

    // Deterministic task routing: a reply to a bot message that belongs to a
    // background task goes straight to that task (resume / follow-up),
    // bypassing the chat agent entirely.
    const replyMsgId = ctx.message?.reply_to_message?.message_id
    if (replyMsgId !== undefined && this.onTaskReplyCallback && ctx.chat) {
      const taskId = this.taskMessages.get(`${ctx.chat.id}:${replyMsgId}`)
      if (taskId) {
        try {
          const reply = await this.onTaskReplyCallback({
            taskId,
            text,
            agentId: this.agentId,
            userId: this.resolveUserId(ctx),
            source: 'telegram',
          })
          const sent = await ctx.reply(reply)
          // Follow-up confirmations reference the (new) task too, so the
          // user can keep threading replies.
          this.rememberTaskMessage(ctx.chat.id, sent.message_id, taskId)
        } catch (err) {
          await this.safeSendMessage(ctx, `⚠️ ${(err as Error).message}`)
        }
        return
      }
    }

    const replyContext = extractReplyContext(ctx.message?.reply_to_message)
    this.bufferMessage(ctx, text, replyContext)
  }

  /**
   * /fable-style command: draft a plan (cheap model), ask for ✅/❌
   * approval, then start the pinned heavy-model task. Falls back to
   * starting directly when no plan drafter is wired or drafting fails.
   */
  private async handleModelTaskCommand(
    ctx: Context,
    spec: { name: string; modelId: string; modelLabel: string },
  ): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return

    const text = ctx.message?.text ?? ''
    const prompt = text.replace(/^\/[\w_]+(?:@[\w_]+)?\s*/, '').trim()
    if (!prompt) {
      await this.safeSendMessage(ctx, `Usage: /${spec.name} <prompt>\nRuns the request as a background task on ${spec.modelLabel}; the result is posted back into this chat.`)
      return
    }
    if (!this.startModelTaskCallback) {
      await this.safeSendMessage(ctx, `/${spec.name} is not available.`)
      return
    }

    const userId = this.resolveUserId(ctx)

    // No plan drafter → start directly (previous behavior).
    if (!this.draftTaskPlanCallback) {
      await this.startModelTaskAndConfirm(ctx, spec, prompt, undefined, userId)
      return
    }

    try {
      await ctx.replyWithChatAction('typing')
      const plan = await this.draftTaskPlanCallback({ prompt, agentId: this.agentId, userId })

      const token = crypto.randomBytes(8).toString('hex')
      // Bounded: prune expired entries opportunistically.
      const nowMs = Date.now()
      for (const [key, entry] of this.pendingModelTasks) {
        if (entry.expiresAt <= nowMs) this.pendingModelTasks.delete(key)
      }
      if (this.pendingModelTasks.size >= 50) {
        const oldest = this.pendingModelTasks.keys().next().value
        if (oldest) this.pendingModelTasks.delete(oldest)
      }
      this.pendingModelTasks.set(token, {
        modelId: spec.modelId,
        modelLabel: spec.modelLabel,
        commandName: spec.name,
        prompt,
        plan,
        userId,
        expiresAt: nowMs + 15 * 60_000,
      })

      const keyboard = new InlineKeyboard()
        .text(`✅ Start on ${spec.modelLabel}`, `${TASK_CALLBACK_PREFIX}plan_go:${token}`)
        .text('❌ Cancel', `${TASK_CALLBACK_PREFIX}plan_x:${token}`)
      await ctx.reply(`📋 Plan for ${spec.modelLabel}:\n\n${plan}`, { reply_markup: keyboard })
    } catch (err) {
      // Plan drafting failed — fall back to direct start rather than block.
      console.warn(`[telegram] Plan drafting failed for /${spec.name}, starting directly:`, (err as Error).message)
      await this.startModelTaskAndConfirm(ctx, spec, prompt, undefined, userId)
    }
  }

  /** Start a pinned-model task and send the confirmation (reply-threadable). */
  private async startModelTaskAndConfirm(
    ctx: Context,
    spec: { name: string; modelId: string; modelLabel: string },
    prompt: string,
    plan: string | undefined,
    userId: string | null,
  ): Promise<void> {
    const taskPrompt = plan
      ? `${prompt}\n\n<suggested_plan>\nA triage model drafted this plan — review it and adapt where it falls short:\n${plan}\n</suggested_plan>`
      : prompt
    try {
      const result = await this.startModelTaskCallback!({
        modelId: spec.modelId,
        prompt: taskPrompt,
        agentId: this.agentId,
        userId,
        source: 'telegram',
      })
      const sent = await ctx.reply(`🚀 Task started on ${result.providerName} (${result.modelId}).\n\nTask: ${result.taskName}\nID: ${result.taskId}\n\nThe result will be posted here when it finishes.`)
      if (ctx.chat) this.rememberTaskMessage(ctx.chat.id, sent.message_id, result.taskId)
    } catch (err) {
      await this.safeSendMessage(ctx, `⚠️ ${(err as Error).message}`)
    }
  }

  /**
   * Handle `tsk:<action>:<taskId>` inline-button taps on task messages.
   */
  private async handleTaskCallback(ctx: Context, payload: string): Promise<void> {
    const sep = payload.indexOf(':')
    const action = sep === -1 ? payload : payload.slice(0, sep)
    const taskId = sep === -1 ? '' : payload.slice(sep + 1)

    if (!await this.checkAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true })
      return
    }

    // Plan-approve buttons carry a pending-task token instead of a task id.
    if (action === 'plan_go' || action === 'plan_x') {
      await this.handlePlanCallback(ctx, action, taskId)
      return
    }

    if (!taskId || !['kill', 'feedback_up', 'feedback_down'].includes(action) || !this.onTaskActionCallback) {
      await ctx.answerCallbackQuery({ text: 'Action not available.', show_alert: true })
      return
    }

    try {
      const ack = await this.onTaskActionCallback({
        taskId,
        action: action as 'kill' | 'feedback_up' | 'feedback_down',
        agentId: this.agentId,
        userId: this.resolveUserId(ctx),
      })
      await ctx.answerCallbackQuery({ text: ack.slice(0, 190) })
      // Feedback / kill is one-shot — drop the keyboard so buttons can't be re-tapped.
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }) } catch { /* ignore */ }
    } catch (err) {
      await ctx.answerCallbackQuery({ text: `⚠️ ${(err as Error).message}`.slice(0, 190), show_alert: true })
    }
  }

  /** Handle ✅/❌ taps on a plan-approve message. */
  private async handlePlanCallback(ctx: Context, action: 'plan_go' | 'plan_x', token: string): Promise<void> {
    const pending = this.pendingModelTasks.get(token)
    if (!pending || pending.expiresAt <= Date.now()) {
      await ctx.answerCallbackQuery({ text: 'This plan has expired — run the command again.', show_alert: true })
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }) } catch { /* ignore */ }
      return
    }
    this.pendingModelTasks.delete(token)
    await ctx.answerCallbackQuery()

    if (action === 'plan_x') {
      try { await ctx.editMessageText(`❌ Cancelled.\n\n📋 Plan was:\n${pending.plan}`) } catch { /* ignore */ }
      return
    }

    // Keep the plan visible, drop the buttons, then start the task.
    try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }) } catch { /* ignore */ }
    await this.startModelTaskAndConfirm(
      ctx,
      { name: pending.commandName, modelId: pending.modelId, modelLabel: pending.modelLabel },
      pending.prompt,
      pending.plan,
      pending.userId,
    )
  }

  /** Inline keyboard with 👍/👎 feedback buttons for a delivered task result. */
  private buildFeedbackKeyboard(taskId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('👍', `${TASK_CALLBACK_PREFIX}feedback_up:${taskId}`)
      .text('👎', `${TASK_CALLBACK_PREFIX}feedback_down:${taskId}`)
  }

  /** Inline keyboard with a kill button for a still-running task. */
  private buildTaskControlKeyboard(taskId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('🗑 Kill task', `${TASK_CALLBACK_PREFIX}kill:${taskId}`)
  }

  /** Record a bot-sent message as belonging to a task (bounded FIFO). */
  private rememberTaskMessage(chatId: string | number, messageId: number, taskId: string): void {
    const key = `${chatId}:${messageId}`
    if (this.taskMessages.size >= 300) {
      const oldest = this.taskMessages.keys().next().value
      if (oldest) this.taskMessages.delete(oldest)
    }
    this.taskMessages.set(key, taskId)
  }

  private async downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; mimeType?: string }> {
    const file = await this.bot.api.getFile(fileId)
    if (!file.file_path) throw new Error('Missing Telegram file path')
    const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`
    const response = await fetch(url)
    if (!response.ok) throw new Error('Failed to download Telegram file')
    return { buffer: Buffer.from(await response.arrayBuffer()) }
  }

  private async handleIncomingAttachment(ctx: Context, kind: 'document' | 'photo'): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return

    const userId = this.resolveUserId(ctx)
    const numericUserId = this.resolveNumericUserId(ctx)
    const caption = ctx.msg?.caption?.trim() ?? ''
    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(userId, 'telegram', this.agentId)
    const sessionId = smSession.id

    try {
      let upload
      if (kind === 'document' && ctx.message?.document) {
        const payload = await this.downloadTelegramFile(ctx.message.document.file_id)
        upload = saveUpload({
          buffer: payload.buffer,
          originalName: ctx.message.document.file_name ?? 'document',
          mimeType: ctx.message.document.mime_type ?? 'application/octet-stream',
          source: 'telegram',
          userId: numericUserId,
          sessionId,
        })
      } else if (kind === 'photo' && ctx.message?.photo?.length) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1]
        const payload = await this.downloadTelegramFile(photo.file_id)
        upload = saveUpload({
          buffer: payload.buffer,
          originalName: 'telegram-photo.jpg',
          mimeType: 'image/jpeg',
          source: 'telegram',
          userId: numericUserId,
          sessionId,
        })
      }

      if (!upload) return

      const messageText = caption || upload.originalName

      if (this.db && numericUserId) {
        this.db.prepare('INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(sessionId, numericUserId, 'user', messageText, serializeUploadsMetadata([upload]), this.agentId)
      }

      this.onChatEvent?.({ type: 'user_message', userId: numericUserId, sessionId, text: messageText, senderName: this.getSenderName(ctx), agentId: this.agentId })

      // Route to agent for processing (same path as text messages)
      const chatKey = getChatKey(ctx)
      const state = this.getOrCreateChatState(chatKey)
      state.queue.push({ ctx, text: messageText, attachments: [upload] })
      this.emitQueueDepthChanged()
      await this.processQueue(chatKey)
    } catch (err) {
      console.error('Error handling Telegram attachment:', err)
      await this.safeSendMessage(ctx, '⚠️ Datei konnte nicht gespeichert werden.')
    }
  }

  private async maybeSendVoiceReply(chatId: string | number, text: string): Promise<void> {
    const telegramConfig = loadConfig<{ sendVoiceReply?: boolean }>('telegram.json')
    if (!telegramConfig.sendVoiceReply) return

    // Strip Markdown-y tokens so the synthesized speech is clean. Same set
    // as the web TTS route applies; kept inline here so we don't need to
    // pull a markdown helper into the telegram package just for this.
    const stripped = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/^[-*+]\s+/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!stripped) return

    // 2000-char cap matches Deepgram's /v1/speak ceiling; OpenAI and Mistral
    // tolerate more but a uniform cap keeps the audio short enough to feel
    // like a voice message rather than an audiobook.
    if (stripped.length > 2000) {
      console.warn(`[telegram] Voice reply skipped: text length ${stripped.length} exceeds 2000 char limit.`)
      return
    }

    let result
    try {
      // Bounded: the TTS HTTP call has no own timeout, and a hang here would
      // wedge this chat's message loop (same failure class as 2026-07-19).
      result = await withTimeout(synthesizeTts(stripped), 60_000, 'TTS voice reply')
    } catch (err) {
      console.warn(`[telegram] Voice reply skipped: ${(err as Error).message}`)
      return
    }

    const filename = `voice.${result.extension}`
    const inputFile = new InputFile(result.audio, filename)

    // Only OGG/Opus renders as the native Telegram voice bubble; everything
    // else (mp3/wav/etc) goes via sendAudio.
    if (result.extension === 'ogg') {
      await this.bot.api.sendVoice(chatId, inputFile)
    } else {
      await this.bot.api.sendAudio(chatId, inputFile)
    }
  }

  private async handleVoiceMessage(ctx: Context): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return

    // Check if STT is enabled — silently ignore voice messages when disabled
    const sttSettings = loadSttSettings()
    if (!sttSettings.enabled) return

    try {
      const voice = ctx.message?.voice
      if (!voice) return

      // Download OGG audio from Telegram
      const { buffer } = await this.downloadTelegramFile(voice.file_id)

      // Resolve language from settings: if "match", "auto", or empty, omit language param
      const settings = loadConfig<Record<string, unknown>>('settings.json')
      const settingsLanguage = (settings.language as string) ?? ''
      const autoLanguages = ['match', 'auto', '']
      const language = autoLanguages.includes(settingsLanguage.toLowerCase())
        ? undefined
        : settingsLanguage

      // Transcribe via core STT module
      const result = await transcribeAudio(buffer, { language, filename: 'audio.ogg' })
      const transcript = result.rewritten ?? result.transcript

      if (!transcript.trim()) {
        console.warn('[telegram] Voice transcription returned empty result')
        return
      }

      // Prefix with voice indicator and process as normal message
      const text = `🎤 Voice: ${transcript.trim()}`
      this.bufferMessage(ctx, text)
    } catch (err) {
      console.error('[telegram] Voice transcription error:', err)
      await this.safeSendMessage(ctx, '⚠️ Could not transcribe voice message. Please try again or send a text message.')
    }
  }

  private bufferMessage(ctx: Context, text: string, replyContext?: string): void {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)

    if (state.pendingBatch) {
      clearTimeout(state.pendingBatch.timer)
      state.pendingBatch = {
        ctx,
        text: `${state.pendingBatch.text}\n${text}`,
        // Keep the first reply context we saw in this batch; later messages in
        // the same batch don't usually come with their own reply and would
        // otherwise drop the context.
        replyContext: state.pendingBatch.replyContext ?? replyContext,
        timer: this.createBatchTimer(chatKey),
      }
    } else {
      state.pendingBatch = {
        ctx,
        text,
        replyContext,
        timer: this.createBatchTimer(chatKey),
      }
    }

    this.emitQueueDepthChanged()
  }

  private createBatchTimer(chatKey: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      void this.flushPendingBatch(chatKey)
    }, this.config.batchingDelayMs)
  }

  private async flushPendingBatch(chatKey: string): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state?.pendingBatch) return

    const batch = state.pendingBatch
    state.pendingBatch = null
    state.queue.push({ ctx: batch.ctx, text: batch.text, replyContext: batch.replyContext })
    this.emitQueueDepthChanged()

    await this.processQueue(chatKey)
  }

  private async processQueue(chatKey: string): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state || state.processing) return

    state.processing = true
    this.emitQueueDepthChanged()

    try {
      while (state.queue.length > 0) {
        const queuedMessage = state.queue.shift()!
        this.emitQueueDepthChanged()
        await this.processQueuedMessage(chatKey, queuedMessage)
      }
    } finally {
      state.processing = false
      state.abortRequested = false
      this.emitQueueDepthChanged()
      this.cleanupChatState(chatKey)
    }
  }

  private async sendUploadToTelegram(chatId: string | number, file: ReturnType<typeof parseUploadsMetadata>[number]): Promise<void> {
    const absolutePath = path.join(process.env.DATA_DIR ?? '/data', 'uploads', file.relativePath)
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Upload file not found: ${file.relativePath}`)
    }

    const inputFile = new InputFile(absolutePath, file.originalName)
    if (file.kind === 'image') {
      await this.bot.api.sendPhoto(chatId, inputFile)
    } else {
      await this.bot.api.sendDocument(chatId, inputFile)
    }
  }

  private async sendAssistantResponseToTelegram(chatId: string | number, text: string, uploads: ReturnType<typeof parseUploadsMetadata>): Promise<void> {
    for (const file of uploads) {
      try {
        await this.sendUploadToTelegram(chatId, file)
      } catch (err) {
        console.error(`[telegram] Failed to send assistant upload to ${chatId}:`, err)
      }
    }

    if (text.trim()) {
      await this.sendLongMessageToChatId(chatId, text.trim())
    }
  }

  private async sendLongMessageToChatId(chatId: string | number, text: string): Promise<void> {
    // Degrade interactive blocks before splitting, so the plain-text fallback
    // inside `sendPlainOrFormatted` carries the numbered list as well.
    const parts = splitMessage(renderInteractionMessageAsText(text))
    for (const part of parts) {
      await this.sendPlainOrFormatted(chatId, part)
    }
  }

  private async sendPlainOrFormatted(chatId: string | number, text: string): Promise<void> {
    const htmlText = markdownToTelegramHtml(text)
    try {
      await this.bot.api.sendMessage(chatId, htmlText, { parse_mode: 'HTML' })
    } catch {
      await this.bot.api.sendMessage(chatId, text)
    }
  }

  private resolveUsername(ctx: Context): string | null {
    if (!this.db || !ctx.from) return null

    const telegramId = String(ctx.from.id)
    const row = this.db.prepare(
      `SELECT u.username FROM users u
       JOIN telegram_users tu ON tu.user_id = u.id
       WHERE tu.telegram_id = ? AND tu.status = 'approved'`
    ).get(telegramId) as { username: string } | undefined

    return row?.username ?? null
  }

  private isDMChat(ctx: Context): boolean {
    return ctx.chat?.type === 'private'
  }

  private async processQueuedMessage(chatKey: string, queuedMessage: QueuedMessage): Promise<void> {
    const state = this.chatStates.get(chatKey)
    if (!state) return

    const { ctx, text, attachments, replyContext, agentText, preambleToolCalls } = queuedMessage
    const agentUserId = this.resolveUserId(ctx)
    const numericUserId = this.resolveNumericUserId(ctx)
    // Agent sees the reply context wrapped as a pseudo-system hint on its own
    // line; the DB-stored `content` remains exactly what the user typed.
    const messageForAgent = buildAgentMessage(agentText ?? text, replyContext)
    const senderName = this.getSenderName(ctx)

    const isDM = this.isDMChat(ctx)

    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    // Fork: persona-aware session (pass this.agentId as the 3rd arg). Upstream
    // 0.27.0 renamed the local user id to `agentUserId` (from resolveUserId).
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(agentUserId, 'telegram', this.agentId)
    const sessionId = smSession.id

    // Save user message to chat_messages (if linked to a web user)
    // Skip if this came from handleIncomingAttachment (already saved).
    // When a reply context is present we stash it in the metadata JSON blob so
    // the web UI can render a WhatsApp/Telegram-style quote bubble on reload.
    if (this.db && numericUserId && !attachments?.length) {
      const metadata = replyContext ? JSON.stringify({ replyContext }) : null
      this.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionId, numericUserId, 'user', text, metadata, this.agentId)
    }

    // Broadcast user message event (skip if already broadcast by attachment
    // handler). Only the inbound message needs this: the assistant side of the
    // turn reaches other channels through their own runner subscription.
    if (!attachments?.length) {
      this.onChatEvent?.({
        type: 'user_message',
        userId: numericUserId,
        sessionId,
        agentId: this.agentId,
        text,
        senderName,
        replyContext,
      })
    }

    const chatId = ctx.chat!.id

    try {
      await ctx.replyWithChatAction('typing')

      // Set up a typing indicator interval (every 4 seconds)
      const typingInterval = setInterval(async () => {
        try {
          await ctx.replyWithChatAction('typing')
        } catch {
          // Ignore typing indicator errors
        }
      }, 4000)

      let outcome: TurnOutcome
      try {
        // Merge (upstream 0.27.0): the streaming loop, persistence, stall
        // watchdog and auto-retry now live in the shared TurnRunner, driven via
        // consumeTurn(). Persona attribution flows through `agentId: this.agentId`
        // in the TurnRequest, so chat_messages rows and cross-channel events
        // keep their per-persona agent_id (the fork's inline loop did this
        // manually; the runner now does it for us).
        outcome = await this.consumeTurn({
          chatId,
          agentUserId,
          userId: numericUserId,
          sessionId,
          agentId: this.agentId,
          text: messageForAgent,
          source: isDM ? 'telegram' : 'telegram-group',
          attachments,
          preambleToolCalls,
        })
      } finally {
        clearInterval(typingInterval)
      }

      if (state.abortRequested) return

      if (outcome.text.trim() || outcome.uploads.length > 0) {
        await this.sendAssistantResponseToTelegram(chatId, outcome.text, outcome.uploads)
        // Optional Deepgram voice reply. Best-effort: a TTS failure must never
        // suppress the text response or abort the turn.
        if (outcome.text.trim()) {
          try {
            await this.maybeSendVoiceReply(chatId, outcome.text)
          } catch (ttsErr) {
            console.warn('[telegram] Voice reply failed (text already sent):', (ttsErr as Error).message)
          }
        }
      } else if (!state.abortRequested) {
        // Empty turn: the model produced neither text nor uploads and no
        // error chunk (which would have landed in fullResponse). Silence is
        // never an acceptable reply to a direct user message — incident
        // 2026-07-20 (overnight provider degradation → empty turns).
        console.warn(`[telegram] Empty turn for chat ${chatKey} — sending fallback notice to user`)
        await this.safeSendMessage(ctx, '⚠️ Ich habe zu deiner Nachricht keine Antwort erzeugt (leerer Modell-Turn). Bitte sende sie noch einmal.')
      }
      // Merge: assistant/tool/thinking rows are now persisted by the shared
      // TurnRunner (with agent_id = this.agentId), so the fork's manual
      // chat_messages INSERT here is removed to avoid double-persisting.
      // A failed turn must never end silently: the error text plus its Retry
      // button are delivered regardless of the stall-warning setting.
      if (outcome.error) await this.sendTurnErrorPrompt(chatId, outcome.error)

    } catch (err) {
      if (state.abortRequested) {
        return
      }

      console.error('Error processing Telegram message:', err)
      await this.safeSendMessage(ctx, '\u26A0\uFE0F Sorry, I encountered an error processing your message. Please try again.')
    }
  }

  /**
   * Run one turn through the shared {@link TurnRunner} and collect what
   * Telegram needs to render. The runner owns streaming, persistence, the
   * stall watchdog and auto-retry; this only translates its events into
   * Telegram messages.
   *
   * Subscribing right after `startTurn` is safe (the turn is scheduled on a
   * microtask, so no event can be missed) and lets us drop replayed events of
   * an older turn by turn id.
   */
  private consumeTurn(input: TurnRequest): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolve) => {
      const outcome: TurnOutcome = { text: '', uploads: [], error: null }

      const turn = this.turnRunner.startTurn({
        userId: input.userId,
        agentUserId: input.agentUserId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        text: input.text,
        source: input.source,
        attachments: input.attachments,
        preambleToolCalls: input.preambleToolCalls,
      })

      const detach = this.turnRunner.subscribe(input.agentUserId, (event: TurnEvent) => {
        if (event.turnId !== turn.turnId) return

        if (event.type === 'attachment') {
          outcome.uploads.push(event.attachment)
          this.onChatEvent?.({
            type: 'attachment',
            userId: input.userId,
            sessionId: input.sessionId,
            agentId: input.agentId,
            attachment: event.attachment,
          })
          return
        }

        if (event.type === 'chunk') {
          this.handleTurnChunk(input.chatId, event.chunk, outcome)
          return
        }

        if (event.type === 'turn_end') {
          detach()
          resolve(outcome)
        }
      })
    })
  }

  private handleTurnChunk(chatId: string | number, chunk: ResponseChunk, outcome: TurnOutcome): void {
    if (chunk.type === 'text' && chunk.text) {
      outcome.text += chunk.text
      return
    }

    if (chunk.type === 'error' && chunk.errorInfo) {
      outcome.error = chunk.errorInfo
      return
    }

    // Transient provider status. Opt-in (default off) so a flaky provider does
    // not spam the chat; the terminal error above is never gated.
    if (chunk.type === 'stall_warning' || chunk.type === 'stall_resolved' || chunk.type === 'retry_scheduled') {
      if (!chunk.text || !this.stallWarningsEnabled()) return
      void this.sendPlainOrFormatted(chatId, chunk.text).catch((err) => {
        console.error('[telegram] Failed to deliver provider status notice:', err)
      })
    }
  }

  /**
   * Read fresh from `telegram.json` so toggling the setting takes effect
   * without restarting the bot.
   */
  private stallWarningsEnabled(): boolean {
    try {
      return loadConfig<{ sendStallWarnings?: boolean }>('telegram.json').sendStallWarnings === true
    } catch (err) {
      warnConfigReadFailed('telegram.json', err)
      return false
    }
  }

  private async handleRegistryCommand(ctx: Context, name: string): Promise<void> {
    if (!await this.checkAuthorized(ctx)) return
    const text = ctx.message?.text ?? `/${name}`
    const userId = this.resolveUserId(ctx)
    // Provider changes must rebuild the agent core, which restarts this bot —
    // defer the actual callback until AFTER the confirmation reply is sent.
    let providerChangePending = false
    const result = await this.slashRegistry.dispatch(text, {
      surface: 'telegram',
      userId,
      registry: this.slashRegistry,
      db: this.db ?? undefined,
      taskStore: this.taskStore ?? undefined,
      scheduledTaskStore: this.scheduledTaskStore ?? undefined,
      agentId: this.agentId,
      startModelTask: this.startModelTaskCallback
        ? (input) => this.startModelTaskCallback!({
            ...input,
            agentId: this.agentId,
            userId,
            source: 'telegram',
          })
        : undefined,
      onActiveProviderChanged: () => { providerChangePending = true },
      onThinkingLevelChanged: (level) => this.agentCore.setThinkingLevel(level),
    })
    const fireDeferred = () => {
      if (providerChangePending) {
        providerChangePending = false
        this.onActiveProviderChangedCallback?.()
      }
    }
    if (result.kind === 'handled') {
      if (isSlashCommandPicker(result.reply)) {
        await this.sendPicker(ctx, result.reply)
        fireDeferred()
        return
      }
      if (isSlashCommandAgentTurn(result.reply)) {
        await this.enqueueAgentTurn(ctx, text, result.reply)
        return
      }
      if (result.reply) await ctx.reply(result.reply)
      fireDeferred()
      return
    }
    if (result.kind === 'not_found') {
      await ctx.reply(`Unknown command: /${result.name}. Try /help.`)
      return
    }
    if (result.kind === 'wrong_surface') {
      await ctx.reply(`/${result.command.name} is not available on Telegram.`)
      return
    }
    await ctx.reply(`Cannot handle /${name}.`)
  }

  /**
   * Run a slash command's expanded text as a regular agent turn. Bypasses
   * the batching delay (the command is complete as-is) but still goes through
   * the per-chat queue so it serialises with in-flight messages.
   */
  private async enqueueAgentTurn(ctx: Context, typedText: string, reply: SlashCommandAgentTurn): Promise<void> {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)
    state.queue.push({
      ctx,
      text: typedText,
      agentText: reply.text,
      preambleToolCalls: reply.toolCall ? [reply.toolCall] : undefined,
    })
    this.emitQueueDepthChanged()
    await this.processQueue(chatKey)
  }

  /**
   * Render a slash-command picker as an inline keyboard. Each option becomes
   * one button row; clicking re-dispatches its verbatim slash command via
   * `handlePickerCallback`.
   */
  private async sendPicker(ctx: Context, picker: SlashCommandPicker): Promise<void> {
    const text = formatPickerMessage(picker)
    const keyboard = this.buildPickerKeyboard(picker)
    await ctx.reply(text, { reply_markup: keyboard })
  }

  /**
   * Build a fresh inline keyboard for `picker`, registering each option's
   * slash command under a short token in `pickerTokenStore`.
   */
  private buildPickerKeyboard(picker: SlashCommandPicker): InlineKeyboard {
    this.prunePickerTokens()
    const keyboard = new InlineKeyboard()
    for (const opt of picker.options) {
      const token = this.registerPickerToken(opt.command)
      const label = opt.badge ? `${opt.label} \u2022 ${opt.badge}` : opt.label
      keyboard.text(label, `${PICKER_CALLBACK_PREFIX}${token}`).row()
    }
    return keyboard
  }

  private registerPickerToken(command: string): string {
    // 8 hex chars = 4 bytes of entropy. Plenty for short-lived per-user tokens
    // and well under Telegram's 64-byte callback-data limit.
    let token = crypto.randomBytes(4).toString('hex')
    // Vanishingly unlikely collision, but be robust anyway.
    while (this.pickerTokenStore.has(token)) {
      token = crypto.randomBytes(4).toString('hex')
    }
    this.pickerTokenStore.set(token, { command, expiresAt: Date.now() + PICKER_TOKEN_TTL_MS })
    return token
  }

  private prunePickerTokens(): void {
    const now = Date.now()
    for (const [token, entry] of this.pickerTokenStore) {
      if (entry.expiresAt <= now) this.pickerTokenStore.delete(token)
    }
  }

  /**
   * Resolve a `pick:<token>` callback into a re-dispatch of the original
   * slash command. Edits the source message in place to show the next
   * picker (or final text), so the chat doesn't accumulate stale keyboards.
   */
  private async handlePickerCallback(ctx: Context, token: string): Promise<void> {
    const entry = this.pickerTokenStore.get(token)
    if (!entry || entry.expiresAt <= Date.now()) {
      await ctx.answerCallbackQuery({ text: 'This menu has expired. Run the command again.', show_alert: true })
      // Best-effort: strip the keyboard so the user can't re-tap stale buttons.
      try { await ctx.editMessageReplyMarkup({ reply_markup: undefined }) } catch { /* ignore */ }
      return
    }

    if (!await this.checkAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true })
      return
    }

    // One-shot: each token is consumed on first use. The next picker step
    // generates a fresh batch of tokens.
    this.pickerTokenStore.delete(token)
    await ctx.answerCallbackQuery()

    const userId = this.resolveUserId(ctx)
    // Deferred like in handleRegistryCommand: the rebuild restarts this bot,
    // so it must not fire before the confirmation message edit went out.
    let providerChangePending = false
    const result = await this.slashRegistry.dispatch(entry.command, {
      surface: 'telegram',
      userId,
      registry: this.slashRegistry,
      db: this.db ?? undefined,
      taskStore: this.taskStore ?? undefined,
      scheduledTaskStore: this.scheduledTaskStore ?? undefined,
      agentId: this.agentId,
      onActiveProviderChanged: () => { providerChangePending = true },
      onThinkingLevelChanged: (level) => this.agentCore.setThinkingLevel(level),
    })

    if (result.kind !== 'handled') {
      await this.editPickerMessage(ctx, `\u26A0\uFE0F Could not handle that selection.`)
      return
    }

    if (isSlashCommandPicker(result.reply)) {
      // Next step — swap the message in place with a fresh keyboard.
      await this.editPickerMessage(
        ctx,
        formatPickerMessage(result.reply),
        this.buildPickerKeyboard(result.reply),
      )
      return
    }

    if (isSlashCommandAgentTurn(result.reply)) {
      // Two-step flow (e.g. /skill): the tap loads the skill, the agent
      // acknowledges, and the user's next message carries the actual request.
      await this.editPickerMessage(ctx, result.reply.label ?? entry.command)
      await this.enqueueAgentTurn(ctx, entry.command, result.reply)
      return
    }

    // Final text reply (confirmation, error, no-op). Drop the keyboard.
    await this.editPickerMessage(ctx, result.reply ?? '\u2705 Done.')
    if (providerChangePending) {
      this.onActiveProviderChangedCallback?.()
    }
  }

  /**
   * Edit the source message of a callback query, falling back to a new
   * message if Telegram refuses (e.g. message too old, content unchanged).
   */
  private async editPickerMessage(
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    try {
      await ctx.editMessageText(text, { reply_markup: keyboard })
    } catch (err) {
      // "message is not modified" is harmless and shouldn't be a fallback trigger.
      if (err instanceof GrammyError && /message is not modified/i.test(err.description)) return
      try {
        await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined)
      } catch (replyErr) {
        console.error('Failed to deliver picker reply:', replyErr)
      }
    }
  }

  /**
   * Hooks the bot into the core approval boundary: new pending emails get an
   * Accept/Cancel prompt, and every decision — no matter which channel made
   * it — edits that prompt into a result message without buttons.
   */
  createEmailApprovalNotifier(): EmailApprovalNotifier {
    return {
      approvalRequested: entry => this.sendEmailApprovalPrompt(entry),
      approvalResolved: entry => this.resolveEmailApprovalPrompts(entry),
    }
  }

  private approvedTelegramChatIds(): string[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      'SELECT telegram_id FROM telegram_users WHERE status = ?',
    ).all('approved') as { telegram_id: string }[]
    return rows.map(row => row.telegram_id)
  }

  private async sendEmailApprovalPrompt(entry: EmailSendLogEntry): Promise<void> {
    if (entry.status !== 'pending') return

    const chatIds = this.approvedTelegramChatIds()
    if (chatIds.length === 0) return

    const text = formatEmailApprovalRequest(entry)
    const keyboard = new InlineKeyboard()
      .text('✅ Accept', buildEmailApprovalCallbackData('approve', entry.id))
      .text('❌ Cancel', buildEmailApprovalCallbackData('reject', entry.id))

    const prompts: { chatId: string; messageId: number }[] = []

    for (const chatId of chatIds) {
      try {
        const message = await this.bot.api.sendMessage(chatId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        prompts.push({ chatId, messageId: message.message_id })
      } catch (err) {
        console.error(`[telegram] Failed to send email approval prompt to ${chatId}:`, err)
      }
    }

    if (prompts.length > 0) this.emailApprovalPrompts.set(entry.id, prompts)
  }

  private async resolveEmailApprovalPrompts(
    entry: EmailSendLogEntry,
    fallback?: { chatId: string; messageId: number }[],
  ): Promise<void> {
    const prompts = this.emailApprovalPrompts.get(entry.id) ?? fallback ?? []
    this.emailApprovalPrompts.delete(entry.id)
    if (prompts.length === 0) return

    const text = formatEmailApprovalResolution(entry)

    for (const prompt of prompts) {
      try {
        await this.bot.api.editMessageText(prompt.chatId, prompt.messageId, text, { parse_mode: 'HTML' })
      } catch (err) {
        if (err instanceof GrammyError && /message is not modified/i.test(err.description)) continue
        console.error(`[telegram] Failed to update email approval prompt in ${prompt.chatId}:`, err)
      }
    }
  }

  /**
   * Announce a terminal turn failure in the chat, with the Retry button that
   * repeats the turn server-side. The button carries the persisted error row
   * id, so the freshness rules (session still open, nothing newer in the
   * transcript, no running turn) are the exact same ones the web chat applies.
   */
  private async sendTurnErrorPrompt(chatId: string | number, error: TurnErrorInfo): Promise<void> {
    const text = formatTurnErrorMessage(error)
    const canRetry = this.turnRetry !== null && error.messageId !== undefined

    try {
      const message = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        ...(canRetry
          ? { reply_markup: new InlineKeyboard().text('\uD83D\uDD04 Retry', buildTurnRetryCallbackData(error.messageId!)) }
          : {}),
      })

      if (!canRetry) return
      const prompts = this.retryPrompts.get(error.messageId!) ?? []
      prompts.push({ chatId: String(chatId), messageId: message.message_id, error })
      this.retryPrompts.set(error.messageId!, prompts)
    } catch (err) {
      console.error(`[telegram] Failed to send turn error prompt to ${chatId}:`, err)
    }
  }

  /**
   * Drop the keyboard once the retry was answered — in this chat or in any
   * other channel (the core notifier is what makes that cross-channel).
   */
  private async resolveRetryPrompts(errorMessageId: number, resolution: string): Promise<void> {
    const prompts = this.retryPrompts.get(errorMessageId)
    if (!prompts || prompts.length === 0) return
    this.retryPrompts.delete(errorMessageId)

    for (const prompt of prompts) {
      try {
        await this.bot.api.editMessageText(
          prompt.chatId,
          prompt.messageId,
          formatTurnRetryResolution(prompt.error, resolution),
          { parse_mode: 'HTML' },
        )
      } catch (err) {
        if (err instanceof GrammyError && /message is not modified/i.test(err.description)) continue
        console.error(`[telegram] Failed to update retry prompt in ${prompt.chatId}:`, err)
      }
    }
  }

  private async handleTurnRetryCallback(ctx: Context, data: string): Promise<void> {
    const parsed = parseTurnRetryCallbackData(data)
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'Unknown action.', show_alert: true })
      return
    }

    if (!await this.checkAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true })
      return
    }

    if (!this.turnRetry) {
      await ctx.answerCallbackQuery({ text: 'Retry is not available.', show_alert: true })
      return
    }

    // The turn streams into this chat through the runner subscription opened
    // below; the retry service only decides whether it may start at all.
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id
    const pending = chatId !== undefined ? this.subscribeToRetriedTurn(chatId, parsed.errorMessageId) : null

    const outcome = this.turnRetry.retry(parsed.errorMessageId)
    if (!outcome.ok) pending?.cancel()

    // Deliberately not awaiting the retried turn: grammY processes updates
    // sequentially, so blocking here would freeze the bot for its duration.
    await ctx.answerCallbackQuery(
      outcome.ok ? { text: outcome.resolution } : { text: outcome.resolution, show_alert: true },
    )
  }

  /**
   * Attach to the turn the retry is about to start so its answer lands in the
   * Telegram chat that tapped the button. Nothing is started here — the retry
   * service owns that decision.
   */
  private subscribeToRetriedTurn(
    chatId: string | number,
    errorMessageId: number,
  ): { cancel: () => void } | null {
    if (!this.db) return null

    const row = this.db.prepare(
      'SELECT user_id FROM chat_messages WHERE id = ?',
    ).get(errorMessageId) as { user_id: number | null } | undefined
    if (!row?.user_id) return null

    const agentUserId = String(row.user_id)
    const outcome: TurnOutcome = { text: '', uploads: [], error: null }
    let turnId: string | null = null

    const detach = this.turnRunner.subscribe(agentUserId, (event: TurnEvent) => {
      // The retry runs as a brand new turn, and the service refused to start
      // one while another was active — so the first non-replayed event after
      // the tap belongs to it. Latching on any event type (not just
      // `turn_start`) matters: a turn that fails before it starts (no agent)
      // only emits its error and `turn_end`, and missing those would leak this
      // subscription into the user's next turn.
      if (event.replay) return
      if (turnId === null) turnId = event.turnId
      if (event.turnId !== turnId) return

      if (event.type === 'attachment') {
        outcome.uploads.push(event.attachment)
        return
      }
      if (event.type === 'chunk') {
        this.handleTurnChunk(chatId, event.chunk, outcome)
        return
      }
      if (event.type === 'turn_end') {
        detach()
        void this.deliverRetriedTurn(chatId, outcome)
      }
    })

    // A refused retry never starts a turn, so the subscription has to be
    // dropped by hand or it would swallow the user's next turn.
    return { cancel: detach }
  }

  private async deliverRetriedTurn(chatId: string | number, outcome: TurnOutcome): Promise<void> {
    try {
      if (outcome.text.trim() || outcome.uploads.length > 0) {
        await this.sendAssistantResponseToTelegram(chatId, outcome.text, outcome.uploads)
      }
      if (outcome.error) await this.sendTurnErrorPrompt(chatId, outcome.error)
    } catch (err) {
      console.error(`[telegram] Failed to deliver retried turn to ${chatId}:`, err)
    }
  }

  private deciderName(ctx: Context): string {
    const from = ctx.from
    if (!from) return 'Telegram'
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
    return displayName || from.username || `telegram-${from.id}`
  }

  private async handleEmailApprovalCallback(ctx: Context, data: string): Promise<void> {
    const parsed = parseEmailApprovalCallbackData(data)
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'Unknown action.', show_alert: true })
      return
    }

    if (!await this.checkAuthorized(ctx)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true })
      return
    }

    if (!this.emailApproval) {
      await ctx.answerCallbackQuery({ text: 'Email approval is not available.', show_alert: true })
      return
    }

    // Captured before the decision because the resolved-notifier consumes the
    // map entry while `approve()` is still running.
    const prompts = this.emailApprovalPrompts.get(parsed.entryId)

    const decider = { name: this.deciderName(ctx) }
    const result = parsed.action === 'approve'
      ? await this.emailApproval.approve(parsed.entryId, decider)
      : await this.emailApproval.reject(parsed.entryId, decider)

    if (result.ok) {
      await ctx.answerCallbackQuery({
        text: parsed.action === 'approve' ? 'Email approved.' : 'Email rejected.',
      })
    } else {
      await ctx.answerCallbackQuery({ text: result.message, show_alert: true })
    }

    if (result.entry) await this.resolveEmailApprovalPrompts(result.entry, prompts)
  }

  private async handleKillSwitch(ctx: Context): Promise<void> {
    const chatKey = getChatKey(ctx)
    const state = this.getOrCreateChatState(chatKey)
    const hadActiveTask = state.processing
    const removedQueuedMessages = state.queue.length + (state.pendingBatch ? 1 : 0)

    if (state.pendingBatch) {
      clearTimeout(state.pendingBatch.timer)
      state.pendingBatch = null
    }

    state.queue = []
    state.abortRequested = hadActiveTask
    this.emitQueueDepthChanged()

    if (hadActiveTask) {
      try {
        this.turnRunner.abortTurn(this.resolveUserId(ctx))
      } catch (err) {
        console.error('Error aborting Telegram task:', err)
      }
    }

    const confirmation = !hadActiveTask && removedQueuedMessages === 0
      ? 'Nothing to stop.'
      : removedQueuedMessages === 0
        ? 'Task aborted. No queued messages.'
        : `⛔ Aborted. ${removedQueuedMessages} messages removed from queue.`

    await this.safeSendMessage(ctx, confirmation)
    this.cleanupChatState(chatKey)
  }

  private async sendLongMessage(ctx: Context, text: string): Promise<void> {
    // Same degradation as `sendLongMessageToChatId`: the plain-text retry in
    // `safeSendMessage` must not fall back to raw block JSON.
    const parts = splitMessage(renderInteractionMessageAsText(text))

    for (const part of parts) {
      await this.safeSendMessage(ctx, part)
    }
  }

  private async safeSendMessage(ctx: Context, text: string, retries = 2): Promise<void> {
    // Try sending with HTML formatting first
    const htmlText = markdownToTelegramHtml(text)
    const attempts: Array<{ text: string; parseMode?: 'HTML' }> = [
      { text: htmlText, parseMode: 'HTML' },
      { text }, // fallback: plain text, no parse_mode
    ]

    for (const { text: msgText, parseMode } of attempts) {
      let succeeded = false
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          if (parseMode) {
            await ctx.reply(msgText, { parse_mode: parseMode })
          } else {
            await ctx.reply(msgText)
          }
          succeeded = true
          return
        } catch (err) {
          if (err instanceof GrammyError) {
            // Handle rate limiting
            if (err.error_code === 429) {
              const retryAfter = (err.parameters?.retry_after ?? 5) * 1000
              console.warn(`Telegram rate limited. Retrying after ${retryAfter}ms`)
              await sleep(retryAfter)
              continue
            }

            // Bad Request (parse error) — skip to plain text fallback
            if (err.error_code === 400 && parseMode) {
              console.warn(`Telegram HTML parse error, falling back to plain text: ${err.description}`)
              break
            }

            // Other Telegram API errors
            console.error(`Telegram API error (${err.error_code}): ${err.description}`)
          } else if (err instanceof HttpError) {
            console.error('Telegram network error:', err.message)
            if (attempt < retries) {
              await sleep(1000 * (attempt + 1))
              continue
            }
          }

          // If we've exhausted retries or it's a non-retriable error, give up
          if (attempt === retries) {
            console.error('Failed to send Telegram message after retries:', err)
          }
        }
      }
      if (succeeded) return
    }
  }

  private setupErrorHandler(): void {
    this.bot.catch((err) => {
      const ctx = err.ctx
      const e = err.error

      console.error(`Error while handling update ${ctx.update.update_id}:`)

      if (e instanceof GrammyError) {
        console.error(`Grammy error (${e.error_code}): ${e.description}`)
      } else if (e instanceof HttpError) {
        console.error('HTTP error:', e.message)
      } else {
        console.error('Unknown error:', e)
      }
    })
  }

  async start(): Promise<void> {
    if (this.running) {
      console.warn('Telegram bot is already running')
      return
    }

    try {
      // Verify the bot token by fetching bot info
      const me = await this.bot.api.getMe()
      console.log(`✅ Telegram bot connected: @${me.username} (${me.first_name})`)

      try {
        const menu = this.slashRegistry
          .list('telegram')
          .map((c) => ({ command: c.name, description: c.description.slice(0, 256) }))
        if (menu.length > 0) await this.bot.api.setMyCommands(menu)
      } catch (err) {
        console.warn('[telegram] setMyCommands failed (menu may be missing):', (err as Error).message)
      }

      // A leftover webhook registration makes getUpdates fail with 409,
      // so always clear it before switching to polling.
      try {
        await this.bot.api.deleteWebhook({ drop_pending_updates: true })
      } catch (err) {
        console.warn('[telegram] deleteWebhook failed (continuing):', (err as Error).message)
      }

      this.running = true
      this.startPolling()
    } catch (err) {
      this.running = false
      if (err instanceof GrammyError) {
        throw new Error(`Failed to start Telegram bot: ${err.description} (code ${err.error_code})`)
      }
      throw new Error(`Failed to start Telegram bot: ${(err as Error).message}`)
    }
  }

  /**
   * grammY rethrows 401/409 out of its polling loop instead of retrying, and
   * `bot.start()` resolves only when the bot stops — so its rejection must be
   * handled here or it crashes the whole process as an unhandled rejection.
   * 409 Conflict is usually transient (the previous instance's long poll is
   * still open right after a restart), so we retry with backoff instead of
   * letting the server die and crash-loop the container.
   */
  private startPolling(): void {
    Promise.resolve(
      this.bot.start({
        onStart: () => {
          this.pollingRetryDelayMs = POLLING_RETRY_INITIAL_MS
          console.log('🤖 Telegram bot started in polling mode')
        },
        drop_pending_updates: true,
      }),
    ).catch((err: unknown) => this.handlePollingFailure(err))
  }

  private handlePollingFailure(err: unknown): void {
    if (!this.running) return

    if (err instanceof GrammyError && err.error_code === 401) {
      this.running = false
      console.error('[telegram] Bot token rejected (401 Unauthorized) — Telegram bot stopped. Update the token in Settings.')
      return
    }

    const reason = err instanceof GrammyError
      ? `${err.error_code}: ${err.description}`
      : (err as Error)?.message ?? String(err)
    const delayMs = this.pollingRetryDelayMs
    this.pollingRetryDelayMs = Math.min(this.pollingRetryDelayMs * 2, POLLING_RETRY_MAX_MS)
    console.warn(`[telegram] Polling stopped (${reason}) — restarting in ${Math.round(delayMs / 1000)}s...`)

    this.pollingRetryTimer = setTimeout(() => {
      this.pollingRetryTimer = null
      if (!this.running) return
      this.startPolling()
    }, delayMs)
    this.pollingRetryTimer.unref?.()
  }

  async stop(): Promise<void> {
    // Detach from the process-global retry boundary first: a bot whose start
    // failed never set `running`, and leaving it registered would let a dead
    // instance answer resolutions for the one that replaced it.
    this.unregisterTurnRetryNotifier()

    if (!this.running) return

    this.running = false
    if (this.pollingRetryTimer) {
      clearTimeout(this.pollingRetryTimer)
      this.pollingRetryTimer = null
    }
    try {
      await this.bot.stop()
    } catch (err) {
      // Ignore errors during stop (e.g. 409 Conflict when another instance started polling)
      console.warn('[telegram] Error during bot stop (ignored):', (err as Error).message)
    }
    console.log('🛑 Telegram bot stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  private syncOutgoingMessageToWeb(chatId: string | number, text: string): void {
    if (!this.db) return

    const normalizedChatId = String(chatId)
    const row = this.db.prepare(
      'SELECT user_id FROM telegram_users WHERE telegram_id = ? AND status = ?'
    ).get(normalizedChatId, 'approved') as { user_id: number | null } | undefined

    const userId = row?.user_id ?? null
    if (!userId) return

    // Resolve session ID from SessionManager (aligns chat_messages with session tracking)
    const smSession = this.agentCore.getSessionManager().getOrCreateSession(String(userId), 'telegram', this.agentId)
    const sessionId = smSession.id

    try {
      this.db.prepare(
        'INSERT INTO chat_messages (session_id, user_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)'
      ).run(sessionId, userId, 'assistant', text, this.agentId)
    } catch (err) {
      console.error(`[telegram] Failed to persist outbound Telegram message for user ${userId}:`, err)
    }

    this.onChatEvent?.({
      type: 'text',
      userId,
      sessionId,
      agentId: this.agentId,
      text,
    })
    this.onChatEvent?.({
      type: 'done',
      userId,
      sessionId,
      agentId: this.agentId,
    })
  }

  // fallow-ignore-next-line unused-class-member
  async sendDirectMessage(chatId: string | number, text: string): Promise<boolean> {
    try {
      await this.bot.api.sendMessage(chatId, text)
      this.syncOutgoingMessageToWeb(chatId, text)
      return true
    } catch (err) {
      console.error(`[telegram] Failed to send direct message to ${chatId}:`, err)
      return false
    }
  }

  // Public cross-workspace API used by web-backend; Fallow cannot see this in clean CI before workspace dist files exist.
  // fallow-ignore-next-line unused-class-member
  async sendTaskNotification(chatId: string | number, html: string, taskId?: string): Promise<boolean> {
    const parts = splitMessage(html)
    const plainFull = telegramHtmlToPlainText(html)

    for (const [index, part] of parts.entries()) {
      // Status updates describe a still-running task — offer a kill button
      // on the last part.
      const replyMarkup = taskId && index === parts.length - 1
        ? this.buildTaskControlKeyboard(taskId)
        : undefined
      try {
        const sent = await this.bot.api.sendMessage(chatId, part, { parse_mode: 'HTML', reply_markup: replyMarkup })
        if (taskId) this.rememberTaskMessage(chatId, sent.message_id, taskId)
      } catch {
        // Fallback to plain text if HTML parsing fails
        try {
          const plainPart = telegramHtmlToPlainText(part)
          const sent = await this.bot.api.sendMessage(chatId, plainPart, { reply_markup: replyMarkup })
          if (taskId) this.rememberTaskMessage(chatId, sent.message_id, taskId)
        } catch (fallbackErr) {
          console.error(`[telegram] Failed to send task notification to ${chatId}:`, fallbackErr)
          return false
        }
      }
    }

    this.syncOutgoingMessageToWeb(chatId, plainFull)
    return true
  }

  // Public cross-workspace API used by web-backend; Fallow cannot see this in clean CI before workspace dist files exist.
  // fallow-ignore-next-line unused-class-member
  getTelegramChatIdForUser(userId: number): string | null {
    if (!this.db) return null

    const row = this.db.prepare(
      'SELECT telegram_id FROM telegram_users WHERE user_id = ? AND status = ?'
    ).get(userId, 'approved') as { telegram_id: string } | undefined

    return row?.telegram_id ?? null
  }

  // Public cross-workspace API used by web-backend; Fallow cannot see this in clean CI before workspace dist files exist.
  // fallow-ignore-next-line unused-class-member
  async sendFormattedMessage(chatId: string | number, markdown: string, taskId?: string): Promise<boolean> {
    const parts = splitMessage(markdown)

    for (const [index, part] of parts.entries()) {
      // Feedback buttons on the LAST part of a task result, so 👍/👎 sits
      // directly under the delivered content.
      const replyMarkup = taskId && index === parts.length - 1
        ? this.buildFeedbackKeyboard(taskId)
        : undefined
      try {
        const html = markdownToTelegramHtml(part)
        const sent = await this.bot.api.sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: replyMarkup })
        if (taskId) this.rememberTaskMessage(chatId, sent.message_id, taskId)
      } catch {
        try {
          const sent = await this.bot.api.sendMessage(chatId, part, { reply_markup: replyMarkup })
          if (taskId) this.rememberTaskMessage(chatId, sent.message_id, taskId)
        } catch (err) {
          console.error(`[telegram] Failed to send formatted message to ${chatId}:`, err)
          return false
        }
      }
    }

    return true
  }

  getBot(): Bot {
    return this.bot
  }

  /** Agent ID this bot instance represents (multi-persona routing). */
  getAgentId(): string {
    return this.agentId
  }
}

/**
 * Create a Telegram bot if configured, or return null for web-only mode.
 * Does not throw if Telegram is disabled or not configured.
 */
export function createTelegramBot(
  agentCore: AgentCore,
  db?: Database,
  onChatEvent?: (event: TelegramChatEvent) => void,
  onQueueDepthChanged?: (queueDepth: number) => void,
  // Fork: `extras` is the full options bag (startModelTask, onTaskReply, ...).
  // Upstream 0.27.0 added `turnRunner`; since it is already part of
  // TelegramBotOptions, it is carried through `extras.turnRunner`.
  extras?: Omit<TelegramBotOptions, 'agentCore' | 'db' | 'config' | 'onChatEvent' | 'onQueueDepthChanged'>,
): TelegramBot | null {
  try {
    const config = loadTelegramRuntimeConfig()

    if (!config.enabled) {
      console.log('ℹ️  Telegram bot disabled in config (enabled: false). Running in web-only mode.')
      return null
    }

    if (!config.botToken) {
      console.log('ℹ️  No Telegram bot token configured. Running in web-only mode.')
      return null
    }

    return new TelegramBot({ agentCore, db, config, onChatEvent, onQueueDepthChanged, ...extras })
  } catch {
    console.log('ℹ️  Telegram config not found. Running in web-only mode.')
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildTelegramSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistryCtor()
  registerBuiltInSlashCommands(registry)
  registry.register({
    name: 'start',
    description: 'Welcome message and bot introduction.',
    surfaces: ['telegram'],
  })
  registry.register({
    name: 'new',
    description: 'Summarize the current session and start a fresh conversation.',
    surfaces: ['web', 'telegram'],
  })
  registry.register({
    name: 'stop',
    aliases: ['kill'],
    description: 'Abort the current agent turn and clear queued work.',
    surfaces: ['web', 'telegram'],
  })
  registry.register({
    name: 'tts',
    aliases: ['voice'],
    description: 'Toggle automatic Telegram voice replies.',
    surfaces: ['telegram'],
    handler: (ctx) => handleTelegramVoiceCommand(ctx.args),
  })
  return registry
}

function handleTelegramVoiceCommand(args: string): string {
  const config = loadConfig<Record<string, unknown>>('telegram.json')
  const current = config.sendVoiceReply === true
  const arg = args.trim().toLowerCase()

  if (arg === 'status') {
    return `🔊 Telegram voice replies are ${current ? 'enabled' : 'disabled'}. Global TTS settings are unchanged.`
  }

  let next: boolean
  if (!arg) {
    next = !current
  } else if (['on', 'enable', 'enabled', 'true', '1', 'yes'].includes(arg)) {
    next = true
  } else if (['off', 'disable', 'disabled', 'false', '0', 'no'].includes(arg)) {
    next = false
  } else {
    return 'Usage: /tts [on|off|status]'
  }

  const nextConfig = { ...config, sendVoiceReply: next }
  const filePath = path.join(getConfigDir(), 'telegram.json')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf-8')

  return next
    ? '🔊 Telegram voice replies enabled. Text replies will still be sent first.'
    : '🔇 Telegram voice replies disabled. Global TTS settings are unchanged.'
}
