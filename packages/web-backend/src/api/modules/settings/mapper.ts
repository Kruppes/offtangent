import {
  DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES,
  DEFAULT_NOW_SET_MAX,
  DEFAULT_NOW_SET_MODE,
  DEFAULT_RETRY_SETTINGS,
  DEFAULT_TTS_GEMINI_MODEL,
  DEFAULT_TTS_GEMINI_VOICE,
  DEFAULT_WATCHDOG_SETTINGS,
  getDefaultTimezone,
  maskApiKey,
  normalizeSettingsContract,
  parseNowSetMode,
} from '@axiom/core'
import type { SettingsContract } from '@axiom/core'
import type { HealthMonitorNotificationToggles, SettingsData, TelegramData } from './types.js'

const DEFAULT_NOTIFICATIONS: HealthMonitorNotificationToggles = {
  ...DEFAULT_HEALTH_MONITOR_NOTIFICATION_TOGGLES,
}

export interface SettingsResponseContext {
  settings: SettingsData
  telegram: TelegramData
  batchingDelayMs: number
}

function buildHealthMonitorResponse(settingsRaw: Record<string, unknown>) {
  const healthMonitor = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  return {
    enabled: healthMonitor.enabled ?? true,
    fallbackTrigger: healthMonitor.fallbackTrigger ?? 'down',
    failuresBeforeFallback: healthMonitor.failuresBeforeFallback ?? 1,
    recoveryCheckIntervalMinutes: healthMonitor.recoveryCheckIntervalMinutes ?? 1,
    successesBeforeRecovery: healthMonitor.successesBeforeRecovery ?? 3,
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      ...(healthMonitor.notifications ?? {}) as Record<string, unknown>,
    },
  }
}

function buildConsolidationResponse(settingsRaw: Record<string, unknown>) {
  const memoryConsolidation = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>
  return {
    enabled: memoryConsolidation.enabled ?? true,
    runAtHour: memoryConsolidation.runAtHour ?? 3,
    lookbackDays: memoryConsolidation.lookbackDays ?? 3,
    providerId: memoryConsolidation.providerId ?? '',
  }
}

function buildFactExtractionResponse(settingsRaw: Record<string, unknown>) {
  const factExtraction = (settingsRaw.factExtraction ?? {}) as Record<string, unknown>
  return {
    enabled: factExtraction.enabled ?? true,
    providerId: factExtraction.providerId ?? '',
    minSessionMessages: factExtraction.minSessionMessages ?? 3,
  }
}

function buildAgentHeartbeatResponse(settingsRaw: Record<string, unknown>) {
  const agentHeartbeat = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>
  const nightMode = (agentHeartbeat.nightMode ?? {}) as Record<string, unknown>

  return {
    enabled: agentHeartbeat.enabled ?? false,
    intervalMinutes: agentHeartbeat.intervalMinutes ?? 60,
    nightMode: {
      enabled: nightMode.enabled ?? true,
      startHour: nightMode.startHour ?? 23,
      endHour: nightMode.endHour ?? 8,
    },
  }
}

function buildMultiPersonaResponse(settingsRaw: Record<string, unknown>) {
  const multiPersona = (settingsRaw.multiPersona ?? {}) as Record<string, unknown>

  return {
    enabled: multiPersona.enabled ?? false,
    defaultAgentId: multiPersona.defaultAgentId ?? 'main',
  }
}

function buildTasksResponse(settingsRaw: Record<string, unknown>) {
  const tasks = (settingsRaw.tasks ?? {}) as Record<string, unknown>
  const loopDetection = (tasks.loopDetection ?? {}) as Record<string, unknown>
  const statusUpdates = (tasks.statusUpdates ?? {}) as Record<string, unknown>
  // Legacy flat key on disk is migrated here for the API response shape
  // so the frontend only ever sees the new sub-object form.
  const legacyStatusInterval = tasks.statusUpdateIntervalMinutes
  const resolvedStatusInterval = statusUpdates.intervalMinutes
    ?? (typeof legacyStatusInterval === 'number' ? legacyStatusInterval : 10)

  return {
    defaultProvider: tasks.defaultProvider ?? '',
    maxDurationMinutes: tasks.maxDurationMinutes ?? 60,
    telegramDelivery: tasks.telegramDelivery ?? 'auto',
    loopDetection: {
      enabled: loopDetection.enabled ?? true,
      method: loopDetection.method ?? 'systematic',
      maxConsecutiveFailures: loopDetection.maxConsecutiveFailures ?? 3,
      smartProvider: loopDetection.smartProvider ?? '',
      smartCheckInterval: loopDetection.smartCheckInterval ?? 5,
    },
    statusUpdates: {
      enabled: statusUpdates.enabled ?? false,
      intervalMinutes: resolvedStatusInterval,
    },
    verification: {
      enabled: (tasks.verification as Record<string, unknown> | undefined)?.enabled ?? true,
      providerId: (tasks.verification as Record<string, unknown> | undefined)?.providerId ?? '',
    },
    backgroundThinkingLevel: tasks.backgroundThinkingLevel ?? 'off',
  }
}

