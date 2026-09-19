export const HEALTH_MONITOR_FALLBACK_TRIGGERS = ['down', 'degraded'] as const
export type HealthMonitorFallbackTrigger = (typeof HEALTH_MONITOR_FALLBACK_TRIGGERS)[number]

export const TASK_TELEGRAM_DELIVERY_VALUES = ['auto', 'always'] as const
export type TaskTelegramDelivery = (typeof TASK_TELEGRAM_DELIVERY_VALUES)[number]

export const TASK_LOOP_DETECTION_METHODS = ['systematic', 'smart', 'auto'] as const
export type TaskLoopDetectionMethod = (typeof TASK_LOOP_DETECTION_METHODS)[number]

export const SETTINGS_TTS_PROVIDERS = ['openai', 'mistral', 'deepgram', 'gemini'] as const
export type TtsProvider = (typeof SETTINGS_TTS_PROVIDERS)[number]

/**
 * Gemini TTS models reachable through the Interactions API. The list is a
 * UI hint; the settings schema accepts any non-empty model id so a new
 * preview can be used before this list catches up.
 */
export const SETTINGS_TTS_GEMINI_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
] as const
export type TtsGeminiModel = (typeof SETTINGS_TTS_GEMINI_MODELS)[number]
export const DEFAULT_TTS_GEMINI_MODEL: TtsGeminiModel = 'gemini-3.1-flash-tts-preview'
export const DEFAULT_TTS_GEMINI_VOICE = 'Charon'

/** The 30 prebuilt Gemini voices with Google's one-word characterisation. */
export const SETTINGS_TTS_GEMINI_VOICES: ReadonlyArray<{ name: string; style: string }> = [
  { name: 'Zephyr', style: 'Bright' },
  { name: 'Puck', style: 'Upbeat' },
  { name: 'Charon', style: 'Informative' },
  { name: 'Kore', style: 'Firm' },
  { name: 'Fenrir', style: 'Excitable' },
  { name: 'Leda', style: 'Youthful' },
  { name: 'Orus', style: 'Firm' },
  { name: 'Aoede', style: 'Breezy' },
  { name: 'Callirrhoe', style: 'Easy-going' },
  { name: 'Autonoe', style: 'Bright' },
  { name: 'Enceladus', style: 'Breathy' },
  { name: 'Iapetus', style: 'Clear' },
  { name: 'Umbriel', style: 'Easy-going' },
  { name: 'Algieba', style: 'Smooth' },
  { name: 'Despina', style: 'Smooth' },
  { name: 'Erinome', style: 'Clear' },
  { name: 'Algenib', style: 'Gravelly' },
  { name: 'Rasalgethi', style: 'Informative' },
  { name: 'Laomedeia', style: 'Upbeat' },
  { name: 'Achernar', style: 'Soft' },
  { name: 'Alnilam', style: 'Firm' },
  { name: 'Schedar', style: 'Even' },
  { name: 'Gacrux', style: 'Mature' },
  { name: 'Pulcherrima', style: 'Forward' },
  { name: 'Achird', style: 'Friendly' },
  { name: 'Zubenelgenubi', style: 'Casual' },
  { name: 'Vindemiatrix', style: 'Gentle' },
  { name: 'Sadachbia', style: 'Lively' },
  { name: 'Sadaltager', style: 'Knowledgeable' },
  { name: 'Sulafat', style: 'Warm' },
]

export const SETTINGS_TTS_OPENAI_MODELS = ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'] as const
export type TtsOpenAiModel = (typeof SETTINGS_TTS_OPENAI_MODELS)[number]

/**
 * OpenAI voices. `gpt4oOnly` marks the ones only `gpt-4o-mini-tts` knows;
 * `tts-1`/`tts-1-hd` reject them. Served to clients via `GET /api/tts/catalog`.
 */
