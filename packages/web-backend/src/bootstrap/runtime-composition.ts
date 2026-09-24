import { effectiveModelForStrand, parseTurnModelSelection } from '../model-selection.js'
import {
  AgentCore,
  backfillMemoryEmbeddings,
  refreshMemoryPageIndex,
  withTimeout,
  AgentHeartbeatService,
  buildModel,
  createBaseAgentTools,
  createCronjobTool,
  createReminderTool,
  createSendFileTool,
  createResumeTaskTool,
  createTaskRuntime,
  createTaskTool,
  loadSttSettings,
  deliverTaskStatusUpdate,
  resolveTaskStrandOrigin,
  resolveTaskOwnerUserId,
  parseStrictUserId,
  editCronjobTool,
  ensureConfigStructure,
  ensureConfigTemplates,
  ensureMemoryStructure,
  ensurePersonaMemoryRoots,
  getMemoryDir,
  getActiveModelId,
  getActiveProvider,
  getApiKeyForProvider,
  getCronjobTool,
  getFallbackModelId,
  getFallbackProvider,
  initDatabase,
  injectSecretsIntoEnv,
  listCronjobsTool,
  listTasksTool,
  loadConfig,
  storeFact,
  loadMultiPersonaSettings,
  loadProvidersDecrypted,
  syncNewCatalogModels,
  resolveProviderModelInput,
  logToolCall,
  parseProviderModelId,
  getProviderDefaultModel,
  ProviderManager,
  SessionManager,
  createEmailApprovalService,
  registerEmailApprovalNotifier,
  removeCronjobTool,
  TaskEventBus,
  TurnRunner,
  recoverOAuthAfterAuthFailure,
  resolveEffectiveModel,
} from '@axiom/core'
import type {
  BuiltinToolsConfig,
  Database,
  LoopDetectionConfig,
  ProviderConfig,
  SendFileDelivery,
  StartModelTaskResult,
  Task,
  TaskOrigin,
  TaskRuntimeBoundary,
  TaskRuntimeTaskBoundary,
} from '@axiom/core'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { completeSimple } from '@axiom/core'
// W5/P3: close out feed-only outcomes that are too old to still announce.
import { expireStaleTaskNotices } from '@axiom/core'
import { getCurrentTaskAgentId, getCurrentTaskExecutionContext, resolveTaskDefaultProvider as resolveTaskDefaultProviderChain } from '@axiom/core'
import { resolveRoleSpec } from '@axiom/core'
import { resolveTaskModelRoleFrom } from '@axiom/core'
import type { TaskModelPolicyHit, TaskModelRoleKind } from '@axiom/core'
import { randomUUID } from 'node:crypto'
import { createTelegramBot, createTelegramBotPool } from '@axiom/telegram'
import type { TelegramBot, TelegramBotPool, TelegramChatEvent } from '@axiom/telegram'
import { ChatEventBus } from '../chat-event-bus.js'
import { deliverTaskFile } from '../task-file-delivery.js'
import { TaskInjectionTranscript } from '../task-injection-response.js'
import { ChatActionRegistry } from '../chat-actions.js'
import { registerEmailApprovalChatChannel } from '../email-approval-chat.js'
import { registerTurnRetryChatChannel } from '../turn-retry-chat.js'
import type { TurnRetryChatChannel } from '../turn-retry-chat.js'
import { triggerFactExtractionForSessionEnd } from '../fact-extraction-session-end.js'
import { triggerProjectAssignment } from '../project-assignment-trigger.js'
import { HealthMonitorService } from '../health-monitor.js'
import { MemoryConsolidationScheduler } from '../memory-consolidation-scheduler.js'
import { QuotaMonitorService } from '../quota-monitor.js'
import { RuntimeMetrics } from '../runtime-metrics.js'
import { UploadCleanupService } from '../upload-cleanup.js'
import { PushDeviceRegistry } from '../push/device-registry.js'
import { FcmClient, resolveServiceAccountFile } from '../push/fcm-client.js'
import { PushSender, resolvePresencePolicy, resolvePreviewChars } from '../push/sender.js'
import { sendTaskDoorbell, sendTurnDoorbell } from '../push/triggers.js'
import { broadcastTaskActivity } from '../task-activity.js'
import {
  TaskReplyNotFoundError,
  TaskReplyNotResumableError,
  createTaskReply,
  type ReplyToTask,
} from '../task-reply.js'
import { routeTaskOutcome } from '../task-outcome.js'
import {
  enqueueTaskInjection,
  abandonTaskInjection,
  DEFAULT_HEURISTICS,
  markTaskInjectionAttempt,
  markTaskInjectionDelivered,
  markTaskInjectionFailed,
  listPendingTaskInjections,
  selectInjectionsForRedelivery,
  formatRedeliveryPayload,
  planBootResume,
  TaskInjectionSweeper,
  loadHeuristics,
} from '@axiom/core'
import type { TaskInjectionRow, RunningTaskSummary } from '@axiom/core'

interface PendingTaskInjectionMeta {
  taskId: string
  userId: number
  /**
   * The interactive session id that will receive the streamed injection
   * response AND the persisted `task_result` chat_messages row. Pre-resolved
   * from `resolveTaskStrandOrigin` and forced into the injection
   * stream via `injectTaskResult(..., forcedSessionId)` so both the caller's
   * persistence path and the streamed chunks agree on the same session
   * without relying on FIFO ordering.
   */
  sessionId: string
  /**
   * Unique per-injection correlation token. Used as the map key so
   * multiple concurrent task completions targeting the same user's
   * origin strand (which share a `sessionId`) do not collide. The same
   * token is threaded through `injectTaskResult(..., injectionId)` and
   * tagged onto every emitted chunk as `chunk.injectionId`.
   */
  injectionId: string
  /**
   * Persona the task belongs to. Deterministically sourced from the task
   * row (never LLM-inferred); routes the injection into the persona's
   * runtime/session and the Telegram delivery to the persona's bot.
   */
  agentId: string
}

interface TaskSettings {
  defaultProvider: string
  maxDurationMinutes: number
  /** SPEC 10.8: token budget for the delegation context block (default 8000). */
  contextBudgetTokens: number
  telegramDelivery: string
  loopDetection: {
    enabled: boolean
    method: string
    maxConsecutiveFailures: number
    smartProvider: string
    smartCheckInterval: number
  }
  statusUpdates: {
    enabled: boolean
    intervalMinutes: number
  }
  verification: {
    enabled: boolean
    providerId: string
  }
}

interface RuntimeSettings {
  sessionTimeoutMinutes: number
  taskSettings: TaskSettings
  builtinToolsConfig: BuiltinToolsConfig | undefined
}

export interface RuntimeComposition {
  db: Database
  runtimeMetrics: RuntimeMetrics
  healthMonitorService: HealthMonitorService
  quotaMonitorService: QuotaMonitorService
  consolidationScheduler: MemoryConsolidationScheduler
  agentHeartbeatService: AgentHeartbeatService
  uploadCleanupService: UploadCleanupService
  taskEventBus: TaskEventBus
  chatEventBus: ChatEventBus
  chatActions: ChatActionRegistry
  /** Shared turn lifecycle owner; every chat channel dispatches into it. */
  turnRunner: TurnRunner
  /**
   * The process wide doorbell sender (PROTOCOL chapter 7). Handed to the HTTP
   * boundary so the captures path can ring for a question it wrote into a
   * strand without a turn ever running.
   */
  pushSender: PushSender
  getAgentCore: () => AgentCore | null
  getTaskRuntime: () => TaskRuntimeBoundary
  /**
   * Answer a paused/running/finished background task (see task-reply.ts).
   * Handed to the HTTP boundary so `POST /api/tasks/:id/reply` runs the very
   * same decision tree Telegram replies do — no second code path.
   */
  replyToTask: ReplyToTask
  /**
   * Resolve a provider by id or case-insensitive name. Exposed so HTTP
   * handlers (e.g. the tasks restart endpoint) can look up providers the
   * user selected in the UI without duplicating the provider registry.
   */
  resolveProvider: (nameOrId: string) => ProviderConfig | null
  /**
   * Current task default provider — same source of truth as the task
   * runner and cronjob scheduler. `kind` selects the `modelPolicy.roles`
   * entry (`task:user`, `task:cronjob`, …) that may pin a model for this
   * class of background work.
   */
  getTaskDefaultProvider: (
    agentId?: string | null,
    kind?: TaskModelRoleKind | null,
  ) => ProviderConfig | null
  /**
   * Names of the tools the task runner gives to background task agents.
   * Exposed so the cronjob UI can render the current tool list dynamically
   * instead of hardcoding a stale copy.
   */
  getBackgroundTaskToolNames: () => string[]
  getTelegramBot: () => TelegramBot | null
  onTelegramSettingsChanged: () => void
  onActiveProviderChanged: () => void
  setWebSocketChatPresenceChecker: (checker: { hasActiveWebSocket: (userId: number) => boolean } | null) => void
  stopBackgroundServices: () => Promise<void>
}

export interface RuntimeCompositionOptions {
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
}

export function loadRuntimeSettings(): RuntimeSettings {
  let sessionTimeoutMinutes = 30
  const taskSettings: TaskSettings = {
    defaultProvider: '',
    maxDurationMinutes: 60,
    contextBudgetTokens: 8000,
    telegramDelivery: 'auto',
    loopDetection: {
      enabled: true,
      method: 'systematic',
      maxConsecutiveFailures: 3,
      smartProvider: '',
      smartCheckInterval: 5,
    },
    statusUpdates: {
      enabled: false,
      intervalMinutes: 10,
    },
    verification: {
      enabled: true,
      providerId: '',
    },
  }

  let builtinToolsConfig: BuiltinToolsConfig | undefined

  try {
    const settings = loadConfig<{
      sessionTimeoutMinutes?: number
      tasks?: Partial<TaskSettings>
      builtinTools?: BuiltinToolsConfig
      braveSearchApiKey?: string
      searxngUrl?: string
      tavilyApiKey?: string
    }>('settings.json')

    // Accept 0 explicitly: 0 = never expire (disable time-based session cutting).
    if (typeof settings.sessionTimeoutMinutes === 'number' && settings.sessionTimeoutMinutes >= 0) {
      sessionTimeoutMinutes = settings.sessionTimeoutMinutes
    }

    if (settings.tasks) {
      const tasksConfig = settings.tasks as Partial<TaskSettings> & { statusUpdateIntervalMinutes?: number }
      taskSettings.defaultProvider = tasksConfig.defaultProvider ?? taskSettings.defaultProvider
      taskSettings.maxDurationMinutes = tasksConfig.maxDurationMinutes ?? taskSettings.maxDurationMinutes
      if (typeof tasksConfig.contextBudgetTokens === 'number' && tasksConfig.contextBudgetTokens > 0) {
        taskSettings.contextBudgetTokens = tasksConfig.contextBudgetTokens
      }
      taskSettings.telegramDelivery = tasksConfig.telegramDelivery ?? taskSettings.telegramDelivery

      // New sub-object wins; legacy flat `statusUpdateIntervalMinutes` is
      // migrated into the interval only (enabled stays false so upgrades
      // stay silent until the operator opts in).
      if (tasksConfig.statusUpdates) {
        const legacyInterval = typeof tasksConfig.statusUpdateIntervalMinutes === 'number' && tasksConfig.statusUpdateIntervalMinutes > 0
          ? tasksConfig.statusUpdateIntervalMinutes
          : undefined
        taskSettings.statusUpdates = {
          ...taskSettings.statusUpdates,
          ...(legacyInterval !== undefined && tasksConfig.statusUpdates.intervalMinutes === undefined
            ? { intervalMinutes: legacyInterval }
            : {}),
          ...tasksConfig.statusUpdates,
        }
      } else if (typeof tasksConfig.statusUpdateIntervalMinutes === 'number' && tasksConfig.statusUpdateIntervalMinutes > 0) {
        taskSettings.statusUpdates.intervalMinutes = tasksConfig.statusUpdateIntervalMinutes
      }

      if (tasksConfig.loopDetection) {
        taskSettings.loopDetection = {
          ...taskSettings.loopDetection,
          ...tasksConfig.loopDetection,
        }
      }

      if (tasksConfig.verification) {
        taskSettings.verification = {
          ...taskSettings.verification,
          ...tasksConfig.verification,
        }
      }
    }

    builtinToolsConfig = settings.builtinTools

    // Migrate legacy top-level keys into builtinTools.webSearch
    if (settings.braveSearchApiKey && !builtinToolsConfig?.webSearch?.braveSearchApiKey) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        braveSearchApiKey: settings.braveSearchApiKey,
      }
    }

    if (settings.searxngUrl && !builtinToolsConfig?.webSearch?.searxngUrl) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        searxngUrl: settings.searxngUrl,
      }
    }

    if (settings.tavilyApiKey && !builtinToolsConfig?.webSearch?.tavilyApiKey) {
      builtinToolsConfig = builtinToolsConfig ?? {}
      builtinToolsConfig.webSearch = {
        ...builtinToolsConfig.webSearch,
        tavilyApiKey: settings.tavilyApiKey,
      }
    }
  } catch {
    // use default values
  }

  return {
    sessionTimeoutMinutes,
    taskSettings,
    builtinToolsConfig,
  }
}