function buildTtsResponse(settingsRaw: Record<string, unknown>) {
  const tts = (settingsRaw.tts ?? {}) as Record<string, unknown>

  // Mask the TTS Deepgram key the same way as the STT one so the form can
  // show "key configured" without leaking the secret. `mergeTts` treats
  // values containing the mask character (`•`) as "no change".
  const rawDeepgramKey = typeof tts.deepgramApiKey === 'string' ? tts.deepgramApiKey : ''
  const maskedDeepgramKey = rawDeepgramKey ? maskApiKey(rawDeepgramKey) : ''

  return {
    enabled: tts.enabled ?? false,
    provider: tts.provider ?? 'openai',
    providerId: tts.providerId ?? '',
    openaiModel: tts.openaiModel ?? 'gpt-4o-mini-tts',
    openaiVoice: tts.openaiVoice ?? 'nova',
    openaiInstructions: tts.openaiInstructions ?? '',
    mistralVoice: tts.mistralVoice ?? '',
    responseFormat: tts.responseFormat ?? 'mp3',
    deepgramModel: tts.deepgramModel ?? 'aura-2-thalia-en',
    deepgramApiKey: maskedDeepgramKey,
    geminiModel: (tts.geminiModel as string | undefined) || DEFAULT_TTS_GEMINI_MODEL,
    geminiVoice: (tts.geminiVoice as string | undefined) || DEFAULT_TTS_GEMINI_VOICE,
    geminiStyle: tts.geminiStyle ?? '',
  }
}

function buildUploadsResponse(settingsRaw: Record<string, unknown>) {
  const uploads = (settingsRaw.uploads ?? {}) as Record<string, unknown>
  const retentionDays = typeof uploads.retentionDays === 'number' ? uploads.retentionDays : 30
  return { retentionDays }
}

function buildOfftangentResponse(settingsRaw: Record<string, unknown>) {
  const offtangent = (settingsRaw.offtangent ?? {}) as Record<string, unknown>
  return {
    nowSetMax: typeof offtangent.nowSetMax === 'number' ? offtangent.nowSetMax : DEFAULT_NOW_SET_MAX,
    nowSetMode: parseNowSetMode(offtangent.nowSetMode) ?? DEFAULT_NOW_SET_MODE,
  }
}

function buildCaptureModesResponse(settingsRaw: Record<string, unknown>) {
  return normalizeSettingsContract(settingsRaw as Partial<SettingsContract>).captureModes
}

function buildCaptureSourcesResponse(settingsRaw: Record<string, unknown>) {
  return normalizeSettingsContract(settingsRaw as Partial<SettingsContract>).captureSources
}

function buildInstanceIdentityResponse(settingsRaw: Record<string, unknown>) {
  const identity = (settingsRaw.instanceIdentity ?? {}) as Record<string, unknown>
  return {
    name: typeof identity.name === 'string' ? identity.name : '',
    notes: typeof identity.notes === 'string' ? identity.notes : '',
  }
}

function buildTelegramResponse(telegram: TelegramData, batchingDelayMs: number) {
  return {
    enabled: telegram.enabled ?? false,
    botToken: telegram.botToken ?? '',
    batchingDelayMs,
    sendVoiceReply: telegram.sendVoiceReply ?? false,
    sendStallWarnings: telegram.sendStallWarnings ?? false,
  }
}