export const SETTINGS_TTS_OPENAI_VOICES: ReadonlyArray<{ name: string; gpt4oOnly?: boolean }> = [
  { name: 'alloy' },
  { name: 'ash' },
  { name: 'ballad', gpt4oOnly: true },
  { name: 'coral' },
  { name: 'echo' },
  { name: 'fable' },
  { name: 'nova' },
  { name: 'onyx' },
  { name: 'sage' },
  { name: 'shimmer' },
  { name: 'verse', gpt4oOnly: true },
  { name: 'marin', gpt4oOnly: true },
  { name: 'cedar', gpt4oOnly: true },
]

export const SETTINGS_TTS_RESPONSE_FORMATS = ['mp3', 'wav', 'opus', 'flac'] as const
export type TtsResponseFormat = (typeof SETTINGS_TTS_RESPONSE_FORMATS)[number]

/**
 * Which of the four user-facing formats each provider can actually deliver.
 * Gemini returns raw PCM that the core packages itself, so it is limited to
 * the two containers buildable without ffmpeg. One table for the synthesizer,
 * the catalog endpoint and the clients' format negotiation.
 */
export const SETTINGS_TTS_FORMATS_BY_PROVIDER: Record<TtsProvider, readonly TtsResponseFormat[]> = {
  openai: ['mp3', 'wav', 'opus', 'flac'],
  mistral: ['mp3', 'wav', 'opus', 'flac'],
  deepgram: ['mp3', 'wav', 'opus', 'flac'],
  gemini: ['opus', 'wav'],
}

export const SETTINGS_STT_PROVIDERS = ['whisper-url', 'openai', 'ollama', 'deepgram'] as const
export type SttProvider = (typeof SETTINGS_STT_PROVIDERS)[number]

export const SETTINGS_STT_OPENAI_MODELS = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] as const
export type SttOpenAiModel = (typeof SETTINGS_STT_OPENAI_MODELS)[number]

/**
 * Thinking / reasoning level for the agent.
 * - `off`: no reasoning (fastest, cheapest, default)
 * - `minimal` → `xhigh`: progressively more reasoning effort
 *
 * Note: `xhigh` is only supported by a subset of models (e.g. OpenAI gpt-5.x).
 * Providers that don't support the requested level usually map it down.
 */
export const SETTINGS_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const
export type SettingsThinkingLevel = (typeof SETTINGS_THINKING_LEVELS)[number]

export interface HealthMonitorNotificationTogglesContract {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

export interface HealthMonitorSettingsContract {
  enabled: boolean
  fallbackTrigger: HealthMonitorFallbackTrigger
  failuresBeforeFallback: number
  recoveryCheckIntervalMinutes: number
  successesBeforeRecovery: number
  notifications: HealthMonitorNotificationTogglesContract
}

export interface MemoryConsolidationSettingsContract {
  enabled: boolean
  runAtHour: number
  lookbackDays: number
  providerId: string
}

export interface FactExtractionSettingsContract {
  enabled: boolean
  providerId: string
  minSessionMessages: number
}

export interface UploadsSettingsContract {
  /**
   * How many days uploaded files in `/data/uploads/` are kept before the cleanup job
   * removes them. `0` means files are deleted on the next cleanup run.
   */
  retentionDays: number
}

/**
 * Provider-stall watchdog thresholds. Read by the turn runner at turn start,
 * so edits apply to the next turn without a backend restart.
 */
export interface WatchdogSettingsContract {
  stallWarnMs: number
  stallAbortMs: number
}

/** Auto-retry policy for turns that failed with a retryable provider error. */
export interface RetrySettingsContract {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
}

export const DEFAULT_WATCHDOG_SETTINGS: WatchdogSettingsContract = {
  stallWarnMs: 30_000,
  stallAbortMs: 90_000,
}

export const DEFAULT_RETRY_SETTINGS: RetrySettingsContract = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2_000,
}