function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function normalizeReminderText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^⏰\s*/u, '')
    .replace(/^(reminder|erinnerung)\s*:\s*/u, '')
    .replace(/[.!?]+$/u, '')
    .replace(/\s+/g, ' ')
}

function areReminderFieldsDistinct(name: string, message: string): boolean {
  const normalizedName = normalizeReminderText(name)
  const normalizedMessage = normalizeReminderText(message)

  if (!normalizedName || !normalizedMessage) return normalizedName !== normalizedMessage
  if (normalizedName === normalizedMessage) return false
  if (normalizedMessage.includes(normalizedName) || normalizedName.includes(normalizedMessage)) return false

  return true
}

function formatReminderTelegramHtml(name: string, message: string): string {
  if (!areReminderFieldsDistinct(name, message)) {
    const singleLine = message.trim() || name.trim()
    return `⏰ ${escapeHtmlForTelegram(singleLine)}`
  }

  return `⏰ <b>${escapeHtmlForTelegram(name)}</b>\n\n${escapeHtmlForTelegram(message)}`
}

function parseNumericUserId(userId: string): number | null {
  const trimmed = userId.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const numericUserId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(numericUserId) ? numericUserId : null
}

/**
 * Resolve the provider (and its model, pinned as the sole `enabledModels`
 * entry) that background tasks run on when no explicit provider/model is given
 * at task creation.
 *
 * An explicitly configured task provider is only honored when it can actually
 * run a model. Providers may be created without selecting a model upfront, so a
 * configured provider with no enabled models would start tasks with an empty
 * model; in that case we fall back to the active provider/model selection.
 */
export function resolveTaskDefaultProvider(deps: {
  taskDefaultProvider: string
  resolveProvider: (providerId: string) => ProviderConfig | null
  getActiveProvider: () => ProviderConfig | null
  getActiveModelId: () => string | null
  onFallback?: (reason: string) => void
}): ProviderConfig | null {
  const { taskDefaultProvider, resolveProvider, getActiveProvider, getActiveModelId, onFallback } = deps

  if (taskDefaultProvider) {
    const { providerId, modelId } = parseProviderModelId(taskDefaultProvider)
    const resolved = providerId ? resolveProvider(providerId) : null
    if (resolved && modelId) return { ...resolved, enabledModels: [modelId] }
    if (resolved && getProviderDefaultModel(resolved)) return resolved

    onFallback?.(
      resolved
        ? `provider "${resolved.name}" has no enabled models`
        : `provider "${providerId || taskDefaultProvider}" could not be resolved`,
    )
  }

  // "Active provider (default)": follow the live chat selection for both
  // provider and model so tasks pick the user's active model instead of the
  // provider's first enabled model.
  const active = getActiveProvider()
  if (!active) return null
  const activeModelId = getActiveModelId()
  return activeModelId ? { ...active, enabledModels: [activeModelId] } : active
}

/**
 * Does some live writer already persist this strand's assistant row?
 *
 * This is the question `send_file_to_user` asks before it stays passive. Two
 * writers exist in the interactive backend:
 *   - a TurnRunner turn (its transcript writes `metadata.files` when the turn
 *     ends), and
 *   - a task-injection reaction (TaskInjectionTranscript does the same for the
 *     reaction it is streaming — the path that silently dropped two APKs on
 *     2026-09-15 before it learned to record uploads).
 *
 * No strand id means no writer: nothing can be persisted for a conversation
 * that is not identified, so the tool must fall back to its sink (or fail
 * loudly) instead of assuming a card appears somewhere.
 */
export function strandHasLiveWriter(
  sessionId: string | null | undefined,
  deps: {
    hasPersistingTurn: (sessionId: string) => boolean
    hasLiveInjection: (sessionId: string) => boolean
  },
): boolean {
  if (!sessionId) return false
  return deps.hasPersistingTurn(sessionId) || deps.hasLiveInjection(sessionId)
}