function buildWatchdogResponse(settingsRaw: Record<string, unknown>) {
  const watchdog = (settingsRaw.watchdog ?? {}) as Record<string, unknown>
  return {
    stallWarnMs: watchdog.stallWarnMs ?? DEFAULT_WATCHDOG_SETTINGS.stallWarnMs,
    stallAbortMs: watchdog.stallAbortMs ?? DEFAULT_WATCHDOG_SETTINGS.stallAbortMs,
  }
}

function buildRetryResponse(settingsRaw: Record<string, unknown>) {
  const retry = (settingsRaw.retry ?? {}) as Record<string, unknown>
  return {
    enabled: retry.enabled ?? DEFAULT_RETRY_SETTINGS.enabled,
    maxRetries: retry.maxRetries ?? DEFAULT_RETRY_SETTINGS.maxRetries,
    baseDelayMs: retry.baseDelayMs ?? DEFAULT_RETRY_SETTINGS.baseDelayMs,
  }
}

function buildSttResponse(settingsRaw: Record<string, unknown>) {
  const stt = (settingsRaw.stt ?? {}) as Record<string, unknown>
  const rewrite = (stt.rewrite ?? {}) as Record<string, unknown>

  // Mask the STT Deepgram key. Stored separately from the TTS one so account
  // usage can be split. `mergeStt` treats values containing the mask
  // character (`•`) as "no change".
  const rawDeepgramKey = typeof stt.deepgramApiKey === 'string' ? stt.deepgramApiKey : ''
  const maskedDeepgramKey = rawDeepgramKey ? maskApiKey(rawDeepgramKey) : ''

  return {
    enabled: stt.enabled ?? false,
    provider: stt.provider ?? 'whisper-url',
    whisperUrl: stt.whisperUrl ?? '',
    providerId: stt.providerId ?? '',
    openaiModel: stt.openaiModel ?? 'whisper-1',
    ollamaModel: stt.ollamaModel ?? '',
    deepgramModel: stt.deepgramModel ?? 'nova-3',
    deepgramLanguage: stt.deepgramLanguage ?? '',
    deepgramApiKey: maskedDeepgramKey,
    rewrite: {
      enabled: rewrite.enabled ?? false,
      providerId: rewrite.providerId ?? '',
    },
  }
}

export function mapSettingsResponse(context: SettingsResponseContext) {
  const settingsRaw = context.settings as unknown as Record<string, unknown>

  return {
    sessionTimeoutMinutes: context.settings.sessionTimeoutMinutes ?? 30,
    sessionSummaryProviderId: (settingsRaw.sessionSummaryProviderId as string) ?? '',
    language: context.settings.language ?? 'match',
    timezone: context.settings.timezone ?? getDefaultTimezone(),
    thinkingLevel: (settingsRaw.thinkingLevel as string) ?? 'off',
    healthMonitorIntervalMinutes:
      context.settings.healthMonitorIntervalMinutes
      ?? (context.settings.healthMonitor as Record<string, unknown> | undefined)?.intervalMinutes
      ?? 5,
    uploads: buildUploadsResponse(settingsRaw),
    watchdog: buildWatchdogResponse(settingsRaw),
    retry: buildRetryResponse(settingsRaw),
    telegram: buildTelegramResponse(context.telegram, context.batchingDelayMs),
    healthMonitor: buildHealthMonitorResponse(settingsRaw),
    memoryConsolidation: buildConsolidationResponse(settingsRaw),
    factExtraction: buildFactExtractionResponse(settingsRaw),
    agentHeartbeat: buildAgentHeartbeatResponse(settingsRaw),
    multiPersona: buildMultiPersonaResponse(settingsRaw),
    tasks: buildTasksResponse(settingsRaw),
    tts: buildTtsResponse(settingsRaw),
    stt: buildSttResponse(settingsRaw),
    offtangent: buildOfftangentResponse(settingsRaw),
    captureModes: buildCaptureModesResponse(settingsRaw),
    captureSources: buildCaptureSourcesResponse(settingsRaw),
    instanceIdentity: buildInstanceIdentityResponse(settingsRaw),
  }
}

export function mapSettingsUpdateResponse(context: SettingsResponseContext) {
  return {
    message: 'Settings updated',
    ...mapSettingsResponse(context),
    healthMonitorIntervalMinutes: context.settings.healthMonitorIntervalMinutes,
  }
}