export interface AgentHeartbeatNightModeContract {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface AgentHeartbeatSettingsContract {
  enabled: boolean
  intervalMinutes: number
  nightMode: AgentHeartbeatNightModeContract
}

/**
 * Multi-persona mode settings. When enabled, each persona gets its own
 * files under /data/agents/<id>/, isolated sessions + memory, and
 * optionally its own Telegram bot account.
 */
export interface MultiPersonaSettingsContract {
  enabled: boolean
  defaultAgentId: string
}

export interface TasksLoopDetectionSettingsContract {
  enabled: boolean
  method: TaskLoopDetectionMethod
  maxConsecutiveFailures: number
  smartProvider: string
  smartCheckInterval: number
}

export interface TasksStatusUpdatesSettingsContract {
  enabled: boolean
  intervalMinutes: number
}

export interface TasksVerificationSettingsContract {
  enabled: boolean
  providerId: string
}

export interface TasksSettingsContract {
  defaultProvider: string
  maxDurationMinutes: number
  telegramDelivery: TaskTelegramDelivery
  loopDetection: TasksLoopDetectionSettingsContract
  /**
   * Periodic `<task_status type="periodic_update">` signals from the task
   * runner back to the user's parent chat while a background task is
   * running. Disabled by default — enable it to get a visible heartbeat
   * (duration, tool-call count, token estimate) that is delivered via the
   * chat event bus and (optionally) Telegram without invoking the LLM.
   */
  statusUpdates: TasksStatusUpdatesSettingsContract
  /**
   * Independent reviewer pass over completed user/agent/cronjob task
   * results with one revision round on a failed verdict. `providerId`
   * routes the reviewer call to a specific provider (e.g. a local model);
   * empty string uses the task's own provider.
   */
  verification: TasksVerificationSettingsContract
  /**
   * Thinking level used for background task agents, the task runner's loop
   * detection calls, and internal background jobs (fact extraction, memory
   * consolidation, session summaries). Defaults to `off`.
   */
  backgroundThinkingLevel: SettingsThinkingLevel
}

export interface TtsSettingsContract {
  enabled: boolean
  provider: TtsProvider
  providerId: string
  openaiModel: TtsOpenAiModel
  openaiVoice: string
  openaiInstructions: string
  mistralVoice: string
  responseFormat: TtsResponseFormat
  deepgramModel: string
  deepgramApiKey: string
  /** Gemini TTS model id (Interactions API). */
  geminiModel: string
  /** One of the prebuilt Gemini voice names. */
  geminiVoice: string
  /**
   * Optional natural-language delivery instruction prepended to the text
   * ("Sprich ruhig und deutlich:"). Gemini TTS steers style from the prompt
   * itself, there is no separate instructions field.
   */
  geminiStyle: string
}

export interface SttRewriteSettingsContract {
  enabled: boolean
  providerId: string
}

export interface SttSettingsContract {
  enabled: boolean
  provider: SttProvider
  whisperUrl: string
  providerId: string
  openaiModel: SttOpenAiModel
  ollamaModel: string
  deepgramModel: string
  deepgramLanguage: string
  deepgramApiKey: string
  rewrite: SttRewriteSettingsContract
}

/** Default and bounds of `offtangent.nowSetMax`, mirrored from `strand-store.ts`. */
export const DEFAULT_NOW_SET_MAX = 4
export const NOW_SET_MAX_RANGE = { min: 1, max: 12 } as const

/** Offtangent-specific behaviour the product owner can tune. */
export interface OfftangentSettingsContract {
  /**
   * How many strands the now set holds. Lowering it never drops strands that
   * are already in the set; it only refuses further additions until the set
   * fits again.
   */
  nowSetMax: number
}

/** Upper bounds for `instanceIdentity`, enforced by `PUT /api/settings`. */
export const INSTANCE_IDENTITY_NAME_MAX_LENGTH = 120
export const INSTANCE_IDENTITY_NOTES_MAX_LENGTH = 4000

/**
 * Self-identification of this installation, rendered as `<runtime_instance>`
 * at the top of every system prompt (all prompt profiles, all personas).
 * An empty `name` disables the block entirely, so installations that never
 * set it get a byte-identical prompt. Meant for setups where several
 * instances run side by side and the agent must not infer which one it is
 * from retained upstream branding (`axiom.db`, `@axiom/*`, `<axiom_docs>`).
 */
export interface InstanceIdentitySettingsContract {
  /** Display name of this instance, e.g. `Offtangent`. Empty = block off. */
  name: string
  /** Free-text facts about the instance (host, port, neighbours, caveats). */
  notes: string
}

/**
 * Telegram bot settings exposed via the Settings API.
 *
 * On disk these fields live in `/data/config/telegram.json`, not in
 * `settings.json`. The API still nests them under a `telegram` object so the
 * shape mirrors other namespaced groups (`tasks`, `agentHeartbeat`, ...).
 */
export interface TelegramSettingsContract {
  enabled: boolean
  botToken: string
  /** Input batching delay in ms. `0` disables batching. */
  batchingDelayMs: number
  sendVoiceReply: boolean
  /**
   * Deliver provider-stall warnings to Telegram. Off by default so transient
   * hiccups don't spam the chat; terminal errors are always delivered.
   */
  sendStallWarnings: boolean
}

export interface SettingsContract {
  sessionTimeoutMinutes: number
  sessionSummaryProviderId: string
  language: string
  timezone: string
  /**
   * Thinking level used for the main chat agent (web + telegram).
   * Defaults to `off` so existing installations keep zero-cost behavior.
   */
  thinkingLevel: SettingsThinkingLevel
  healthMonitorIntervalMinutes: number
  uploads: UploadsSettingsContract
  watchdog: WatchdogSettingsContract
  retry: RetrySettingsContract
  telegram: TelegramSettingsContract
  healthMonitor: HealthMonitorSettingsContract
  memoryConsolidation: MemoryConsolidationSettingsContract
  factExtraction: FactExtractionSettingsContract
  agentHeartbeat: AgentHeartbeatSettingsContract
  multiPersona: MultiPersonaSettingsContract
  tasks: TasksSettingsContract
  tts: TtsSettingsContract
  stt: SttSettingsContract
  offtangent: OfftangentSettingsContract
  instanceIdentity: InstanceIdentitySettingsContract
}

export type SettingsUpdateContract = DeepPartial<SettingsContract>

export interface SettingsStorageContract {
  sessionTimeoutMinutes?: number
  sessionSummaryProviderId?: string
  language?: string
  timezone?: string
  thinkingLevel?: SettingsThinkingLevel
  healthMonitorIntervalMinutes?: number
  healthMonitor?: Partial<HealthMonitorSettingsContract> & { intervalMinutes?: number }
  uploads?: Partial<UploadsSettingsContract>
  watchdog?: Partial<WatchdogSettingsContract>
  retry?: Partial<RetrySettingsContract>
  memoryConsolidation?: Partial<MemoryConsolidationSettingsContract>
  factExtraction?: Partial<FactExtractionSettingsContract>
  agentHeartbeat?: Partial<AgentHeartbeatSettingsContract>
  multiPersona?: Partial<MultiPersonaSettingsContract>
  tasks?: Partial<TasksSettingsContract>
  tts?: Partial<TtsSettingsContract>
  stt?: Partial<SttSettingsContract>
  offtangent?: Partial<OfftangentSettingsContract>
  instanceIdentity?: Partial<InstanceIdentitySettingsContract>
}

export interface TelegramSettingsStorageContract {
  enabled?: boolean
  botToken?: string
  adminUserIds?: number[]
  pollingMode?: boolean
  webhookUrl?: string
  batchingDelayMs?: number
  sendVoiceReply?: boolean
  sendStallWarnings?: boolean
}

export type HealthMonitorSettingsUpdateContract = DeepPartial<HealthMonitorSettingsContract> & {
  intervalMinutes?: number
}

export type LegacyCompatibleSettingsUpdateContract = SettingsUpdateContract & {
  healthMonitor?: HealthMonitorSettingsUpdateContract
}

export const DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES: HealthMonitorNotificationTogglesContract = {
  healthyToDegraded: false,
  degradedToHealthy: false,
  degradedToDown: true,
  healthyToDown: true,
  downToFallback: true,
  fallbackToHealthy: true,
}

export const DEFAULT_SETTINGS_CONTRACT: SettingsContract = {
  sessionTimeoutMinutes: 30,
  sessionSummaryProviderId: '',
  language: 'match',
  timezone: 'UTC',
  thinkingLevel: 'off',
  healthMonitorIntervalMinutes: 5,
  uploads: {
    retentionDays: 30,
  },
  watchdog: { ...DEFAULT_WATCHDOG_SETTINGS },
  retry: { ...DEFAULT_RETRY_SETTINGS },
  telegram: {
    enabled: false,
    botToken: '',
    batchingDelayMs: 2500,
    sendVoiceReply: false,
    sendStallWarnings: false,
  },
  healthMonitor: {
    enabled: true,
    fallbackTrigger: 'down',
    failuresBeforeFallback: 1,
    recoveryCheckIntervalMinutes: 1,
    successesBeforeRecovery: 3,
    notifications: { ...DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES },
  },
  memoryConsolidation: {
    enabled: true,
    runAtHour: 3,
    lookbackDays: 3,
    providerId: '',
  },
  factExtraction: {
    enabled: true,
    providerId: '',
    minSessionMessages: 3,
  },
  agentHeartbeat: {
    enabled: false,
    intervalMinutes: 60,
    nightMode: {
      enabled: true,
      startHour: 23,
      endHour: 8,
    },
  },
  multiPersona: {
    enabled: false,
    defaultAgentId: 'main',
  },
  tasks: {
    defaultProvider: '',
    maxDurationMinutes: 60,
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
    backgroundThinkingLevel: 'off',
  },
  tts: {
    enabled: false,
    provider: 'openai',
    providerId: '',
    openaiModel: 'gpt-4o-mini-tts',
    openaiVoice: 'nova',
    openaiInstructions: '',
    mistralVoice: '',
    responseFormat: 'mp3',
    deepgramModel: 'aura-2-thalia-en',
    deepgramApiKey: '',
    geminiModel: DEFAULT_TTS_GEMINI_MODEL,
    geminiVoice: DEFAULT_TTS_GEMINI_VOICE,
    geminiStyle: '',
  },
  stt: {
    enabled: false,
    provider: 'whisper-url',
    whisperUrl: '',
    providerId: '',
    openaiModel: 'whisper-1',
    ollamaModel: '',
    deepgramModel: 'nova-3',
    deepgramLanguage: '',
    deepgramApiKey: '',
    rewrite: {
      enabled: false,
      providerId: '',
    },
  },
  offtangent: {
    nowSetMax: DEFAULT_NOW_SET_MAX,
  },
  instanceIdentity: {
    name: '',
    notes: '',
  },
}

function normalizeThinkingLevel(
  value: SettingsThinkingLevel | undefined,
  fallback: SettingsThinkingLevel,
): SettingsThinkingLevel {
  if (value && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(value)) {
    return value
  }
  return fallback
}

/**
 * Normalize `tasks.statusUpdates` with migration from the legacy flat
 * `tasks.statusUpdateIntervalMinutes` field. When only the legacy value is
 * present, it is carried over as the interval; `enabled` stays `false` so
 * existing installations don't suddenly start emitting status-update chat
 * messages after upgrading. Setups that had explicitly set the legacy value
 * to a custom interval keep that interval — only the explicit opt-in is
 * new.
 */
function normalizeTasksStatusUpdates(
  source: DeepPartial<TasksSettingsContract> | undefined,
): TasksStatusUpdatesSettingsContract {
  const fallback = DEFAULT_SETTINGS_CONTRACT.tasks.statusUpdates
  const statusUpdates = source?.statusUpdates
  const legacyInterval = (source as { statusUpdateIntervalMinutes?: number } | undefined)?.statusUpdateIntervalMinutes
  const validLegacyInterval = typeof legacyInterval === 'number' && legacyInterval > 0 ? legacyInterval : undefined
  if (statusUpdates && (statusUpdates.enabled !== undefined || statusUpdates.intervalMinutes !== undefined)) {
    return {
      enabled: statusUpdates.enabled ?? fallback.enabled,
      intervalMinutes: statusUpdates.intervalMinutes ?? validLegacyInterval ?? fallback.intervalMinutes,
    }
  }
  if (validLegacyInterval !== undefined) {
    return {
      enabled: fallback.enabled,
      intervalMinutes: validLegacyInterval,
    }
  }
  return { ...fallback }
}

export function normalizeSettingsContract(input: DeepPartial<SettingsContract> | null | undefined): SettingsContract {
  const source = input ?? {}

  return {
    sessionTimeoutMinutes: source.sessionTimeoutMinutes ?? DEFAULT_SETTINGS_CONTRACT.sessionTimeoutMinutes,
    sessionSummaryProviderId: source.sessionSummaryProviderId ?? DEFAULT_SETTINGS_CONTRACT.sessionSummaryProviderId,
    language: source.language ?? DEFAULT_SETTINGS_CONTRACT.language,
    timezone: source.timezone ?? DEFAULT_SETTINGS_CONTRACT.timezone,
    thinkingLevel: normalizeThinkingLevel(source.thinkingLevel, DEFAULT_SETTINGS_CONTRACT.thinkingLevel),
    healthMonitorIntervalMinutes: source.healthMonitorIntervalMinutes ?? DEFAULT_SETTINGS_CONTRACT.healthMonitorIntervalMinutes,
    uploads: {
      retentionDays: source.uploads?.retentionDays ?? DEFAULT_SETTINGS_CONTRACT.uploads.retentionDays,
    },
    watchdog: {
      stallWarnMs: source.watchdog?.stallWarnMs ?? DEFAULT_SETTINGS_CONTRACT.watchdog.stallWarnMs,
      stallAbortMs: source.watchdog?.stallAbortMs ?? DEFAULT_SETTINGS_CONTRACT.watchdog.stallAbortMs,
    },
    retry: {
      enabled: source.retry?.enabled ?? DEFAULT_SETTINGS_CONTRACT.retry.enabled,
      maxRetries: source.retry?.maxRetries ?? DEFAULT_SETTINGS_CONTRACT.retry.maxRetries,
      baseDelayMs: source.retry?.baseDelayMs ?? DEFAULT_SETTINGS_CONTRACT.retry.baseDelayMs,
    },
    telegram: {
      enabled: source.telegram?.enabled ?? DEFAULT_SETTINGS_CONTRACT.telegram.enabled,
      botToken: source.telegram?.botToken ?? DEFAULT_SETTINGS_CONTRACT.telegram.botToken,
      batchingDelayMs: source.telegram?.batchingDelayMs ?? DEFAULT_SETTINGS_CONTRACT.telegram.batchingDelayMs,
      sendVoiceReply: source.telegram?.sendVoiceReply ?? DEFAULT_SETTINGS_CONTRACT.telegram.sendVoiceReply,
      sendStallWarnings: source.telegram?.sendStallWarnings ?? DEFAULT_SETTINGS_CONTRACT.telegram.sendStallWarnings,
    },
    healthMonitor: {
      enabled: source.healthMonitor?.enabled ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.enabled,
      fallbackTrigger: source.healthMonitor?.fallbackTrigger ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.fallbackTrigger,
      failuresBeforeFallback:
        source.healthMonitor?.failuresBeforeFallback ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.failuresBeforeFallback,
      recoveryCheckIntervalMinutes:
        source.healthMonitor?.recoveryCheckIntervalMinutes
        ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.recoveryCheckIntervalMinutes,
      successesBeforeRecovery:
        source.healthMonitor?.successesBeforeRecovery ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.successesBeforeRecovery,
      notifications: {
        healthyToDegraded:
          source.healthMonitor?.notifications?.healthyToDegraded
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDegraded,
        degradedToHealthy:
          source.healthMonitor?.notifications?.degradedToHealthy
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.degradedToHealthy,
        degradedToDown:
          source.healthMonitor?.notifications?.degradedToDown
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.degradedToDown,
        healthyToDown:
          source.healthMonitor?.notifications?.healthyToDown
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.healthyToDown,
        downToFallback:
          source.healthMonitor?.notifications?.downToFallback
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.downToFallback,
        fallbackToHealthy:
          source.healthMonitor?.notifications?.fallbackToHealthy
          ?? DEFAULT_SETTINGS_CONTRACT.healthMonitor.notifications.fallbackToHealthy,
      },
    },
    memoryConsolidation: {
      enabled: source.memoryConsolidation?.enabled ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.enabled,
      runAtHour: source.memoryConsolidation?.runAtHour ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.runAtHour,
      lookbackDays: source.memoryConsolidation?.lookbackDays ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.lookbackDays,
      providerId: source.memoryConsolidation?.providerId ?? DEFAULT_SETTINGS_CONTRACT.memoryConsolidation.providerId,
    },
    factExtraction: {
      enabled: source.factExtraction?.enabled ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.enabled,
      providerId: source.factExtraction?.providerId ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.providerId,
      minSessionMessages:
        source.factExtraction?.minSessionMessages ?? DEFAULT_SETTINGS_CONTRACT.factExtraction.minSessionMessages,
    },
    agentHeartbeat: {
      enabled: source.agentHeartbeat?.enabled ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.enabled,
      intervalMinutes: source.agentHeartbeat?.intervalMinutes ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.intervalMinutes,
      nightMode: {
        enabled: source.agentHeartbeat?.nightMode?.enabled ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.enabled,
        startHour:
          source.agentHeartbeat?.nightMode?.startHour ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.startHour,
        endHour: source.agentHeartbeat?.nightMode?.endHour ?? DEFAULT_SETTINGS_CONTRACT.agentHeartbeat.nightMode.endHour,
      },
    },
    multiPersona: {
      enabled: source.multiPersona?.enabled ?? DEFAULT_SETTINGS_CONTRACT.multiPersona.enabled,
      defaultAgentId: source.multiPersona?.defaultAgentId ?? DEFAULT_SETTINGS_CONTRACT.multiPersona.defaultAgentId,
    },
    tasks: {
      defaultProvider: source.tasks?.defaultProvider ?? DEFAULT_SETTINGS_CONTRACT.tasks.defaultProvider,
      maxDurationMinutes: source.tasks?.maxDurationMinutes ?? DEFAULT_SETTINGS_CONTRACT.tasks.maxDurationMinutes,
      telegramDelivery: source.tasks?.telegramDelivery ?? DEFAULT_SETTINGS_CONTRACT.tasks.telegramDelivery,
      loopDetection: {
        enabled: source.tasks?.loopDetection?.enabled ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.enabled,
        method: source.tasks?.loopDetection?.method ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.method,
        maxConsecutiveFailures:
          source.tasks?.loopDetection?.maxConsecutiveFailures
          ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.maxConsecutiveFailures,
        smartProvider:
          source.tasks?.loopDetection?.smartProvider ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.smartProvider,
        smartCheckInterval:
          source.tasks?.loopDetection?.smartCheckInterval
          ?? DEFAULT_SETTINGS_CONTRACT.tasks.loopDetection.smartCheckInterval,
      },
      statusUpdates: normalizeTasksStatusUpdates(source.tasks),
      verification: {
        enabled: source.tasks?.verification?.enabled ?? DEFAULT_SETTINGS_CONTRACT.tasks.verification.enabled,
        providerId: source.tasks?.verification?.providerId ?? DEFAULT_SETTINGS_CONTRACT.tasks.verification.providerId,
      },
      backgroundThinkingLevel: normalizeThinkingLevel(
        source.tasks?.backgroundThinkingLevel,
        DEFAULT_SETTINGS_CONTRACT.tasks.backgroundThinkingLevel,
      ),
    },
    tts: {
      enabled: source.tts?.enabled ?? DEFAULT_SETTINGS_CONTRACT.tts.enabled,
      provider: source.tts?.provider ?? DEFAULT_SETTINGS_CONTRACT.tts.provider,
      providerId: source.tts?.providerId ?? DEFAULT_SETTINGS_CONTRACT.tts.providerId,
      openaiModel: source.tts?.openaiModel ?? DEFAULT_SETTINGS_CONTRACT.tts.openaiModel,
      openaiVoice: source.tts?.openaiVoice ?? DEFAULT_SETTINGS_CONTRACT.tts.openaiVoice,
      openaiInstructions: source.tts?.openaiInstructions ?? DEFAULT_SETTINGS_CONTRACT.tts.openaiInstructions,
      mistralVoice: source.tts?.mistralVoice ?? DEFAULT_SETTINGS_CONTRACT.tts.mistralVoice,
      responseFormat: source.tts?.responseFormat ?? DEFAULT_SETTINGS_CONTRACT.tts.responseFormat,
      deepgramModel: source.tts?.deepgramModel ?? DEFAULT_SETTINGS_CONTRACT.tts.deepgramModel,
      deepgramApiKey: source.tts?.deepgramApiKey ?? DEFAULT_SETTINGS_CONTRACT.tts.deepgramApiKey,
      geminiModel: source.tts?.geminiModel ?? DEFAULT_SETTINGS_CONTRACT.tts.geminiModel,
      geminiVoice: source.tts?.geminiVoice ?? DEFAULT_SETTINGS_CONTRACT.tts.geminiVoice,
      geminiStyle: source.tts?.geminiStyle ?? DEFAULT_SETTINGS_CONTRACT.tts.geminiStyle,
    },
    stt: {
      enabled: source.stt?.enabled ?? DEFAULT_SETTINGS_CONTRACT.stt.enabled,
      provider: source.stt?.provider ?? DEFAULT_SETTINGS_CONTRACT.stt.provider,
      whisperUrl: source.stt?.whisperUrl ?? DEFAULT_SETTINGS_CONTRACT.stt.whisperUrl,
      providerId: source.stt?.providerId ?? DEFAULT_SETTINGS_CONTRACT.stt.providerId,
      openaiModel: source.stt?.openaiModel ?? DEFAULT_SETTINGS_CONTRACT.stt.openaiModel,
      ollamaModel: source.stt?.ollamaModel ?? DEFAULT_SETTINGS_CONTRACT.stt.ollamaModel,
      deepgramModel: source.stt?.deepgramModel ?? DEFAULT_SETTINGS_CONTRACT.stt.deepgramModel,
      deepgramLanguage: source.stt?.deepgramLanguage ?? DEFAULT_SETTINGS_CONTRACT.stt.deepgramLanguage,
      deepgramApiKey: source.stt?.deepgramApiKey ?? DEFAULT_SETTINGS_CONTRACT.stt.deepgramApiKey,
      rewrite: {
        enabled: source.stt?.rewrite?.enabled ?? DEFAULT_SETTINGS_CONTRACT.stt.rewrite.enabled,
        providerId: source.stt?.rewrite?.providerId ?? DEFAULT_SETTINGS_CONTRACT.stt.rewrite.providerId,
      },
    },
    offtangent: {
      nowSetMax: source.offtangent?.nowSetMax ?? DEFAULT_SETTINGS_CONTRACT.offtangent.nowSetMax,
    },
    instanceIdentity: {
      name: source.instanceIdentity?.name ?? DEFAULT_SETTINGS_CONTRACT.instanceIdentity.name,
      notes: source.instanceIdentity?.notes ?? DEFAULT_SETTINGS_CONTRACT.instanceIdentity.notes,
    },
  }
}

export function withLegacySettingsPayloadCompatibility(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (payload.healthMonitorIntervalMinutes !== undefined) {
    return payload
  }

  const healthMonitor = payload.healthMonitor
  if (!healthMonitor || typeof healthMonitor !== 'object') {
    return payload
  }

  const intervalMinutes = (healthMonitor as Record<string, unknown>).intervalMinutes
  if (intervalMinutes === undefined) {
    return payload
  }

  return {
    ...payload,
    healthMonitorIntervalMinutes: intervalMinutes,
  }
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object
    ? DeepPartial<T[K]>
    : T[K]
}