export async function createRuntimeComposition(options: RuntimeCompositionOptions = {}): Promise<RuntimeComposition> {
  const logger = options.logger ?? console

  logger.log('[axiom] Initializing database...')
  const db = initDatabase()

  logger.log('[axiom] Ensuring config templates...')
  ensureConfigTemplates()

  try {
    for (const sync of syncNewCatalogModels()) {
      logger.log(`[axiom] Provider "${sync.providerName}": auto-enabled new catalog models: ${sync.added.join(', ')}`)
    }
  } catch (error) {
    logger.warn('[axiom] Catalog model sync failed:', error)
  }

  logger.log('[axiom] Ensuring memory structure...')
  ensureMemoryStructure()
  ensureConfigStructure()

  // RC5 (multi-persona bleeding): idempotently bootstrap per-persona memory
  // roots (/data/agents/<id>/memory/ with MEMORY.md, daily/, users/, wiki/)
  // when scoped persona memory is enabled. Never overwrites existing files.
  try {
    const personaMemoryRoots = ensurePersonaMemoryRoots()
    if (personaMemoryRoots.length > 0) {
      logger.log(`[axiom] Ensured scoped persona memory roots: ${personaMemoryRoots.join(', ')}`)
    }
  } catch (error) {
    logger.warn('[axiom] Failed to ensure persona memory roots:', error)
  }

  logger.log('[axiom] Injecting global secrets into environment...')
  injectSecretsIntoEnv()

  const runtimeMetrics = new RuntimeMetrics()
  const { sessionTimeoutMinutes, taskSettings } = loadRuntimeSettings()

  function getCurrentTaskSettings(): TaskSettings {
    return loadRuntimeSettings().taskSettings
  }

  function resolveProvider(nameOrId: string): ProviderConfig | null {
    try {
      const file = loadProvidersDecrypted()
      return file.providers.find(
        p => p.id === nameOrId || p.name.toLowerCase() === nameOrId.toLowerCase(),
      ) ?? null
    } catch {
      return null
    }
  }

  /**
   * Resolve a "providerId" or "providerId:modelId" string to a model-pinned
   * ProviderConfig, or null when it cannot be resolved. Shared by the task
   * default-provider inheritance chain.
   */
  function resolveProviderModelString(spec: string): ProviderConfig | null {
    const { providerId, modelId } = parseProviderModelId(spec)
    if (!providerId) return null
    let resolved = resolveProvider(providerId)
    if (resolved && modelId) {
      resolved = { ...resolved, enabledModels: [modelId] }
    }
    return resolved ?? null
  }

  /**
   * Resolve a `modelPolicy.roles["task:*"]` spec to a runnable provider, or
   * null (with one warning) when it cannot run a model. Config passthrough
   * only — no routing decision, no model call.
   */
  function resolveTaskRoleProvider(hit: TaskModelPolicyHit | null): ProviderConfig | null {
    if (!hit) return null
    const resolved = resolveProviderModelString(hit.spec)
    if (resolved && getProviderDefaultModel(resolved)) return resolved
    logger.warn(
      `[axiom] modelPolicy.roles["${hit.role}"] = "${hit.spec}" is not usable ` +
      `(${resolved ? 'provider has no enabled models' : 'provider could not be resolved'}); ignoring it`,
    )
    return null
  }

  /**
   * System default provider (chain tiers 3+4), strongest first:
   *   1. `modelPolicy.roles["task:<kind>"]`  — kind-specific pin
   *   2. `tasks.defaultProvider`             — the Settings UI value
   *   3. `modelPolicy.roles["task:default"]` — only when (2) is empty
   *   4. the live active chat provider/model
   * This is the weakest tier of the task model inheritance chain.
   *
   * `kind` is the task's trigger type, passed in by the caller that creates
   * the task (cronjob scheduler, heartbeat, consolidation, task tools). It is
   * deterministic plumbing data, never inferred from model output.
   *
   * Merge (upstream 0.27.0): delegate to the module-level
   * `resolveTaskDefaultProvider` helper so we inherit its fallback-warn logging
   * (task-provider-fallback fix) and null-safe active-provider handling. The
   * fork contract here is non-null (the persona chain in core requires a
   * `getSystemDefault: () => ProviderConfig`), so if even the active provider is
   * missing we fall back to `getActiveProvider()!` to preserve the original
   * behaviour (task creation then fails downstream on an empty model, as before).
   */
  function getTaskSystemDefaultProvider(kind?: TaskModelRoleKind | null): ProviderConfig {
    // Tier: modelPolicy.roles["task:<kind>"] — the most specific statement
    // about this class of background work.
    const specificRole = resolveTaskRoleProvider(
      kind ? resolveTaskModelRoleFrom([`task:${kind}`]) : null,
    )
    if (specificRole) return specificRole

    const taskDefaultProvider = getCurrentTaskSettings().defaultProvider
    // Tier: modelPolicy.roles["task:default"] — "all background work on X"
    // without touching the chat model. Only consulted when the Settings UI
    // value is empty, so a dropdown change is never silently overridden.
    if (!taskDefaultProvider) {
      const genericRole = resolveTaskRoleProvider(resolveTaskModelRoleFrom(['task:default']))
      if (genericRole) return genericRole
    }
    const resolved = resolveTaskDefaultProvider({
      taskDefaultProvider: taskDefaultProvider ?? '',
      resolveProvider,
      getActiveProvider,
      getActiveModelId,
      onFallback: (reason) => {
        logger.warn(
          `[axiom] Task default provider "${taskDefaultProvider}" is not usable (${reason}); falling back to the active provider`,
        )
      },
    })
    if (resolved) return resolved

    // Preserve the fork's non-null contract for the persona chain's system tier.
    const active = getActiveProvider()!
    const activeModelId = getActiveModelId()
    return activeModelId ? { ...active, enabledModels: [activeModelId] } : active
  }

  /**
   * Task default-provider inheritance chain (C2), delegated to the core
   * `resolveTaskDefaultProvider` helper (unit-tested in core):
   *   explicit(create_task) > parent task model (ALS) > per-agent default (C4)
   *   > system default (tasks.defaultProvider / active chat).
   * `agentId` is the persona the new task is attributed to (from create_task);
   * when omitted the ALS context's agentId is used.
   */
  function getTaskDefaultProvider(
    agentId?: string | null,
    kind?: TaskModelRoleKind | null,
  ): ProviderConfig {
    const personaSettings = loadMultiPersonaSettings()
    return resolveTaskDefaultProviderChain({
      // Priority: explicit (create_task passes its attribution target) >
      // ALS task context (deterministic data from the task row — RC principle) >
      // interactive-turn inference. ALS MUST come before getCurrentToolAgentId:
      // inside a background task, the interactive field can concurrently hold a
      // DIFFERENT persona mid-turn and must not leak into task model choice.
      agentId: agentId ?? getCurrentTaskAgentId() ?? agentCore?.getCurrentToolAgentId(),
      getPerAgentProviderSpec: (id) =>
        (personaSettings.enabled ? personaSettings.perAgentProvider?.[id] : undefined),
      resolveProvider,
      getSystemDefault: () => getTaskSystemDefaultProvider(kind),
    })
  }

  const chatEventBus = new ChatEventBus()
  const taskEventBus = new TaskEventBus()

  // Interactive chat messages are broadcast to every user, because approvals
  // (the current consumer) may be answered by any authenticated user.
  const chatActions = new ChatActionRegistry({
    publishToClients: ({ type, message }) => {
      const rows = db.prepare('SELECT id FROM users').all() as { id: number }[]
      for (const row of rows) {
        chatEventBus.broadcast({ type, userId: row.id, source: 'web', chatAction: message })
      }
    },
  })

  const unregisterEmailApprovalChat = registerEmailApprovalChatChannel({
    chatActions,
    approval: createEmailApprovalService({ db }),
  })

  // Shared SessionManager dedicated to background producers (tasks,
  // heartbeat, consolidation, scheduled jobs, reminders). It only uses
  // `createSession()` to register UUID-based session rows; the per-user
  // interactive session lifecycle is owned by AgentCore's own SessionManager.
  const backgroundSessions = new SessionManager({ db })

  let wsChatPresenceChecker: ((userId: number) => boolean) | null = null

  let agentCore: AgentCore | null = null
  let providerManager: ProviderManager | null = null
  let telegramBot: TelegramBot | null = null
  // Multi-persona mode: one TelegramBot per persona account. `telegramBot`
  // then points at the pool's primary bot for backward compatibility.
  let telegramBotPool: TelegramBotPool | null = null
  let unregisterTelegramEmailApproval: (() => void) | null = null

  /**
   * Resolve the Telegram bot bound to a persona. Falls back to the primary
   * bot when no pool is running or the persona has no dedicated bot.
   */
  function resolveTelegramBotForAgent(agentId: string | null | undefined): TelegramBot | null {
    if (agentId && telegramBotPool) {
      return telegramBotPool.getBot(agentId) ?? telegramBot
    }
    return telegramBot
  }

  // One runner for the whole process: web sockets and Telegram attach to the
  // same turns, so a turn started in one channel streams into the other and a
  // manual retry cannot race a second, channel-local runner.
  let retryChatChannel: TurnRetryChatChannel | null = null

  // Push (PROTOCOL chapter 7). One sender for the process; without a service
  // account file it reports `isConfigured() === false` and every doorbell is
  // a logged no-op, so an instance without Firebase behaves exactly as before.
  const pushPresencePolicy = resolvePresencePolicy()
  const pushPreviewChars = resolvePreviewChars()
  const pushSender = new PushSender({
    registry: new PushDeviceRegistry(db),
    client: new FcmClient({ serviceAccountFile: resolveServiceAccountFile() }),
    presencePolicy: pushPresencePolicy,
    previewChars: pushPreviewChars,
    // Reads the same live checker Telegram's `auto` delivery uses. The
    // assignment below happens after this closure is built, hence the lookup
    // at call time rather than a captured value.
    isClientOnline: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
    logger: {
      info: msg => logger.log(msg),
      warn: msg => logger.warn(msg),
      error: msg => logger.error(msg),
    },
  })
  if (!pushSender.isConfigured()) {
    logger.log('[push] No FCM service account found, push notifications are off')
  } else if (pushPresencePolicy !== 'off' || pushPreviewChars > 0) {
    logger.log(
      `[push] Doorbell policy: suppress-when-online=${pushPresencePolicy}, preview=${pushPreviewChars || 'off'}`,
    )
  }
  // `onTurnFailed` fires before `onTurnEnd` for the same turn, so the end hook
  // can tell "answered" from "died" without inspecting the transcript. The set
  // is drained on read; a turn that never fails never enters it.
  const failedTurnIds = new Set<string>()

  const turnRunner = new TurnRunner({
    db,
    getAgent: () => agentCore,
    /**
     * Incident 2026-09-24: Anthropic answered a turn with
     * `401 authentication_error "invalid x-api-key"` and the turn died as
     * `non_retryable`, although the stored OAuth credential worked one minute
     * later. For an OAuth provider the credential is re-resolved here (which
     * also picks up a token another process already rotated) and the turn gets
     * exactly one more attempt. A static API key returns false: a wrong key
     * stays wrong.
     */
    recoverAuth: async ({ providerId }) => {
      if (!providerId) return false
      return recoverOAuthAfterAuthFailure(providerId)
    },
    /**
     * The model the turn will actually talk to, frozen at turn start. Read
     * back by the strands service so the model indicator names the model that
     * is answering, not the one a mid-turn global switch made effective.
     */
    resolveStartModel: ({ sessionId, turnOverride }) => effectiveModelForStrand(db, sessionId, turnOverride),
    onTurnStart: () => runtimeMetrics.startRequest(),
    onTurnEnd: turn => {
      runtimeMetrics.endRequest()
      const failed = failedTurnIds.delete(turn.turnId)
      sendTurnDoorbell(db, pushSender, {
        userId: turn.userId,
        sessionId: turn.sessionId,
        agentId: turn.agentId,
        failed,
      })
      // Offtangent Stufe 2: the running project assignment. The turn is over
      // at this point, the gate is a few indexed reads and the model call
      // happens in a detached promise, so no chat turn ever waits for it.
      if (!failed) {
        triggerProjectAssignment({ db, sessionId: turn.sessionId, trigger: 'message', chatEventBus })
      }
    },
    onTurnFailed: failure => {
      failedTurnIds.add(failure.turn.turnId)
      retryChatChannel?.attachRetryAction(failure)
    },
  })
  retryChatChannel = registerTurnRetryChatChannel({ chatActions, db, runner: turnRunner })

  // Pending task injections keyed by a per-injection UUID. The key is
  // minted here, passed into AgentCore.injectTaskResult as the
  // `injectionId`, and tagged onto every emitted chunk
  // (`chunk.injectionId`) so the handler can correlate chunks with
  // metadata.
  //
  // We MUST key by a per-call token — not by session id — because
  // multiple concurrent task completions for the same user resolve to
  // the same cached interactive session id, and a shared key would
  // collide: the second handleTaskNotification would overwrite the
  // first's metadata before either had streamed.
  const pendingInjections = new Map<string, PendingTaskInjectionMeta>()

  // Reuse one session row per scheduled-reminder id instead of creating a
  // fresh session on every fire. Keeps `sessions` growth O(number of
  // reminders) instead of O(fires). The cache is per-process; after a
  // restart a new session row is created for the reminder's first post-
  // restart fire.
  const reminderSessionByCronjobId = new Map<string, string>()
  function resolveReminderSessionId(cronjobId: string): string {
    const existing = reminderSessionByCronjobId.get(cronjobId)
    if (existing) return existing
    const newId = backgroundSessions.createSession({
      type: 'task',
      source: 'system',
    }).id
    reminderSessionByCronjobId.set(cronjobId, newId)
    return newId
  }
  function evictReminderSession(cronjobId: string): void {
    reminderSessionByCronjobId.delete(cronjobId)
  }

  /**
   * Resolve the target user for a task result notification by walking the
   * task's session lineage back to the triggering interactive session.
   * Returns null when the task has no interactive parent (cronjob,
   * heartbeat, consolidation) — callers fall back to a default user.
   *
   * The walk itself lives in `@axiom/core` (`resolveTaskOwnerUserId`)
   * because the tasks API asks the same question for authorization: the
   * user who receives a task's result is the user allowed to read and kill
   * it. One implementation, one answer.
   */
  function resolveTargetUserIdForTask(taskSessionId: string | null | undefined): number | null {
    return resolveTaskOwnerUserId(db, taskSessionId)
  }

  /**
   * Fallback user when a task has no interactive lineage (cronjob,
   * heartbeat). Uses the lowest-id user in the `users` table. Throws if
   * the query fails or no user exists — an empty users table means the
   * system is misconfigured (admin is provisioned by `ensureAdminUser`
   * during bootstrap), and a DB error must not be silently hidden by
   * returning a hardcoded id that may not exist.
   */
  function getFallbackUserId(): number {
    const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get() as { id: number } | undefined
    if (!row || !Number.isSafeInteger(row.id)) {
      throw new Error('getFallbackUserId: no users in database (admin not provisioned?)')
    }
    return row.id
  }

  /**
   * Who a task belongs to and which strand it came from — the single answer
   * used by the task's execution context (so `send_file_to_user` can deliver
   * mid-run), by its result notification and by its status heartbeats.
   *
   * `sessionId` is the interactive strand resolved through the full lineage,
   * or null for tasks without a strand origin.
   */
  function resolveTaskOrigin(task: Task): TaskOrigin & { userId: number } {
    const resolvedUserId = resolveTargetUserIdForTask(task.sessionId)
    if (resolvedUserId == null && task.sessionId) {
      logger.warn(
        `[axiom] Task ${task.id}: could not resolve target user from session lineage (sessionId=${task.sessionId}); falling back to default user`,
      )
    }
    return {
      userId: resolvedUserId ?? getFallbackUserId(),
      sessionId: resolveTaskStrandOrigin(db, task),
    }
  }

  /**
   * Strand activity (SPEC 10.x): announce the birth, progress and end of a
   * task in the strand it works for, so a wave of sub-tasks is visible while
   * it runs instead of only after it finished. Frames without a resolvable
   * strand are dropped inside `broadcastTaskActivity` — never guessed.
   */
  const taskActivityDeps = {
    db,
    chatEventBus,
    resolveUserId: (task: Task) => resolveTargetUserIdForTask(task.sessionId) ?? getFallbackUserId(),
    logger: { warn: (msg: string, ...args: unknown[]) => logger.warn(msg, ...args) },
  }

  /**
   * Hand one queued injection to the agent (W4).
   *
   * This is the ONLY place that starts an injection turn: the fresh-result
   * path, the boot resume and the sweeper all funnel through it, so the
   * in-memory correlation map and the durable row can never disagree about
   * which injection is in flight.
   *
   * `markAttempt` is false for the sweeper, which counts the attempt itself
   * before calling (so an exception here is still counted).
   */
  function deliverInjectionRun(
    row: Pick<TaskInjectionRow, 'id' | 'taskId' | 'userId' | 'agentId' | 'sessionId'> & { payload: string },
    options: { markAttempt?: boolean; persisted?: boolean } = {},
  ): boolean {
    if (!agentCore) return false
    const persisted = options.persisted !== false
    if (persisted && options.markAttempt !== false) {
      try {
        markTaskInjectionAttempt(db, row.id)
      } catch (err) {
        logger.warn(`[axiom] Could not count delivery attempt for injection ${row.id}:`, err)
      }
    }
    pendingInjections.set(row.id, {
      taskId: row.taskId,
      userId: row.userId,
      sessionId: row.sessionId,
      injectionId: row.id,
      agentId: row.agentId,
    })
    agentCore.injectTaskResult(row.payload, String(row.userId), row.sessionId, row.id, row.agentId).catch(err => {
      logger.error(`[axiom] Failed to inject task result for ${row.taskId}:`, err)
      pendingInjections.delete(row.id)
      if (!persisted) return
      try {
        markTaskInjectionFailed(db, row.id, String(err))
      } catch (markErr) {
        logger.warn(`[axiom] Could not record delivery failure for injection ${row.id}:`, markErr)
      }
    })
    return true
  }

  function handleTaskNotification(taskId: string, injection: string, taskRuntime: TaskRuntimeTaskBoundary, agentIdFromTask: string | null): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    // Persona routing: prefer the agentId handed through the task-runner
    // callback, fall back to the task row. Deterministic data, never
    // LLM-inferred.
    const effectiveAgentId = agentIdFromTask ?? task.agentId ?? 'main'

    const startMs = task.startedAt ? new Date(task.startedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const endMs = task.completedAt ? new Date(task.completedAt.replace(' ', 'T') + 'Z').getTime() : Date.now()
    const durationMinutes = Math.round((endMs - startMs) / 60000)

    // Target user. The lineage session is no longer read here: whether this
    // result may enter a strand at all is decided by `routeTaskOutcome` from
    // the task's own lineage, not by whatever session happens to be cached.
    const { userId } = resolveTaskOrigin(task)

    // Strand or feed (SPEC 2.9). `routeTaskOutcome` decides from the task's
    // own lineage; everything below is the machinery it needs, unchanged in
    // behaviour for a task that came out of a strand.
    routeTaskOutcome({
      db,
      chatEventBus,
      logger: { warn: (msg, ...args) => logger.warn(msg, ...args), error: (msg, ...args) => logger.error(msg, ...args) },
      telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
      hasActiveWebSocket: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
      injectIntoStrand: ({ injection: payload, userId: targetUserId, agentId, strandId }) => {
        // Persist first, deliver second (W4). The row — not the Map — is what
        // survives a container restart, and it is written even when there is
        // no agent core yet: the sweeper delivers it as soon as one exists.
        // The row id doubles as the per-injection correlation token, so
        // concurrent results in one strand stay distinct exactly as before.
        let row: TaskInjectionRow | null = null
        try {
          row = enqueueTaskInjection(db, {
            taskId: task.id,
            kind: 'task_result',
            userId: targetUserId,
            agentId,
            sessionId: strandId,
            payload,
          })
        } catch (err) {
          logger.error(`[axiom] Failed to persist task injection for ${taskId}:`, err)
        }
        if (row) {
          deliverInjectionRun(row)
          return
        }
        // Fail open: a broken queue must not swallow the result. Deliver it
        // exactly as the pre-W4 code did, without durability.
        deliverInjectionRun(
          { id: randomUUID(), taskId: task.id, userId: targetUserId, agentId, sessionId: strandId, payload },
          { persisted: false },
        )
      },
      // Feed-only results have no injection turn, so the plain formatted
      // result is what reaches Telegram.
      sendTelegram: ({ userId: targetUserId, agentId }) => {
        const bot = resolveTelegramBotForAgent(agentId)
        const chatId = bot ? bot.getTelegramChatIdForUser(targetUserId) : null
        if (!bot || !chatId) return undefined
        return (message: string) => bot.sendTaskNotification(chatId, message, task.id)
      },
      ringDoorbell: ({ userId: targetUserId, sessionId, agentId, type }) => {
        sendTaskDoorbell(db, pushSender, { userId: targetUserId, sessionId, agentId, type })
      },
    }, {
      task,
      injection,
      userId,
      agentId: effectiveAgentId,
      durationMinutes,
    })
  }

  /**
   * Periodic progress signal while a background task is still running.
   * Mirrors `handleTaskNotification` but intentionally routes through a
   * non-LLM delivery path: persist to chat_messages (so history shows it),
   * broadcast on chatEventBus (so live web clients render a progress
   * line), and optionally send via Telegram respecting the user's
   * `telegramDelivery` setting. No `agentCore.injectTaskResult` call —
   * status updates are ephemeral heartbeats, not new chat turns the
   * parent agent should respond to.
   */
  function handleStatusUpdateNotification(
    taskId: string,
    _statusMessage: string,
    details: {
      taskName: string
      runtimeMinutes: number
      toolCallCount: number
      totalTokens: number
    },
    taskRuntime: TaskRuntimeTaskBoundary,
  ): void {
    const task = taskRuntime.getById(taskId)
    if (!task) return

    const { userId } = resolveTaskOrigin(task)
    const statusAgentId = task.agentId ?? 'main'
    // Progress stays on the lineage strand, or the task's own transcript
    // for feed-only work. Never consult or create an active chat session.
    const targetSessionId = resolveTaskStrandOrigin(db, task) ?? task.sessionId ?? undefined

    const statusBot = resolveTelegramBotForAgent(statusAgentId)
    const telegramChatId = statusBot ? statusBot.getTelegramChatIdForUser(userId) : null
    const sendTelegram = statusBot && telegramChatId
      ? (html: string) => statusBot.sendTaskNotification(telegramChatId, html, task.id)
      : undefined

    deliverTaskStatusUpdate({
      db,
      userId,
      task,
      details,
      targetSessionId,
      telegramDeliveryMode: (taskSettings.telegramDelivery as 'auto' | 'always') ?? 'auto',
      hasActiveWebSocket: (uid: number) => wsChatPresenceChecker?.(uid) ?? false,
      sendTelegram,
      broadcastEvent: (event) => {
        chatEventBus.broadcast({
          type: event.type,
          userId: event.userId,
          source: 'task',
          sessionId: targetSessionId,
          taskId: event.taskId,
          taskName: event.taskName,
          taskTriggerType: event.taskTriggerType,
          taskStatusContent: event.content,
          taskStatusRuntimeMinutes: event.details.runtimeMinutes,
          taskStatusToolCallCount: event.details.toolCallCount,
          taskStatusTokensUsed: event.details.totalTokens,
        })
      },
    }).catch(err => {
      logger.error(`[axiom] Failed to deliver task status update for ${taskId}:`, err)
    })
  }

  // Background task tools live in a mutable array that is repopulated in place
  // by rebuildBackgroundTaskTools (see there).
  const quotaMonitorService = new QuotaMonitorService()

  /**
   * `send_file_to_user` for background tasks. A task has no interactive turn,
   * so its identity comes from the execution context the task runner binds
   * (resolved once via `resolveTaskOrigin`) and delivery is explicit: nothing
   * consumes a task's tool chunks the way ws-chat consumes a turn's.
   */
  const backgroundSendFileToolOptions = {
    getCurrentToolUserId: () => getCurrentTaskExecutionContext()?.userId ?? undefined,
    getCurrentInteractiveSessionId: () => getCurrentTaskExecutionContext()?.sessionId ?? null,
    deliverFile: (delivery: SendFileDelivery) => {
      const ctx = getCurrentTaskExecutionContext()
      const agentId = ctx?.agentId ?? 'main'
      const task = ctx?.taskId ? taskRuntime.tasks.getById(ctx.taskId) : null
      // Resolve from the task row, not a cached turn or tool-supplied session.
      // Feed-only artifacts remain in the task transcript, never in a strand.
      // No fallback to `delivery.sessionId`: a task whose row cannot be
      // resolved has no proven lineage, and guessing would drop the file into
      // whatever strand happens to be open (asserted in
      // bootstrap/task-delivery-lineage.test.ts).
      const sessionId = task ? resolveTaskStrandOrigin(db, task) ?? task.sessionId : null
      // Returned, not swallowed: the tool only reports success when a row id
      // comes back from here.
      return deliverTaskFile({ db, chatEventBus }, {
        userId: delivery.userId,
        sessionId,
        agentId,
        upload: delivery.upload,
        caption: delivery.caption,
      })
    },
  }

  /**
   * Strands with a task-injection turn currently streaming, counted because
   * two injections can target the same strand. A task injection persists its
   * own assistant row (see TaskInjectionTranscript), so a file sent during one
   * is already carried — `send_file_to_user` must stay passive there, exactly
   * like inside a TurnRunner turn, or the strand gets the same file twice.
   */
  const liveInjectionsByStrand = new Map<string, number>()

  function markInjectionStreaming(sessionId: string): void {
    liveInjectionsByStrand.set(sessionId, (liveInjectionsByStrand.get(sessionId) ?? 0) + 1)
  }

  function unmarkInjectionStreaming(sessionId: string): void {
    const open = (liveInjectionsByStrand.get(sessionId) ?? 0) - 1
    if (open > 0) liveInjectionsByStrand.set(sessionId, open)
    else liveInjectionsByStrand.delete(sessionId)
  }

  const backgroundSttEnabled = (() => { try { return loadSttSettings().enabled } catch { return false } })()
  // createBaseAgentTools builds the shared tool set (yolo, web, chat-history,
  // search-memories, agent-skills, transcribe-audio). Both the interactive
  // AgentCore (via agent-runtime.ts) and background tasks use the same factory,
  // so adding a new base tool in one place automatically covers both paths.
  const backgroundTaskTools: AgentTool[] = createBaseAgentTools({
    db,
    builtinToolsConfig: () => loadRuntimeSettings().builtinToolsConfig,
    sttEnabled: backgroundSttEnabled,
    quotaService: quotaMonitorService,
    // Background tasks have no interactive session; search_memories will fall
    // back to the lowest-id user when getCurrentUserId is undefined.
  })

  const taskRuntime = createTaskRuntime({
    db,
    runner: {
      buildModel,
      getApiKey: getApiKeyForProvider,
      sessionManager: backgroundSessions,
      tools: backgroundTaskTools,
      // Absolute memory location in every task agent's system prompt —
      // without this, weaker models resolve `memory/...` relative to
      // /workspace and read nothing (nightly consolidation no-op incident).
      memoryDir: getMemoryDir(),
      onTaskComplete: (taskId: string, injection: string, agentId: string | null) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks, agentId)
      },
      onTaskPaused: (taskId: string, injection: string, agentId: string | null) => {
        handleTaskNotification(taskId, injection, taskRuntime.tasks, agentId)
      },
      onStatusUpdate: (taskId: string, statusMessage: string, details) => {
        handleStatusUpdateNotification(taskId, statusMessage, details, taskRuntime.tasks)
        const task = taskRuntime.tasks.getById(taskId)
        if (task) broadcastTaskActivity(taskActivityDeps, 'progress', task)
      },
      // Birth and end of every task, sub-tasks included. This is the frame
      // that was missing: a delegated task was invisible until it finished.
      onTaskLifecycle: (phase, task) => {
        broadcastTaskActivity(taskActivityDeps, phase, task)
      },
      loopDetection: taskSettings.loopDetection.enabled
        ? {
            enabled: true,
            method: taskSettings.loopDetection.method as LoopDetectionConfig['method'],
            maxConsecutiveFailures: taskSettings.loopDetection.maxConsecutiveFailures,
            smartProvider: resolveRoleSpec('loopDetection', taskSettings.loopDetection.smartProvider) || undefined,
            smartCheckInterval: taskSettings.loopDetection.smartCheckInterval,
          }
        : undefined,
      statusUpdates: taskSettings.statusUpdates,
      verification: taskSettings.verification,
      getProviderById: (id: string) => resolveProvider(id),
      resolveTaskOrigin,
      taskEventBus,
      // Watchdog fallback for tasks that never set maxDurationMinutes
      // (heartbeat, consolidation, cronjobs, scheduled tasks). Without
      // this a hung LLM call would leave the row at status='running'
      // forever. Per-task limits still take precedence when set.
      defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
    },
    scheduler: {
      // Cronjob tasks can be pinned via modelPolicy.roles["task:cronjob"].
      getDefaultProvider: () => getTaskDefaultProvider(null, 'cronjob'),
      resolveProvider,
      onInjection: (scheduledTask) => {
        const userId = 1
        const deliveryResults: string[] = []

        // Reuse one `sessions` row per scheduled reminder (keyed by cronjob
        // id) so `sessions` growth is bounded by the number of reminders
        // rather than the number of fires. A reminder firing hourly would
        // otherwise add 8760 session rows per year; with the cache each fire
        // appends a new `tool_calls` row under the same session.
        const reminderSessionId = resolveReminderSessionId(scheduledTask.id)

        chatEventBus.broadcast({
          type: 'reminder',
          userId,
          source: 'task',
          reminderMessage: scheduledTask.prompt,
          reminderName: scheduledTask.name,
          cronjobId: scheduledTask.id,
        })
        deliveryResults.push('chatEventBus: broadcast sent')

        // Deliver via the bot bound to the reminder's persona (falls back
        // to the primary bot when no pool is running).
        const reminderBot = resolveTelegramBotForAgent(scheduledTask.agentId)
        if (reminderBot) {
          const chatId = reminderBot.getTelegramChatIdForUser(userId)
          if (chatId) {
            const telegramHtml = formatReminderTelegramHtml(scheduledTask.name, scheduledTask.prompt)
            reminderBot.sendTaskNotification(chatId, telegramHtml).then(ok => {
              const status = ok ? 'sent' : 'failed'
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  telegramChatId: chatId,
                  telegramStatus: status,
                  deliveryResults: [...deliveryResults, `telegram: ${status} (chat ${chatId})`],
                }),
                durationMs: 0,
                status: ok ? 'success' : 'error',
              })
            }).catch(err => {
              logger.error(`[axiom] Failed to send Telegram reminder for ${scheduledTask.id}:`, err)
              logToolCall(db, {
                sessionId: reminderSessionId,
                toolName: 'reminder_delivery',
                input: JSON.stringify({
                  cronjobId: scheduledTask.id,
                  name: scheduledTask.name,
                  message: scheduledTask.prompt,
                  schedule: scheduledTask.schedule,
                }),
                output: JSON.stringify({
                  error: (err as Error).message,
                  deliveryResults: [...deliveryResults, `telegram: error - ${(err as Error).message}`],
                }),
                durationMs: 0,
                status: 'error',
              })
            })
            logger.log(`[axiom] Reminder "${scheduledTask.name}" sent via Telegram to chat ${chatId}`)
          } else {
            deliveryResults.push('telegram: no linked chat for this user (requires approved telegram_users entry linked to the same user_id)')
            logger.log(`[axiom] No linked Telegram chat for user ${userId}`)

            chatEventBus.broadcast({
              type: 'system',
              userId,
              source: 'task',
              text: 'Telegram reminder could not be delivered: no approved Telegram account is linked to this user. Open Settings → Telegram, let the Telegram account message the bot, then approve and assign it to this user.',
            })

            logToolCall(db, {
              sessionId: reminderSessionId,
              toolName: 'reminder_delivery',
              input: JSON.stringify({
                cronjobId: scheduledTask.id,
                name: scheduledTask.name,
                message: scheduledTask.prompt,
                schedule: scheduledTask.schedule,
              }),
              output: JSON.stringify({ deliveryResults }),
              durationMs: 0,
              status: 'error',
            })
          }
        } else {
          deliveryResults.push('telegram: bot not available')
          logger.log(`[axiom] No Telegram bot available for reminder "${scheduledTask.name}"`)

          chatEventBus.broadcast({
            type: 'system',
            userId,
            source: 'task',
            text: 'Telegram reminder could not be delivered because the Telegram bot is not available.',
          })

          logToolCall(db, {
            sessionId: reminderSessionId,
            toolName: 'reminder_delivery',
            input: JSON.stringify({
              cronjobId: scheduledTask.id,
              name: scheduledTask.name,
              message: scheduledTask.prompt,
              schedule: scheduledTask.schedule,
            }),
            output: JSON.stringify({ deliveryResults }),
            durationMs: 0,
            status: 'error',
          })
        }

        logger.log(`[axiom] Reminder "${scheduledTask.name}" fired for user ${userId}`)
      },
    },
  })

  const taskToolsOptions = {
    taskRuntime: taskRuntime.tasks,
    // `create_task` always inserts trigger_type='agent' (delegation), so the
    // role for this path is `task:agent`. The persona/parent tiers still win
    // over it — see getTaskDefaultProvider.
    getDefaultProvider: (agentId?: string | null) => getTaskDefaultProvider(agentId, 'agent'),
    resolveProvider,
    defaultMaxDurationMinutes: taskSettings.maxDurationMinutes,
    maxDurationMinutesCap: taskSettings.maxDurationMinutes * 2,
    // Link new task sessions to the user's current interactive session via
    // sessions.parent_session_id. Returns null when no interactive session
    // is active (e.g. tool invoked from a background context).
    getParentSessionId: () => agentCore?.getCurrentInteractiveSessionId() ?? null,
    // Attribute new tasks to the persona whose runtime invoked the tool so
    // their results route back to the same persona (runtime + Telegram bot).
    getCurrentAgentId: () => agentCore?.getCurrentToolAgentId(),
    // SPEC 11.6: context_mode selected/fork read the strand from the DB.
    db,
    contextBudgetTokens: taskSettings.contextBudgetTokens,
  }

  // Background tasks never have an active interactive session, so
  // getParentSessionId always returns null here.
  const backgroundTaskToolsOptions = {
    ...taskToolsOptions,
    getParentSessionId: () => null as string | null,
    // Sub-tasks spawned from INSIDE a background task must be attributed to
    // the persona of that task — read deterministically from the ALS task
    // context (fed from the task row), NEVER from the interactive runtime's
    // getCurrentToolAgentId(): that field belongs to whatever interactive
    // turn happens to run concurrently and could attribute the sub-task (and
    // its memory root + result routing) to the wrong persona.
    getCurrentAgentId: () => getCurrentTaskAgentId() ?? undefined,
  }

  // Task runner, heartbeat and cronjob paths capture the `backgroundTaskTools`
  // array reference once, so this MUST mutate that array in place — reassigning
  // it would leave every background path on the stale tool set.
  function rebuildBackgroundTaskTools(): void {
    backgroundTaskTools.length = 0
    backgroundTaskTools.push(
      ...createBaseAgentTools({
        db,
        builtinToolsConfig: () => loadRuntimeSettings().builtinToolsConfig,
        sttEnabled: backgroundSttEnabled,
        quotaService: quotaMonitorService,
      }),
      createTaskTool(backgroundTaskToolsOptions),
      createResumeTaskTool(backgroundTaskToolsOptions),
      listTasksTool({ taskRuntime: taskRuntime.tasks, db }),
      createSendFileTool(backgroundSendFileToolOptions),
    )
  }
  rebuildBackgroundTaskTools()

  // Wrap the schedule boundary so deleting a cronjob also evicts its
  // cached reminder session id. Without this, a cronjob deleted mid-
  // process leaves a dangling entry in `reminderSessionByCronjobId`
  // (and an abandoned `sessions` row) that lives for the lifetime of
  // the process.
  const cronjobSchedulesForTools = new Proxy(taskRuntime.schedules, {
    get(target, prop, receiver) {
      if (prop === 'delete') {
        return (id: string) => {
          const deleted = target.delete(id)
          if (deleted) evictReminderSession(id)
          return deleted
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  const cronjobToolsOptions = {
    taskRuntime: cronjobSchedulesForTools,
    // Attribute new cronjobs to the persona whose runtime invoked the tool.
    getCurrentAgentId: () => agentCore?.getCurrentToolAgentId(),
  }

  // Exclusive tools for the interactive agent only.
  // The base tool set (shell, web, chat-history, memories, skills, stt) is
  // assembled inside agent-runtime.ts via createBaseAgentTools() and does NOT
  // need to be listed here — that keeps both paths in sync automatically.
  const agentTools = [
    createTaskTool(taskToolsOptions),
    createResumeTaskTool(taskToolsOptions),
    listTasksTool({ taskRuntime: taskRuntime.tasks, db }),
    createCronjobTool(cronjobToolsOptions),
    editCronjobTool(cronjobToolsOptions),
    removeCronjobTool(cronjobToolsOptions),
    listCronjobsTool(cronjobToolsOptions),
    getCronjobTool(cronjobToolsOptions),
    createReminderTool(cronjobToolsOptions),
    // `send_file_to_user` needs late-bound access to the active turn's user
    // id and interactive session id — both are set on `agentCore` at the
    // start of every `processUserMessage`/`processTaskInjection` call. No
    // delivery sink here: the channel that streams the turn (ws-chat,
    // Telegram) delivers the file from the tool's chunk. Background tasks
    // use `backgroundSendFileToolOptions` instead.
    createSendFileTool({
      getCurrentToolUserId: () => agentCore?.getCurrentToolUserId(),
      getCurrentInteractiveSessionId: () => agentCore?.getCurrentInteractiveSessionId() ?? null,
      // Passive only while a turn really persists this strand: the TurnRunner
      // transcript writes the assistant row with `metadata.files` when the turn
      // ends, and a task injection does the same for its own reaction.
      isCarriedByCurrentTurn: () => strandHasLiveWriter(
        agentCore?.getCurrentInteractiveSessionId() ?? null,
        {
          hasPersistingTurn: (sessionId) => turnRunner.hasPersistingTurnInSession(sessionId),
          hasLiveInjection: (sessionId) => liveInjectionsByStrand.has(sessionId),
        },
      ),
      // Fallback for every other interactive-looking context (no live turn, a
      // turn without persistence, a slash-command run): write the row here so
      // the file arrives anyway. Without a strand this throws, and the tool
      // reports the failure instead of pretending a card appeared.
      deliverFile: (delivery: SendFileDelivery) => deliverTaskFile({ db, chatEventBus }, {
        userId: delivery.userId,
        sessionId: delivery.sessionId,
        agentId: agentCore?.getCurrentToolAgentId?.() ?? 'main',
        upload: delivery.upload,
        caption: delivery.caption,
      }),
    }),
  ]

  /**
   * Compact tail of the user's recent conversation with a persona, for
   * injection into prefix-command tasks. Without this, a `/fable mach das`
   * task has zero idea what "das" refers to. Deterministic (no LLM call):
   * last N user/assistant messages, oldest first, hard char cap.
   */
  function buildChatContextBlock(userId: string, agentId: string, maxMessages = 15, maxChars = 4000): string | null {
    try {
      const rows = db.prepare(
        `SELECT role, content FROM chat_messages
         WHERE user_id = ? AND agent_id = ? AND role IN ('user','assistant') AND content != ''
         ORDER BY id DESC LIMIT ?`
      ).all(Number(userId), agentId, maxMessages) as Array<{ role: string; content: string }>
      if (rows.length === 0) return null

      const lines: string[] = []
      let used = 0
      // rows are newest-first; walk and keep until the budget is spent, then
      // reverse so the block reads oldest → newest.
      for (const row of rows) {
        const text = row.content.length > 600 ? `${row.content.slice(0, 600)}…` : row.content
        const line = `${row.role === 'user' ? 'User' : 'Assistant'}: ${text}`
        if (used + line.length > maxChars) break
        lines.push(line)
        used += line.length
      }
      if (lines.length === 0) return null
      lines.reverse()
      return `<chat_context>\nRecent conversation with the user (oldest first) — use it to resolve references in the task:\n${lines.join('\n')}\n</chat_context>`
    } catch {
      return null
    }
  }

  /**
   * Start a one-off background task pinned to a specific model — backs the
   * /fable-style Telegram prefix commands. The task inherits the caller's
   * persona and links its session lineage to the user's interactive session
   * so the result routes back to the right chat and Telegram bot. The
   * default chat model is untouched.
   */
  async function startPinnedModelTask(input: {
    modelId: string
    prompt: string
    agentId: string
    userId: string | null
    source: string
  }): Promise<StartModelTaskResult> {
    const resolved = resolveProviderModelInput({ model: input.modelId })
    if (!resolved.ok) throw new Error(resolved.error)
    const baseProvider = resolveProvider(resolved.providerId)
    if (!baseProvider) throw new Error(`Provider "${resolved.providerName}" not found`)
    // Narrow the provider clone to the pinned model — the task runner derives
    // its model via getProviderDefaultModel() (= enabledModels[0]).
    const provider = { ...baseProvider, enabledModels: [resolved.modelId] }

    const promptPreview = input.prompt.length > 60 ? `${input.prompt.slice(0, 60)}…` : input.prompt
    const contextBlock = input.userId
      ? buildChatContextBlock(String(input.userId), input.agentId)
      : null
    const taskPrompt = contextBlock
      ? `${contextBlock}\n\nTask: ${input.prompt}`
      : input.prompt
    const task = taskRuntime.tasks.create({
      name: `${resolved.modelId}: ${promptPreview}`,
      prompt: taskPrompt,
      triggerType: 'user',
      provider: provider.name,
      model: resolved.modelId,
      isDefaultModel: false,
      maxDurationMinutes: taskSettings.maxDurationMinutes,
      agentId: input.agentId,
    })

    // Link lineage to the user's interactive session so
    // resolveTargetUserIdForTask delivers the result to this user.
    let parentSessionId: string | null = null
    if (agentCore && input.userId) {
      parentSessionId = agentCore.getSessionManager()
        .getOrCreateSession(String(input.userId), input.source, input.agentId).id
    }
    await taskRuntime.tasks.start(task, provider, undefined, parentSessionId)

    return {
      taskId: task.id,
      taskName: task.name,
      providerName: provider.name,
      modelId: resolved.modelId,
    }
  }

  /**
   * Draft a short execution plan for a pinned-model task BEFORE the heavy
   * model starts — shown to the user for ✅/❌ approval. Runs on the
   * verification provider when configured (cheap/local), else the active
   * chat provider. Never on the heavy target model itself.
   */
  async function draftTaskPlan(input: { prompt: string; agentId: string; userId: string | null }): Promise<string> {
    const cfg = getCurrentTaskSettings().verification
    const provider = (cfg.providerId ? resolveProvider(cfg.providerId) : null) ?? getActiveProvider()
    if (!provider) throw new Error('No provider available for plan drafting')

    const model = buildModel(provider, getProviderDefaultModel(provider) || undefined)
    const apiKey = await getApiKeyForProvider(provider)
    const contextBlock = input.userId ? buildChatContextBlock(String(input.userId), input.agentId, 8, 2000) : null

    // Hard timeout: the user is actively waiting for the ✅/❌ buttons, and
    // a dead local endpoint would otherwise hang this forever (the caller
    // falls back to a direct start on error).
    const response = await withTimeout(completeSimple(model, {
      systemPrompt:
        'You draft execution plans for autonomous background tasks. ' +
        'Produce a concise plan: max 6 short bullet points, concrete steps, no preamble, no closing remarks. ' +
        'If the request is ambiguous, make the most reasonable assumption and note it as the last bullet.',
      messages: [{
        role: 'user' as const,
        content: `${contextBlock ? `${contextBlock}\n\n` : ''}Task request: ${input.prompt}`,
        timestamp: Date.now(),
      }],
    }, {
      apiKey,
      temperature: 0,
    }), 60_000, 'Task plan draft')

    const text = response.content
      .filter((item) => item.type === 'text')
      .map((item) => (item as { type: 'text'; text: string }).text)
      .join('')
      .trim()
    if (!text) throw new Error('Plan drafting returned no text')
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  }

  /**
   * The one implementation of "answer a background task" (see task-reply.ts).
   * Telegram and `POST /api/tasks/:id/reply` both dispatch into this; only
   * the formatting differs.
   */
  const replyToTask: ReplyToTask = createTaskReply({
    tasks: taskRuntime.tasks,
    resolveProvider,
    getDefaultProvider: () => getTaskDefaultProvider(),
    getMaxDurationMinutes: () => taskSettings.maxDurationMinutes,
    getParentSessionId: (userId, source, agentId) => agentCore
      ? agentCore.getSessionManager().getOrCreateSession(String(userId), source, agentId).id
      : null,
  })

  /**
   * Telegram formatting of {@link replyToTask}. paused → resume with the
   * user's text; running → status hint; finished → follow-up task on the same
   * provider/model + persona, carrying the previous prompt/result as context.
   * The strings are the ones Telegram has always sent.
   */
  async function handleTelegramTaskReply(input: {
    taskId: string
    text: string
    agentId: string
    userId: string | null
    source: string
  }): Promise<string> {
    try {
      const result = await replyToTask(input)
      return result.message
    } catch (err) {
      if (err instanceof TaskReplyNotFoundError) return '⚠️ Task not found (may have been cleaned up).'
      if (err instanceof TaskReplyNotResumableError) return '⚠️ Task could not be resumed.'
      throw err
    }
  }

  /**
   * Inline-button actions on Telegram task messages: kill a running task or
   * store 👍/👎 feedback as a memory fact (picked up by the nightly
   * consolidation, so personas learn what worked).
   */
  async function handleTelegramTaskAction(input: {
    taskId: string
    action: 'kill' | 'feedback_up' | 'feedback_down'
    agentId: string
    userId: string | null
  }): Promise<string> {
    const task = taskRuntime.tasks.getById(input.taskId)
    if (!task) return 'Task not found.'

    if (input.action === 'kill') {
      if (task.status !== 'running' && task.status !== 'paused') {
        return `Task is already ${task.status}.`
      }
      taskRuntime.tasks.abort(input.taskId, 'Killed via Telegram button')
      return '🗑 Task killed.'
    }

    const positive = input.action === 'feedback_up'
    const numericUserId = input.userId ? parseStrictUserId(input.userId) : null
    storeFact(
      db,
      numericUserId,
      task.sessionId ?? `task-feedback-${task.id}`,
      `User rated the result of background task "${task.name}" (persona: ${input.agentId}, model: ${task.model ?? 'default'}) as ${positive ? 'good 👍' : 'not good 👎'}.${positive ? '' : ' When handling similar tasks, reconsider the approach that was used here.'}`,
      'main',
      // An explicit rating by the user is an owner fact even though it
      // refers to a task session (SPEC 11.4).
      { provenance: 'owner', sessionKind: 'task' },
    )
    return positive ? '👍 Feedback saved.' : '👎 Feedback saved — flows into memory consolidation.'
  }

  taskRuntime.schedules.start()

  const healthMonitorService = new HealthMonitorService({ db, providerManager: null })
  healthMonitorService.start()

  quotaMonitorService.start()

  const consolidationScheduler = new MemoryConsolidationScheduler({
    db,
    agentCore: null,
    taskRuntime: taskRuntime.tasks,
    // Memory consolidation is text processing, not orchestration — pinnable
    // via modelPolicy.roles["task:consolidation"].
    getDefaultProvider: () => getTaskDefaultProvider(null, 'consolidation'),
    sessionManager: backgroundSessions,
  })
  consolidationScheduler.start()

  const agentHeartbeatService = new AgentHeartbeatService({
    taskRuntime: taskRuntime.tasks,
    // The hourly grid load — pinnable via modelPolicy.roles["task:heartbeat"].
    getDefaultProvider: () => getTaskDefaultProvider(null, 'heartbeat'),
  })
  agentHeartbeatService.start()

  const uploadCleanupService = new UploadCleanupService(db)
  uploadCleanupService.start()

  // Only the events the turn runner does not already stream to every attached
  // channel; the assistant side of a Telegram turn reaches web clients through
  // their own runner subscription.
  const onTelegramChatEvent = (event: TelegramChatEvent) => {
    if (event.userId == null) return
    chatEventBus.broadcast({
      type: event.type,
      userId: event.userId,
      source: 'telegram',
      sessionId: event.sessionId,
      text: event.text,
      senderName: event.senderName,
      attachment: event.attachment,
      replyContext: event.replyContext,
      agentId: event.agentId,
    })
  }

  function wireAgentCoreEvents(): void {
    if (!agentCore) return

    agentCore.setOnSessionEnd((
      userId: string,
      sessionId: string,
      summary: string | null,
      agentId: string,
      opts,
    ) => {
      const numericUserId = parseNumericUserId(userId)
      const isBackground = !!opts?.background
      // The parked-thread sweep closed a thread the user is NOT currently in.
      // The divider row below still belongs into that thread's history, but a
      // live `session_end` frame would render a divider in whichever thread is
      // open and reset the client's cached session binding.
      const isParked = !!opts?.parked

      // CRITICAL: `sessionId` is the id of the session that just ENDED,
      // explicitly captured by SessionManager.handleNewCommandAsync at the
      // moment the user clicked "New Session". Do NOT replace it with any
      // "current session" lookup (e.g. `sessionManager.getSession(userId)`)
      // — by the time a background summary lands, the user is already
      // chatting in the new session and that lookup would return the
      // wrong id, causing the divider row + summary to be written into
      // the NEW session's transcript instead of the OLD one.
      const dividerMetadata = JSON.stringify({ type: 'session_divider', summary: summary ?? null })
      // Date the divider at the session's end, not at `now`: a background
      // summary lands seconds after the user already sent messages in the new
      // session, and chat history is ordered by timestamp — a `now` divider
      // would reappear *below* those messages after a page reload.
      db.prepare(
        // RC1–3: agent_id on every INSERT (write-path discipline).
        // Upstream 1cd455c2: date the divider at the session's end via
        // COALESCE(ended_at, now()). Both columns kept.
        `INSERT INTO chat_messages (session_id, user_id, role, content, metadata, agent_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT ended_at FROM sessions WHERE id = ?), datetime('now')))`
      ).run(sessionId, numericUserId, 'system', summary ?? '', dividerMetadata, agentId, sessionId)

      if (numericUserId !== null && !isParked) {
        if (isBackground) {
          // Background path: the originating client already received a
          // `session_end` (without text) the moment it clicked
          // "New Session". Re-broadcasting `session_end` here would
          // render a duplicate divider, so we instead emit a dedicated
          // `session_summary` event. The carried `sessionId` is the
          // *ended* session's id so clients can match it back to the
          // empty divider they already rendered and fill in the
          // summary in place. Clients that hadn't seen the immediate
          // `session_end` (e.g. another browser tab) treat the event
          // as a signal to render a fresh divider for the old
          // session.
          if (summary) {
            chatEventBus.broadcast({
              type: 'session_summary',
              userId: numericUserId,
              source: 'web',
              sessionId,
              text: summary,
              agentId,
            })
          }
        } else {
          // Synchronous path (timeout, provider_change): broadcast
          // `session_end` with the summary so every connected client
          // renders a divider in one shot.
          chatEventBus.broadcast({
            type: 'session_end',
            userId: numericUserId,
            source: 'web',
            // The ENDED session, so thread-aware clients can attribute the divider.
            sessionId,
            text: summary ?? undefined,
            agentId,
          })
        }
      }

      triggerFactExtractionForSessionEnd({
        db,
        agentCore,
        userId,
        sessionId,
      })

      // Offtangent Stufe 2: the one extra look a closing strand gets, so a
      // conversation that ends before the throttle would fire again is still
      // classified. Fire and forget, like the fact extraction above.
      triggerProjectAssignment({ db, sessionId, trigger: 'session_end', chatEventBus })
    })

    // Per-injection streaming state, keyed by the unique `injectionId`
    // (NOT the session id). Concurrent injections for the same user
    // share a session id, so keying by session id would cross-contaminate
    // their buffers. `telegramDelivered` is per-injection too so the
    // broadcast on `done` reflects the right delivery state.
    const streamStateByInjection = new Map<string, TaskInjectionTranscript>()

    agentCore.setOnTaskInjectionChunk((chunk) => {
      // Correlate the chunk with its pending metadata via `chunk.injectionId`,
      // which AgentCore guarantees to equal the per-injection UUID we
      // registered in `pendingInjections`. Keying by session id would
      // collide across concurrent injections targeting the same user's
      // origin strand. This is why each injection needs its own token.
      const injectionId = chunk.injectionId
      if (!injectionId) {
        logger.warn('[axiom] Task injection chunk has no injectionId; dropping')
        return
      }
      const pendingMeta = pendingInjections.get(injectionId)
      if (!pendingMeta) {
        logger.warn(`[axiom] No pending injection for injectionId ${injectionId}; dropping chunk`)
        return
      }
      const persistSessionId = pendingMeta.sessionId

      let streamState = streamStateByInjection.get(injectionId)
      if (!streamState) {
        streamState = new TaskInjectionTranscript()
        streamStateByInjection.set(injectionId, streamState)
        // From here until `done` this strand has a writer: see
        // `liveInjectionsByStrand`.
        markInjectionStreaming(persistSessionId)
      }

      try {
        // A file the reaction sent gets its own frame, exactly like an
        // interactive turn's: without it the answer arrives and the file it
        // talks about does not. No `messageId` — the row is written on `done`,
        // so the card belongs to the reaction that is still streaming.
        for (const upload of streamState.record(chunk)) {
          chatEventBus.broadcast({
            type: 'attachment',
            userId: pendingMeta.userId,
            source: 'task',
            sessionId: persistSessionId,
            agentId: pendingMeta.agentId,
            attachment: upload,
          })
        }

        if (chunk.type === 'done') {
          const responseText = streamState.responseText

          // An empty injection response is dropped by design below — but it
          // must never be INVISIBLE: log it so "task finished but user never
          // heard about it" (incident 2026-07-20) is diagnosable.
          if (!responseText && streamState.uploads.length === 0) {
            logger.warn(`[axiom] Task injection ${pendingMeta.taskId} produced an empty response — nothing delivered to user ${pendingMeta.userId}`)
          }

          // Route the Telegram delivery to the persona's own bot.
          const resolvedBot = resolveTelegramBotForAgent(pendingMeta.agentId)
          if (resolvedBot && responseText) {
            const shouldSend =
              taskSettings.telegramDelivery === 'always' ||
              (taskSettings.telegramDelivery === 'auto' && !(wsChatPresenceChecker?.(pendingMeta.userId) ?? false))

            if (shouldSend) {
              const chatId = resolvedBot.getTelegramChatIdForUser(pendingMeta.userId)
              if (chatId) {
                streamState.telegramDelivered = true
                resolvedBot.sendFormattedMessage(chatId, responseText, pendingMeta.taskId).catch(err => {
                  logger.error(`[axiom] Failed to send Telegram for task ${pendingMeta.taskId}:`, err)
                })
              }
            }
          }

          try {
            // Persist under the injection session — same id the task-result
            // row was written under in `deliverTaskNotification`, so both
            // rows live together and are reachable via
            // `buildConversationHistory`.
            streamState.persist(db, {
              sessionId: persistSessionId,
              userId: pendingMeta.userId,
              agentId: pendingMeta.agentId,
            })
          } catch (err) {
            logger.error('[axiom] Failed to persist task injection response:', err)
          }
        }

        try {
          chatEventBus.broadcast({
            type: chunk.type === 'done' ? 'done' : chunk.type,
            userId: pendingMeta.userId,
            source: 'task',
            sessionId: persistSessionId,
            text: chunk.text,
            toolName: chunk.toolName,
            toolCallId: chunk.toolCallId,
            toolArgs: chunk.toolArgs,
            toolResult: chunk.toolResult,
            toolIsError: chunk.toolIsError,
            error: chunk.error,
            telegramDelivered: chunk.type === 'done' ? streamState.telegramDelivered : undefined,
            isTaskInjection: true,
          })
        } catch (err) {
          logger.error('[axiom] Failed to broadcast task injection chunk:', err)
        }
      } finally {
        if (chunk.type === 'done') {
          // The ack (W4): the injection reached a real agent run and that run
          // finished. A turn that carried an `error` chunk is NOT acked — it
          // stays pending so the sweeper re-delivers it later.
          try {
            if (streamState.failed) {
              markTaskInjectionFailed(db, injectionId, 'injection turn ended with an error chunk')
              logger.warn(`[axiom] Task injection ${injectionId} failed mid-turn; keeping it queued for re-delivery`)
            } else {
              markTaskInjectionDelivered(db, injectionId)
            }
          } catch (err) {
            logger.error(`[axiom] Failed to acknowledge task injection ${injectionId}:`, err)
          }
          // Clear per-injection state regardless of success/failure so
          // stale buffers can't leak into a subsequent injection.
          if (streamStateByInjection.delete(injectionId)) unmarkInjectionStreaming(persistSessionId)
          pendingInjections.delete(injectionId)
        }
      }
    })
  }

  async function restartTelegramBot(): Promise<void> {
    if (!agentCore) {
      logger.warn('[axiom] Cannot start Telegram bot: no agent core initialized')
      return
    }

    unregisterTelegramEmailApproval?.()
    unregisterTelegramEmailApproval = null

    // Stop existing pool if any
    if (telegramBotPool) {
      try {
        await telegramBotPool.stop()
      } catch {
        // ignore
      }
      telegramBotPool = null
      telegramBot = null
    }

    // Stop existing single bot if any
    if (telegramBot) {
      try {
        await telegramBot.stop()
      } catch {
        // ignore
      }
      telegramBot = null
    }

    const multiPersonaSettings = loadMultiPersonaSettings()

    if (multiPersonaSettings.enabled) {
      // Multi-persona mode: one bot per persona account via TelegramBotPool.
      const pool = createTelegramBotPool({
        agentCore,
        db,
        onChatEvent: onTelegramChatEvent,
        // Per-bot depth changes report the pool-wide aggregate so the
        // metric reflects total telegram backlog, not the last bot's.
        onQueueDepthChanged: () => runtimeMetrics.setQueueDepth('telegram', pool.getQueueDepth()),
        startModelTask: startPinnedModelTask,
        onTaskReply: handleTelegramTaskReply,
        onTaskAction: handleTelegramTaskAction,
        draftTaskPlan,
        // NOTE: deliberately NOT sharing the process-wide `turnRunner` here.
        // Pool bots serve DIFFERENT personas but a linked user resolves to the
        // same numeric user id across all of them (resolveUserId), which is
        // also the TurnRunner subscription key. Sharing one runner would group
        // distinct personas' turns under one key and could surface persona A's
        // turn to a persona-B / web subscriber. Each pool bot therefore gets
        // its own TurnRunner (bot.ts fallback), keeping personas isolated;
        // every bot still persists chat_messages with its own agent_id.
        onActiveProviderChanged: () => {
          initOrUpdateAgentCore().catch((err) => {
            logger.error('[axiom] Error rebuilding agent core after Telegram provider change:', err)
          })
        },
      })
      telegramBotPool = pool

      try {
        await telegramBotPool.start()
        // Point telegramBot at the primary bot for backward compatibility
        // (reminders, status updates, single-bot callers).
        telegramBot = telegramBotPool.getPrimaryBot()
        // Email approval notifications route through the primary bot in pool
        // mode too, so the upstream email-approval feature keeps working when
        // multi-persona is enabled. Cleanup is symmetric via
        // unregisterTelegramEmailApproval in the stop/shutdown paths.
        if (telegramBot) {
          unregisterTelegramEmailApproval = registerEmailApprovalNotifier(telegramBot.createEmailApprovalNotifier())
        }
        if (telegramBotPool.hasRunningBots()) {
          logger.log('[axiom] Telegram bot pool (re)started')
        } else {
          logger.log('[axiom] Telegram bot pool: no bots configured or all disabled')
        }
      } catch (err) {
        logger.error('[axiom] Failed to start Telegram bot pool:', err)
        telegramBotPool = null
        telegramBot = null
      }
      return
    }

    // Legacy single-bot mode
    telegramBot = createTelegramBot(
      agentCore,
      db,
      onTelegramChatEvent,
      (queueDepth) => runtimeMetrics.setQueueDepth('telegram', queueDepth),
      {
        startModelTask: startPinnedModelTask,
        onTaskReply: handleTelegramTaskReply,
        onTaskAction: handleTelegramTaskAction,
        draftTaskPlan,
        // Upstream 0.27.0: share the one process-wide TurnRunner so a turn
        // started in Telegram streams into a concurrently-open web tab and a
        // manual retry cannot race a second, channel-local runner.
        turnRunner,
        onActiveProviderChanged: () => {
          initOrUpdateAgentCore().catch((err) => {
            logger.error('[axiom] Error rebuilding agent core after Telegram provider change:', err)
          })
        },
      },
    )
    if (telegramBot) {
      try {
        await telegramBot.start()
        unregisterTelegramEmailApproval = registerEmailApprovalNotifier(telegramBot.createEmailApprovalNotifier())
        logger.log('[axiom] Telegram bot (re)started')
      } catch (err) {
        logger.error('[axiom] Failed to start Telegram bot:', err)
        telegramBot = null
      }
    } else {
      logger.log('[axiom] Telegram bot disabled or not configured')
    }
  }

  /**
   * Wire fallback/recovery listeners onto a (new) ProviderManager. The
   * `providerManager !== manager` guard makes listeners of superseded
   * managers inert after a later hot-swap.
   */
  function registerProviderManagerListeners(manager: ProviderManager): void {
    manager.on('mode:fallback', async () => {
      if (!agentCore || providerManager !== manager) return
      const effectiveProvider = manager.getEffectiveProvider()
      if (!effectiveProvider) return

      try {
        const fbModelId = getFallbackModelId()
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key, fbModelId ?? undefined)
        logger.log(`[axiom] Swapped to fallback provider: ${effectiveProvider.name} (${fbModelId ?? getProviderDefaultModel(effectiveProvider)})`)
      } catch (err) {
        logger.error('[axiom] Failed to swap to fallback provider:', err)
      }
    })

    manager.on('mode:normal', async () => {
      if (!agentCore || providerManager !== manager) return
      const effectiveProvider = manager.getEffectiveProvider()
      if (!effectiveProvider) return

      try {
        const actModelId = getActiveModelId()
        const key = await getApiKeyForProvider(effectiveProvider)
        agentCore.swapProvider(effectiveProvider, key, actModelId ?? undefined)
        logger.log(`[axiom] Swapped back to primary provider: ${effectiveProvider.name} (${actModelId ?? getProviderDefaultModel(effectiveProvider)})`)
      } catch (err) {
        logger.error('[axiom] Failed to swap to primary provider:', err)
      }
    })
  }

  /**
   * C4 (per-agent/persona model): pin each persona runtime listed in
   * multiPersona.perAgentProvider to its own provider/model so a global model
   * change (Settings, Telegram /model, fallback) no longer overrides it. Called
   * after every (hot-swap or full-rebuild) provider update so pins survive
   * global swaps. Best-effort: a broken persona spec is logged and skipped.
   */
  async function applyPerAgentProviderPins(): Promise<void> {
    if (!agentCore) return
    const personaSettings = loadMultiPersonaSettings()
    if (!personaSettings.enabled || !personaSettings.perAgentProvider) return
    for (const [agentId, spec] of Object.entries(personaSettings.perAgentProvider)) {
      const pinned = resolveProviderModelString(spec)
      if (!pinned) {
        logger.warn(`[axiom] perAgentProvider: cannot resolve "${spec}" for persona "${agentId}" — skipping pin`)
        continue
      }
      try {
        const apiKey = await getApiKeyForProvider(pinned)
        agentCore.swapProviderForAgent(agentId, pinned, apiKey, getProviderDefaultModel(pinned))
      } catch (err) {
        logger.error(`[axiom] perAgentProvider: failed to pin persona "${agentId}":`, err)
      }
    }
  }

  async function initOrUpdateAgentCore(): Promise<void> {
    const provider = getActiveProvider()
    if (!provider) {
      logger.warn('[axiom] No provider configured — chat will be unavailable. Configure a provider in Settings.')
      return
    }

    // HOT SWAP: when an agent core already exists, a provider/model change
    // must NOT end sessions, wipe conversations, or restart the Telegram
    // bots. swapProvider is the same conversation-preserving mechanism the
    // fallback machinery uses mid-stream. Falls back to a full rebuild on
    // any error.
    if (agentCore) {
      try {
        const activeModelId = getActiveModelId()
        const apiKey = await getApiKeyForProvider(provider)
        const fallbackProvider = getFallbackProvider()

        const manager = new ProviderManager(provider, fallbackProvider)
        registerProviderManagerListeners(manager)
        providerManager = manager
        healthMonitorService.setProviderManager(manager)

        agentCore.setProviderManager(manager)
        agentCore.swapProvider(provider, apiKey, activeModelId ?? undefined)
        await applyPerAgentProviderPins()
        agentCore.refreshSystemPrompt()

        logger.log(`[axiom] Provider hot-swapped to ${provider.name} (${activeModelId ?? getProviderDefaultModel(provider)}) — sessions preserved`)
        return
      } catch (err) {
        logger.error('[axiom] Provider hot-swap failed — falling back to full rebuild:', err)
      }
    }

    const previousAgentCore = agentCore

    try {
      if (previousAgentCore) {
        try {
          await previousAgentCore.endAllSessions()
        } catch (err) {
          logger.error('[axiom] Failed to end sessions before provider change:', err)
        }

        try {
          await previousAgentCore.dispose()
        } catch (err) {
          logger.error('[axiom] Failed to dispose previous agent core:', err)
        }
      }

      const activeModelId = getActiveModelId()
      const model = buildModel(provider, activeModelId ?? undefined)
      const apiKey = await getApiKeyForProvider(provider).catch((err) => {
        logger.error('[axiom] Failed to resolve active provider API key; chat may be unavailable until provider auth is fixed, but Telegram commands will still start:', err)
        return provider.apiKey || 'no-key'
      })
      const fallbackProvider = getFallbackProvider()

      providerManager = new ProviderManager(provider, fallbackProvider)

      agentCore = new AgentCore({
        model,
        apiKey,
        db,
        tools: agentTools,
        providerConfig: provider,
        providerManager,
        sessionTimeoutMinutes,
        quotaService: quotaMonitorService,
        resolveTurnModel: async ({ sessionId, agentId, turnOverride }) => {
          // Recheck after the queue lock: a provider can be disabled while a
          // message waits. An explicit choice must fail, not silently downgrade.
          if (turnOverride) {
            const checked = parseTurnModelSelection({ modelProviderId: turnOverride.providerId, modelId: turnOverride.modelId })
            if (!checked.ok) throw new Error(`${checked.code}: ${checked.error}`)
          }
          const file = loadProvidersDecrypted()
          const strand = db.prepare(
            'SELECT model_provider_id, model_id FROM sessions WHERE id = ?',
          ).get(sessionId) as { model_provider_id: string | null; model_id: string | null } | undefined
          const personaSpec = loadMultiPersonaSettings().perAgentProvider?.[agentId]
          const persona = personaSpec ? parseProviderModelId(personaSpec) : null
          const effective = resolveEffectiveModel({
            turnOverride,
            strandPin: strand?.model_provider_id && strand.model_id
              ? { providerId: strand.model_provider_id, modelId: strand.model_id }
              : null,
            personaPin: persona?.providerId && persona.modelId
              ? { providerId: persona.providerId, modelId: persona.modelId }
              : null,
            globalActive: file.activeProvider && file.activeModel
              ? { providerId: file.activeProvider, modelId: file.activeModel }
              : null,
            fallback: file.fallbackProvider && file.fallbackModel
              ? { providerId: file.fallbackProvider, modelId: file.fallbackModel }
              : null,
            providers: file.providers,
          })
          if (!effective) return null
          const selectedProvider = file.providers.find(candidate => candidate.id === effective.providerId)
          if (!selectedProvider) return null
          return {
            provider: selectedProvider,
            apiKey: await getApiKeyForProvider(selectedProvider),
            effective,
          }
        },
      })

      registerProviderManagerListeners(providerManager)

      healthMonitorService.setProviderManager(providerManager)
      consolidationScheduler.setAgentCore(agentCore)

      wireAgentCoreEvents()

      agentCore.init().catch(err => {
        logger.error('[axiom] Error during agentCore.init():', err)
      })

      await applyPerAgentProviderPins()

      await restartTelegramBot()

      logger.log(`[axiom] Agent core initialized with provider: ${provider.name} (${activeModelId ?? getProviderDefaultModel(provider)})`)
      if (fallbackProvider) {
        const fallbackModelId = getFallbackModelId()
        logger.log(`[axiom] Fallback provider configured: ${fallbackProvider.name} (${fallbackModelId ?? getProviderDefaultModel(fallbackProvider)})`)
      }
    } catch (err) {
      logger.error('[axiom] Failed to initialize agent core:', err)
    }
  }

  await initOrUpdateAgentCore()

  // Backfill semantic vectors for memory rows that don't have one yet
  // (no-op when memoryEmbeddings is disabled). Fire-and-forget — lexical
  // search works regardless.
  backfillMemoryEmbeddings(db)
    .then((embedded) => {
      if (embedded > 0) logger.log(`[axiom] Memory embeddings: backfilled ${embedded} rows`)
      // Wiki page vectors and the nearest page per fact, for the semantic
      // fact to node assignment of the memory view. Runs after the backfill
      // so freshly embedded facts are matched in the same pass.
      return refreshMemoryPageIndex(db)
    })
    .then((result) => {
      if (!result) return
      if (result.pages.embedded > 0 || result.matches.computed > 0) {
        logger.log(
          `[axiom] Memory page index: ${result.pages.embedded} wiki pages embedded, `
          + `${result.matches.computed} facts matched in ${result.durationMs} ms`,
        )
      }
    })
    .catch((err) => logger.warn('[axiom] Memory embedding backfill failed:', err))

  // Recover tasks interrupted by the restart: running tasks are re-started
  // with a progress summary built from their stored tool calls; paused ones
  // are closed. (The recovery machinery existed in the runner but was never
  // wired — without this call, interrupted work was silently lost.)
  try {
    if (getActiveProvider()) {
      const recovery = await taskRuntime.tasks.recover(
        (name: string) => resolveProvider(name),
        getTaskDefaultProvider(),
      )
      if (recovery.resumed > 0 || recovery.failed > 0) {
        logger.log(`[axiom] Task recovery: ${recovery.resumed} resumed, ${recovery.failed} closed`)
      }
    }
  } catch (err) {
    logger.error('[axiom] Task recovery failed:', err)
  }

  // ---------------------------------------------------------------------
  // W4: resume robustness. Task recovery above restarts interrupted WORK;
  // this restarts the CONVERSATION about it. Without it, a result produced
  // while the container was down (or in flight when it went down) is a row
  // in `tasks` that nobody ever told the agent about — the "agent falls
  // asleep after a self-affecting deploy" failure mode.
  // ---------------------------------------------------------------------
  const deliverySettings = (() => {
    try {
      return loadHeuristics().taskDelivery
    } catch {
      return DEFAULT_HEURISTICS.taskDelivery
    }
  })()
  const deliveryLimits = {
    retryAfterMs: deliverySettings.retryAfterSeconds * 1000,
    maxAttempts: deliverySettings.maxAttempts,
    maxAgeMs: deliverySettings.maxAgeHours * 3600_000,
    batchLimit: deliverySettings.batchLimit,
  }

  const injectionSweeper = new TaskInjectionSweeper({
    db,
    // Re-delivery carries a banner so the agent can tell a repeat from a
    // fresh result. The sweeper counts the attempt itself.
    deliver: row => {
      deliverInjectionRun(
        { ...row, payload: formatRedeliveryPayload(row, 'retry') },
        { markAttempt: false },
      )
    },
    isDeliverable: () => Boolean(agentCore),
    intervalMs: deliverySettings.sweepIntervalSeconds * 1000,
    ...deliveryLimits,
    logger: {
      log: (msg, ...args) => logger.log(msg, ...args),
      warn: (msg, ...args) => logger.warn(msg, ...args),
      error: (msg, ...args) => logger.error(msg, ...args),
    },
  })

  function runBootResume(): void {
    // Runs even without an agent core: expiring stale rows and queueing the
    // restart notices is useful work, and `deliverInjectionRun` no-ops until
    // a core exists — the sweeper then picks the rows up.
    const pending = listPendingTaskInjections(db)

    // Which of the pending rows are worth a turn right now. `retryAfterMs: 0`
    // because nothing can be in flight one second after boot — the process
    // that owned those deliveries is gone. Rows beyond `batchLimit` stay
    // pending and the sweeper works them off over the next minutes; that is
    // the rate limit for a pathological backlog.
    const selection = selectInjectionsForRedelivery(pending, {
      now: Date.now(),
      retryAfterMs: 0,
      maxAttempts: deliveryLimits.maxAttempts,
      maxAgeMs: deliveryLimits.maxAgeMs,
      limit: deliveryLimits.batchLimit,
    })
    for (const { row, reason } of selection.expire) {
      abandonTaskInjection(db, row.id, reason)
      logger.warn(`[axiom] Boot resume: abandoned injection ${row.id} for task ${row.taskId}: ${reason}`)
    }

    // Tasks that are still running: either genuinely alive or just restarted
    // by `recover()`. Their originating session died with the container, so
    // the agent has to be told they exist.
    const runningTasks: RunningTaskSummary[] = []
    try {
      for (const task of taskRuntime.tasks.list({ status: 'running' })) {
        runningTasks.push({
          taskId: task.id,
          name: task.name,
          sessionId: resolveTaskStrandOrigin(db, task),
          agentId: task.agentId ?? 'main',
          userId: resolveTargetUserIdForTask(task.sessionId) ?? getFallbackUserId(),
          triggerType: task.triggerType,
          // `recoverTasks` names its replacement row "<name> (resumed)";
          // this only decorates the notice text, never a decision.
          resumed: task.name.endsWith('(resumed)'),
        })
      }
    } catch (err) {
      logger.warn('[axiom] Boot resume: could not list running tasks:', err)
    }

    // The plan sees ALL pending rows (not just this batch) so a strand that
    // gets a result later this minute does not also get a restart notice.
    const plan = planBootResume({
      pendingInjections: pending.map(row => ({
        id: row.id,
        taskId: row.taskId,
        sessionId: row.sessionId,
        agentId: row.agentId,
        userId: row.userId,
      })),
      runningTasks,
      maxNoticeTasks: deliverySettings.resumeNoticeMaxTasks,
      maxNotices: deliverySettings.resumeMaxNotices,
    })

    let redelivered = 0
    for (const row of selection.redeliver) {
      const ok = deliverInjectionRun({ ...row, payload: formatRedeliveryPayload(row, 'container_restart') })
      if (ok) redelivered++
    }

    let notices = 0
    for (const notice of plan.notices) {
      try {
        const row = enqueueTaskInjection(db, {
          taskId: notice.taskId,
          kind: 'resume_notice',
          userId: notice.userId,
          agentId: notice.agentId,
          sessionId: notice.sessionId,
          payload: notice.text,
        })
        if (deliverInjectionRun(row)) notices++
      } catch (err) {
        logger.error(`[axiom] Boot resume: could not queue restart notice for strand ${notice.sessionId}:`, err)
      }
    }

    if (pending.length > 0 || notices > 0 || runningTasks.length > 0) {
      logger.log(
        `[axiom] Boot resume: ${redelivered}/${pending.length} undelivered task result(s) re-injected, `
        + `${notices} restart notice(s) for ${runningTasks.length} running task(s)`,
      )
    }
  }

  try {
    runBootResume()
  } catch (err) {
    logger.error('[axiom] Boot resume failed:', err)
  }

  // W5/P3: an outcome that nobody was there to hear is announced at the next
  // run of its persona (see task-agent-notice.ts). One that sat unannounced
  // for longer than the delivery max age is closed out here instead of
  // surfacing days later — same age rule as the injection queue.
  // `maxAgeHours: 0` disables the age rule (see settings reference) — then
  // nothing is ever too old, and expiry must not run at all.
  if (deliveryLimits.maxAgeMs > 0) {
    try {
      const expired = expireStaleTaskNotices(db, { maxAgeMs: deliveryLimits.maxAgeMs })
      if (expired > 0) logger.log(`[axiom] Boot: ${expired} stale task outcome(s) marked as announced`)
    } catch (err) {
      logger.warn('[axiom] Could not expire stale task outcomes:', err)
    }
  }

  injectionSweeper.start()

  return {
    db,
    runtimeMetrics,
    healthMonitorService,
    quotaMonitorService,
    consolidationScheduler,
    agentHeartbeatService,
    uploadCleanupService,
    taskEventBus,
    chatEventBus,
    chatActions,
    turnRunner,
    pushSender,
    getAgentCore: () => agentCore,
    getTaskRuntime: () => taskRuntime,
    replyToTask,
    resolveProvider,
    getTaskDefaultProvider,
    getBackgroundTaskToolNames: () => backgroundTaskTools.map(t => t.name),
    getTelegramBot: () => telegramBot,
    onTelegramSettingsChanged: () => {
      restartTelegramBot().catch((err) => {
        logger.error('[axiom] Error restarting Telegram bot:', err)
      })
    },
    onActiveProviderChanged: () => {
      // initOrUpdateAgentCore only rebuilds the interactive core.
      rebuildBackgroundTaskTools()
      initOrUpdateAgentCore().catch((err) => {
        logger.error('[axiom] Error initializing agent core after provider change:', err)
      })
    },
    setWebSocketChatPresenceChecker: (checker) => {
      wsChatPresenceChecker = checker ? checker.hasActiveWebSocket : null
    },
    stopBackgroundServices: async () => {
      healthMonitorService.stop()
      quotaMonitorService.stop()
      consolidationScheduler.stop()
      agentHeartbeatService.stop()
      uploadCleanupService.stop()
      taskRuntime.schedules.stop()
      injectionSweeper.stop()

      unregisterTelegramEmailApproval?.()
      unregisterTelegramEmailApproval = null
      unregisterEmailApprovalChat()
      retryChatChannel?.unregister()
      retryChatChannel = null

      if (telegramBotPool) {
        try {
          await telegramBotPool.stop()
        } catch {
          // ignore
        }
        telegramBotPool = null
        telegramBot = null
      }

      if (telegramBot) {
        try {
          await telegramBot.stop()
        } catch {
          // ignore
        }
        telegramBot = null
      }
    },
  }
}
