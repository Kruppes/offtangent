import { loadConfig, loadMultiPersonaSettings } from '@axiom/core'
import type { AgentCore, Database } from '@axiom/core'
import { TelegramBot } from './bot.js'
import type { TelegramConfig, TelegramChatEvent, TelegramBotOptions } from './bot.js'

/**
 * Account entry in the v2 multi-persona telegram config.
 */
export interface TelegramAccountConfig {
  botToken: string
  agentId: string
  adminUserIds: number[]
  enabled?: boolean
}

/**
 * v2 Telegram config that supports multiple bot accounts.
 * When multiPersona is disabled, there's only one account with agentId 'main'.
 */
export interface TelegramPoolConfig {
  accounts: Record<string, TelegramAccountConfig>
  /** Shared settings */
  pollingMode?: boolean
  webhookUrl?: string
  batchingDelayMs?: number
}

export interface TelegramBotPoolOptions {
  agentCore: AgentCore
  db?: Database
  onQueueDepthChanged?: (queueDepth: number) => void
  onChatEvent?: (event: TelegramChatEvent) => void
  startModelTask?: TelegramBotOptions['startModelTask']
  onTaskReply?: TelegramBotOptions['onTaskReply']
  onActiveProviderChanged?: TelegramBotOptions['onActiveProviderChanged']
  onTaskAction?: TelegramBotOptions['onTaskAction']
  draftTaskPlan?: TelegramBotOptions['draftTaskPlan']
  /**
   * Upstream 0.27.0: the shared process-wide TurnRunner. Passing it lets every
   * persona bot reuse the same runner (turns are keyed by agentUserId, so
   * personas stay isolated) and keeps 'main' cross-channel with web chat.
   */
  turnRunner?: TelegramBotOptions['turnRunner']
}

/**
 * Normalize a v1 (single-bot) or v2 (multi-bot) telegram.json config
 * into a uniform TelegramPoolConfig.
 *
 * If multiPersona is disabled, always returns a single-account pool with agentId 'main'.
 */
export function normalizeToPoolConfig(): TelegramPoolConfig {
  const multiPersona = loadMultiPersonaSettings()

  interface RawTelegramConfig {
    enabled?: boolean
    botToken?: string
    adminUserIds?: number[]
    pollingMode?: boolean
    webhookUrl?: string
    batchingDelayMs?: number
    accounts?: Record<string, TelegramAccountConfig>
  }

  let raw: RawTelegramConfig
  try {
    raw = loadConfig<RawTelegramConfig>('telegram.json')
  } catch {
    return { accounts: {} }
  }

  // If multiPersona is disabled OR no accounts block exists → treat as v1 (single bot)
  if (!multiPersona.enabled || !raw.accounts) {
    if (!raw.enabled || !raw.botToken) {
      return {
        accounts: {},
        pollingMode: raw.pollingMode,
        webhookUrl: raw.webhookUrl,
        batchingDelayMs: raw.batchingDelayMs,
      }
    }

    return {
      accounts: {
        main: {
          botToken: raw.botToken,
          agentId: 'main',
          adminUserIds: raw.adminUserIds ?? [],
          enabled: raw.enabled,
        },
      },
      pollingMode: raw.pollingMode,
      webhookUrl: raw.webhookUrl,
      batchingDelayMs: raw.batchingDelayMs,
    }
  }

  // v2: multi-persona mode with accounts block
  return {
    accounts: raw.accounts,
    pollingMode: raw.pollingMode,
    webhookUrl: raw.webhookUrl,
    batchingDelayMs: raw.batchingDelayMs,
  }
}

/**
 * Manages multiple TelegramBot instances, one per persona account.
 * When multi-persona is disabled, behaves exactly like a single TelegramBot.
 */
export class TelegramBotPool {
  private bots = new Map<string, TelegramBot>()
  private options: TelegramBotPoolOptions

  constructor(options: TelegramBotPoolOptions) {
    this.options = options
  }

  /**
   * Build and start all configured bot instances.
   * Reads telegram.json and multiPersona settings to determine which bots to start.
   */
  async start(): Promise<void> {
    const poolConfig = normalizeToPoolConfig()
    const batchingDelayMs = poolConfig.batchingDelayMs ?? 2500

    for (const [accountKey, account] of Object.entries(poolConfig.accounts)) {
      if (account.enabled === false) continue
      if (!account.botToken) {
        console.log(`[telegram-pool] Skipping account "${accountKey}": no bot token`)
        continue
      }

      const agentId = account.agentId ?? accountKey

      const config: TelegramConfig = {
        enabled: true,
        botToken: account.botToken,
        adminUserIds: account.adminUserIds ?? [],
        pollingMode: poolConfig.pollingMode ?? true,
        webhookUrl: poolConfig.webhookUrl ?? '',
        batchingDelayMs,
      }

      try {
        const bot = new TelegramBot({
          agentCore: this.options.agentCore,
          db: this.options.db,
          config,
          agentId,
          onQueueDepthChanged: this.options.onQueueDepthChanged,
          onChatEvent: this.options.onChatEvent,
          startModelTask: this.options.startModelTask,
          onTaskReply: this.options.onTaskReply,
          onActiveProviderChanged: this.options.onActiveProviderChanged,
          onTaskAction: this.options.onTaskAction,
          draftTaskPlan: this.options.draftTaskPlan,
          turnRunner: this.options.turnRunner,
        })

        await bot.start()
        this.bots.set(agentId, bot)
        console.log(`[telegram-pool] Bot for agent "${agentId}" started`)
      } catch (err) {
        console.error(`[telegram-pool] Failed to start bot for agent "${agentId}":`, err)
      }
    }

    if (this.bots.size === 0) {
      console.log('[telegram-pool] No bots started (disabled or not configured)')
    }
  }

  /**
   * Stop all running bot instances.
   */
  async stop(): Promise<void> {
    const stopPromises: Promise<void>[] = []
    for (const [agentId, bot] of this.bots) {
      stopPromises.push(
        bot.stop().catch(err => {
          console.warn(`[telegram-pool] Error stopping bot "${agentId}":`, (err as Error).message)
        })
      )
    }
    await Promise.all(stopPromises)
    this.bots.clear()
  }

  /**
   * Get a bot by agent ID.
   */
  getBot(agentId: string): TelegramBot | null {
    return this.bots.get(agentId) ?? null
  }

  /**
   * Get the primary bot (agentId 'main'), or the first available bot.
   * This provides backwards compatibility for code that expects a single bot.
   */
  getPrimaryBot(): TelegramBot | null {
    return this.bots.get('main') ?? (this.bots.size > 0 ? this.bots.values().next().value ?? null : null)
  }

  /**
   * Get all running bots.
   */
  getAllBots(): Map<string, TelegramBot> {
    return new Map(this.bots)
  }

  /**
   * Check if any bots are running.
   */
  hasRunningBots(): boolean {
    return this.bots.size > 0
  }

  /**
   * Total queue depth across all bots.
   */
  getQueueDepth(): number {
    let total = 0
    for (const bot of this.bots.values()) {
      total += bot.getQueueDepth()
    }
    return total
  }
}

/**
 * Create a TelegramBotPool.
 * If multi-persona is disabled, the pool will contain at most one bot (equivalent to the old behavior).
 * Returns null if no bots could be configured.
 */
export function createTelegramBotPool(options: TelegramBotPoolOptions): TelegramBotPool {
  return new TelegramBotPool(options)
}
