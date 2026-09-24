import {
  CAPTURE_STRAND_TITLE_MAX_LENGTH,
  CAPTURE_STYLE_HINT_MAX_LENGTH,
  DEFAULT_WATCHDOG_SETTINGS,
  INSTANCE_IDENTITY_NAME_MAX_LENGTH,
  INSTANCE_IDENTITY_NOTES_MAX_LENGTH,
  NOW_SET_MAX_RANGE,
  NOW_SET_MODES,
  encrypt,
  HEALTH_MONITOR_FALLBACK_TRIGGERS,
  isOfficialOpenAiBaseUrl,
  loadProviders,
  SETTINGS_STT_OPENAI_MODELS,
  SETTINGS_STT_PROVIDERS,
  SETTINGS_THINKING_LEVELS,
  SETTINGS_TTS_GEMINI_VOICES,
  SETTINGS_TTS_OPENAI_MODELS,
  SETTINGS_TTS_PROVIDERS,
  SETTINGS_TTS_RESPONSE_FORMATS,
  TASK_LOOP_DETECTION_METHODS,
  TASK_TELEGRAM_DELIVERY_VALUES,
  withLegacySettingsPayloadCompatibility,
} from '@axiom/core'

export interface MergeGroupResult {
  error: string | null
  changed: boolean
}

export function normalizeSettingsPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return withLegacySettingsPayloadCompatibility(payload)
}

export function validatePositiveNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return `${name} must be a positive number`
  }
  return null
}

export function validateIntegerRange(value: unknown, name: string, min: number, max: number): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return `${name} must be an integer ${min}-${max}`
  }
  return null
}

export function validateNonNegativeNumber(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${name} must be a non-negative number`
  }
  return null
}

export function validateHour(value: unknown, name: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    return `${name} must be an integer 0-23`
  }
  return null
}

export function validateNonEmptyString(value: unknown, name: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `${name} must be a non-empty string`
  }
  return null
}

export function validateEnum(value: unknown, allowed: readonly string[], name: string): string | null {
  if (!allowed.includes(value as string)) {
    return `${name} must be ${allowed.map(a => `"${a}"`).join(' or ')}`
  }
  return null
}

export function mergeHealthMonitor(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const incoming = body.healthMonitor as Record<string, unknown> | undefined
  if (!incoming) return { error: null, changed: false }

  const existing = (settingsRaw.healthMonitor ?? {}) as Record<string, unknown>
  let changed = false

  if (incoming.enabled !== undefined) {
    existing.enabled = !!incoming.enabled
    changed = true
  }

  if (incoming.fallbackTrigger !== undefined) {
    const err = validateEnum(incoming.fallbackTrigger, HEALTH_MONITOR_FALLBACK_TRIGGERS, 'healthMonitor.fallbackTrigger')
    if (err) return { error: err, changed }
    existing.fallbackTrigger = incoming.fallbackTrigger
    changed = true
  }

  for (const key of ['failuresBeforeFallback', 'recoveryCheckIntervalMinutes', 'successesBeforeRecovery'] as const) {
    if (incoming[key] !== undefined) {
      const err = validatePositiveNumber(incoming[key], `healthMonitor.${key}`)
      if (err) return { error: err, changed }
      existing[key] = incoming[key]
      changed = true
    }
  }

  if (incoming.notifications !== undefined) {
    const existingNotifications = (existing.notifications ?? {}) as Record<string, unknown>
    const incomingNotifications = incoming.notifications as Record<string, unknown>

    for (const key of ['healthyToDegraded', 'degradedToHealthy', 'degradedToDown', 'healthyToDown', 'downToFallback', 'fallbackToHealthy']) {
      if (incomingNotifications[key] !== undefined) {
        existingNotifications[key] = !!incomingNotifications[key]
      }
    }

    existing.notifications = existingNotifications
    changed = true
  }

  settingsRaw.healthMonitor = existing
  return { error: null, changed }
}

export function mergeConsolidation(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const memoryConsolidation = body.memoryConsolidation as Record<string, unknown> | undefined
  if (!memoryConsolidation) return { error: null, changed: false }

  const existing = (settingsRaw.memoryConsolidation ?? {}) as Record<string, unknown>

  if (memoryConsolidation.enabled !== undefined) existing.enabled = !!memoryConsolidation.enabled

  if (memoryConsolidation.runAtHour !== undefined) {
    const err = validateHour(memoryConsolidation.runAtHour, 'memoryConsolidation.runAtHour')
    if (err) return { error: err, changed: false }
    existing.runAtHour = memoryConsolidation.runAtHour
  }

  if (memoryConsolidation.lookbackDays !== undefined) {
    if (
      typeof memoryConsolidation.lookbackDays !== 'number'
      || !Number.isInteger(memoryConsolidation.lookbackDays)
      || memoryConsolidation.lookbackDays < 1
      || memoryConsolidation.lookbackDays > 30
    ) {
      return { error: 'memoryConsolidation.lookbackDays must be an integer 1-30', changed: false }
    }
    existing.lookbackDays = memoryConsolidation.lookbackDays
  }

  if (memoryConsolidation.providerId !== undefined) {
    if (typeof memoryConsolidation.providerId !== 'string') {
      return { error: 'memoryConsolidation.providerId must be a string', changed: false }
    }
    existing.providerId = memoryConsolidation.providerId
  }

  settingsRaw.memoryConsolidation = existing
  return { error: null, changed: true }
}

export function mergeFactExtraction(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const factExtraction = body.factExtraction as Record<string, unknown> | undefined
  if (!factExtraction) return { error: null, changed: false }

  const existing = (settingsRaw.factExtraction ?? {}) as Record<string, unknown>

  if (factExtraction.enabled !== undefined) existing.enabled = !!factExtraction.enabled

  if (factExtraction.providerId !== undefined) {
    if (typeof factExtraction.providerId !== 'string') {
      return { error: 'factExtraction.providerId must be a string', changed: false }
    }
    existing.providerId = factExtraction.providerId
  }

  if (factExtraction.minSessionMessages !== undefined) {
    if (
      typeof factExtraction.minSessionMessages !== 'number'
      || !Number.isInteger(factExtraction.minSessionMessages)
      || factExtraction.minSessionMessages < 1
      || factExtraction.minSessionMessages > 100
    ) {
      return { error: 'factExtraction.minSessionMessages must be an integer 1-100', changed: false }
    }
    existing.minSessionMessages = factExtraction.minSessionMessages
  }

  settingsRaw.factExtraction = existing
  return { error: null, changed: true }
}

export function mergeAgentHeartbeat(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const agentHeartbeat = body.agentHeartbeat as Record<string, unknown> | undefined
  if (!agentHeartbeat) return { error: null, changed: false }

  const existing = (settingsRaw.agentHeartbeat ?? {}) as Record<string, unknown>

  if (agentHeartbeat.enabled !== undefined) existing.enabled = !!agentHeartbeat.enabled

  if (agentHeartbeat.intervalMinutes !== undefined) {
    const err = validatePositiveNumber(agentHeartbeat.intervalMinutes, 'agentHeartbeat.intervalMinutes')
    if (err) return { error: err, changed: false }
    existing.intervalMinutes = agentHeartbeat.intervalMinutes
  }

  if (agentHeartbeat.nightMode !== undefined) {
    const nightMode = agentHeartbeat.nightMode as Record<string, unknown>
    const existingNightMode = (existing.nightMode ?? {}) as Record<string, unknown>

    if (nightMode.enabled !== undefined) existingNightMode.enabled = !!nightMode.enabled

    if (nightMode.startHour !== undefined) {
      const err = validateHour(nightMode.startHour, 'agentHeartbeat.nightMode.startHour')
      if (err) return { error: err, changed: false }
      existingNightMode.startHour = nightMode.startHour
    }

    if (nightMode.endHour !== undefined) {
      const err = validateHour(nightMode.endHour, 'agentHeartbeat.nightMode.endHour')
      if (err) return { error: err, changed: false }
      existingNightMode.endHour = nightMode.endHour
    }

    existing.nightMode = existingNightMode
  }

  settingsRaw.agentHeartbeat = existing
  return { error: null, changed: true }
}

export function mergeMultiPersona(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const multiPersona = body.multiPersona as Record<string, unknown> | undefined
  if (!multiPersona) return { error: null, changed: false }

  const existing = (settingsRaw.multiPersona ?? {}) as Record<string, unknown>

  if (multiPersona.enabled !== undefined) existing.enabled = !!multiPersona.enabled

  if (multiPersona.defaultAgentId !== undefined) {
    const err = validateNonEmptyString(multiPersona.defaultAgentId, 'multiPersona.defaultAgentId')
    if (err) return { error: err, changed: false }
    existing.defaultAgentId = (multiPersona.defaultAgentId as string).trim()
  }

  settingsRaw.multiPersona = existing
  return { error: null, changed: true }
}

export function mergeTasks(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const tasks = body.tasks as Record<string, unknown> | undefined
  if (!tasks) return { error: null }

  const existing = (settingsRaw.tasks ?? {}) as Record<string, unknown>

  if (tasks.defaultProvider !== undefined) {
    if (typeof tasks.defaultProvider !== 'string') {
      return { error: 'tasks.defaultProvider must be a string' }
    }
    existing.defaultProvider = tasks.defaultProvider
  }

  if (tasks.maxDurationMinutes !== undefined) {
    const err = validatePositiveNumber(tasks.maxDurationMinutes, 'tasks.maxDurationMinutes')
    if (err) return { error: err }
    existing.maxDurationMinutes = tasks.maxDurationMinutes
  }

  if (tasks.telegramDelivery !== undefined) {
    const err = validateEnum(tasks.telegramDelivery, TASK_TELEGRAM_DELIVERY_VALUES, 'tasks.telegramDelivery')
    if (err) return { error: err }
    existing.telegramDelivery = tasks.telegramDelivery
  }

  if (tasks.loopDetection !== undefined) {
    const loopDetection = tasks.loopDetection as Record<string, unknown>
    const existingLoopDetection = (existing.loopDetection ?? {}) as Record<string, unknown>

    if (loopDetection.enabled !== undefined) existingLoopDetection.enabled = !!loopDetection.enabled

    if (loopDetection.method !== undefined) {
      const err = validateEnum(loopDetection.method, TASK_LOOP_DETECTION_METHODS, 'tasks.loopDetection.method')
      if (err) return { error: err }
      existingLoopDetection.method = loopDetection.method
    }

    if (loopDetection.maxConsecutiveFailures !== undefined) {
      const err = validatePositiveNumber(loopDetection.maxConsecutiveFailures, 'tasks.loopDetection.maxConsecutiveFailures')
      if (err) return { error: err }
      existingLoopDetection.maxConsecutiveFailures = loopDetection.maxConsecutiveFailures
    }

    if (loopDetection.smartProvider !== undefined) {
      if (typeof loopDetection.smartProvider !== 'string') {
        return { error: 'tasks.loopDetection.smartProvider must be a string' }
      }
      existingLoopDetection.smartProvider = loopDetection.smartProvider
    }

    if (loopDetection.smartCheckInterval !== undefined) {
      const err = validatePositiveNumber(loopDetection.smartCheckInterval, 'tasks.loopDetection.smartCheckInterval')
      if (err) return { error: err }
      existingLoopDetection.smartCheckInterval = loopDetection.smartCheckInterval
    }

    existing.loopDetection = existingLoopDetection
  }

  if (tasks.statusUpdates !== undefined) {
    const statusUpdates = tasks.statusUpdates as Record<string, unknown>
    const existingStatusUpdates = (existing.statusUpdates ?? {}) as Record<string, unknown>

    if (statusUpdates.enabled !== undefined) {
      existingStatusUpdates.enabled = !!statusUpdates.enabled
    }

    if (statusUpdates.intervalMinutes !== undefined) {
      const err = validateIntegerRange(statusUpdates.intervalMinutes, 'tasks.statusUpdates.intervalMinutes', 1, 120)
      if (err) return { error: err }
      existingStatusUpdates.intervalMinutes = statusUpdates.intervalMinutes
    }

    existing.statusUpdates = existingStatusUpdates
  }

  if (tasks.verification !== undefined) {
    const verification = tasks.verification as Record<string, unknown>
    const existingVerification = (existing.verification ?? {}) as Record<string, unknown>

    if (verification.enabled !== undefined) {
      existingVerification.enabled = !!verification.enabled
    }

    if (verification.providerId !== undefined) {
      if (typeof verification.providerId !== 'string') {
        return { error: 'tasks.verification.providerId must be a string' }
      }
      existingVerification.providerId = verification.providerId.trim()
    }

    existing.verification = existingVerification
  }

  // Legacy flat key — preserved so existing PATCH callers that still send
  // `tasks.statusUpdateIntervalMinutes` keep working. We migrate it into the
  // new sub-object without clobbering an explicit `enabled` flag.
  if (tasks.statusUpdateIntervalMinutes !== undefined) {
    const err = validateIntegerRange(tasks.statusUpdateIntervalMinutes, 'tasks.statusUpdateIntervalMinutes', 1, 120)
    if (err) return { error: err }
    const existingStatusUpdates = (existing.statusUpdates ?? {}) as Record<string, unknown>
    existingStatusUpdates.intervalMinutes = tasks.statusUpdateIntervalMinutes
    existing.statusUpdates = existingStatusUpdates
  }

  if (tasks.backgroundThinkingLevel !== undefined) {
    const err = validateEnum(tasks.backgroundThinkingLevel, SETTINGS_THINKING_LEVELS, 'tasks.backgroundThinkingLevel')
    if (err) return { error: err }
    existing.backgroundThinkingLevel = tasks.backgroundThinkingLevel
  }

  settingsRaw.tasks = existing
  return { error: null }
}

/** Shape of a model id on a self-hosted endpoint. Deliberately narrow. */
const TTS_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/

/**
 * True when `providerId` names a configured provider that is NOT the hosted
 * OpenAI API. Those endpoints (a LAN box running an OpenAI-compatible speech
 * server) carry their own model names, so the model field cannot be an enum
 * of the three hosted ids. Unknown ids and read failures stay strict.
 */
function isSelfHostedOpenAiProvider(providerId: unknown): boolean {
  if (typeof providerId !== 'string' || !providerId) return false
  try {
    const provider = loadProviders().providers.find(p => p.id === providerId)
    if (!provider) return false
    return !isOfficialOpenAiBaseUrl(provider.baseUrl)
  } catch {
    return false
  }
}

export function mergeTts(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const tts = body.tts as Record<string, unknown> | undefined
  if (!tts) return { error: null }

  const existing = (settingsRaw.tts ?? {}) as Record<string, unknown>

  if (tts.enabled !== undefined) existing.enabled = !!tts.enabled

  if (tts.provider !== undefined) {
    const err = validateEnum(tts.provider, SETTINGS_TTS_PROVIDERS, 'tts.provider')
    if (err) return { error: err }
    existing.provider = tts.provider
  }

  if (tts.providerId !== undefined) {
    if (typeof tts.providerId !== 'string') {
      return { error: 'tts.providerId must be a string' }
    }
    existing.providerId = tts.providerId
  }

  if (tts.openaiModel !== undefined) {
    const providerId = (tts.providerId ?? existing.providerId) as string | undefined
    if (isSelfHostedOpenAiProvider(providerId)) {
      // A self-hosted OpenAI-compatible endpoint names its own models, so the
      // three hosted model ids are not the whole world. Still validated in
      // shape, so a typo stays a 400 and no URL or prose sneaks into the field.
      if (typeof tts.openaiModel !== 'string' || !TTS_MODEL_ID_PATTERN.test(tts.openaiModel)) {
        return { error: 'tts.openaiModel must be a model id (letters, digits, . _ : / -, max 80 chars)' }
      }
      existing.openaiModel = tts.openaiModel
    } else {
      const err = validateEnum(tts.openaiModel, SETTINGS_TTS_OPENAI_MODELS, 'tts.openaiModel')
      if (err) return { error: err }
      existing.openaiModel = tts.openaiModel
    }
  }

  if (tts.openaiVoice !== undefined) {
    if (typeof tts.openaiVoice !== 'string' || !tts.openaiVoice) {
      return { error: 'tts.openaiVoice must be a non-empty string' }
    }
    existing.openaiVoice = tts.openaiVoice
  }

  if (tts.openaiInstructions !== undefined) {
    if (typeof tts.openaiInstructions !== 'string') {
      return { error: 'tts.openaiInstructions must be a string' }
    }
    existing.openaiInstructions = tts.openaiInstructions
  }

  if (tts.mistralVoice !== undefined) {
    if (typeof tts.mistralVoice !== 'string') {
      return { error: 'tts.mistralVoice must be a string' }
    }
    existing.mistralVoice = tts.mistralVoice
  }

  if (tts.responseFormat !== undefined) {
    const err = validateEnum(tts.responseFormat, SETTINGS_TTS_RESPONSE_FORMATS, 'tts.responseFormat')
    if (err) return { error: err }
    existing.responseFormat = tts.responseFormat
  }

  if (tts.deepgramModel !== undefined) {
    if (typeof tts.deepgramModel !== 'string' || !tts.deepgramModel.trim()) {
      return { error: 'tts.deepgramModel must be a non-empty string' }
    }
    existing.deepgramModel = tts.deepgramModel.trim()
  }

  if (tts.deepgramApiKey !== undefined) {
    if (typeof tts.deepgramApiKey !== 'string') {
      return { error: 'tts.deepgramApiKey must be a string' }
    }
    const raw = tts.deepgramApiKey
    if (!raw.includes('•')) {
      existing.deepgramApiKey = raw ? encrypt(raw) : ''
    }
  }

  // Gemini: the model is free text on purpose (preview ids rotate faster
  // than releases), the voice must be one of the prebuilt names Google
  // documents, the style hint is any string.
  if (tts.geminiModel !== undefined) {
    if (typeof tts.geminiModel !== 'string' || !tts.geminiModel.trim()) {
      return { error: 'tts.geminiModel must be a non-empty string' }
    }
    existing.geminiModel = tts.geminiModel.trim()
  }

  if (tts.geminiVoice !== undefined) {
    if (typeof tts.geminiVoice !== 'string' || !SETTINGS_TTS_GEMINI_VOICES.some(v => v.name === tts.geminiVoice)) {
      return { error: 'tts.geminiVoice must be one of the prebuilt Gemini voices' }
    }
    existing.geminiVoice = tts.geminiVoice
  }

  if (tts.geminiStyle !== undefined) {
    if (typeof tts.geminiStyle !== 'string') {
      return { error: 'tts.geminiStyle must be a string' }
    }
    existing.geminiStyle = tts.geminiStyle.slice(0, 500)
  }

  settingsRaw.tts = existing
  return { error: null }
}

export function mergeUploads(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const uploads = body.uploads as Record<string, unknown> | undefined
  if (!uploads) return { error: null, changed: false }

  const existing = (settingsRaw.uploads ?? {}) as Record<string, unknown>

  if (uploads.retentionDays !== undefined) {
    const err = validateNonNegativeNumber(uploads.retentionDays, 'uploads.retentionDays')
    if (err) return { error: err, changed: false }
    existing.retentionDays = uploads.retentionDays
  }

  settingsRaw.uploads = existing
  return { error: null, changed: true }
}

export function mergeWatchdog(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const watchdog = body.watchdog as Record<string, unknown> | undefined
  if (!watchdog) return { error: null, changed: false }

  const existing = (settingsRaw.watchdog ?? {}) as Record<string, unknown>

  if (watchdog.stallWarnMs !== undefined) {
    const err = validateIntegerRange(watchdog.stallWarnMs, 'watchdog.stallWarnMs', 1000, 600000)
    if (err) return { error: err, changed: false }
    existing.stallWarnMs = watchdog.stallWarnMs
  }

  if (watchdog.stallAbortMs !== undefined) {
    const err = validateIntegerRange(watchdog.stallAbortMs, 'watchdog.stallAbortMs', 1000, 3600000)
    if (err) return { error: err, changed: false }
    existing.stallAbortMs = watchdog.stallAbortMs
  }

  const warnMs = (existing.stallWarnMs ?? DEFAULT_WATCHDOG_SETTINGS.stallWarnMs) as number
  const abortMs = (existing.stallAbortMs ?? DEFAULT_WATCHDOG_SETTINGS.stallAbortMs) as number
  if (abortMs < warnMs) {
    return { error: 'watchdog.stallAbortMs must be greater than or equal to watchdog.stallWarnMs', changed: false }
  }

  settingsRaw.watchdog = existing
  return { error: null, changed: true }
}

export function mergeOfftangent(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const offtangent = body.offtangent as Record<string, unknown> | undefined
  if (!offtangent) return { error: null, changed: false }

  const existing = (settingsRaw.offtangent ?? {}) as Record<string, unknown>

  if (offtangent.nowSetMax !== undefined) {
    const err = validateIntegerRange(
      offtangent.nowSetMax,
      'offtangent.nowSetMax',
      NOW_SET_MAX_RANGE.min,
      NOW_SET_MAX_RANGE.max,
    )
    if (err) return { error: err, changed: false }
    existing.nowSetMax = offtangent.nowSetMax
  }

  if (offtangent.nowSetMode !== undefined) {
    const err = validateEnum(offtangent.nowSetMode, NOW_SET_MODES, 'offtangent.nowSetMode')
    if (err) return { error: err, changed: false }
    existing.nowSetMode = offtangent.nowSetMode
  }

  settingsRaw.offtangent = existing
  return { error: null, changed: true }
}

/**
 * `captureModes.quick` and `captureModes.assist`.
 *
 * `captureModes.quick`: the model pair is validated as a PAIR (both or
 * neither), the thinking level against the same enum the chat agent uses, and
 * the two free-text fields only for type and length. The pair is deliberately
 * NOT checked against the live provider catalog here: a settings save must not
 * fail because a provider is temporarily untested, and the capture service
 * falls back to the persona model for an unusable pair (see `planQuickMode`).
 */
export function mergeCaptureModes(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const captureModes = body.captureModes as Record<string, unknown> | undefined
  if (!captureModes) return { error: null, changed: false }
  const quick = captureModes.quick as Record<string, unknown> | undefined
  const assist = captureModes.assist as Record<string, unknown> | undefined
  if (!quick && !assist) return { error: null, changed: false }

  const existingModes = (settingsRaw.captureModes ?? {}) as Record<string, unknown>
  const existing = (existingModes.quick ?? {}) as Record<string, unknown>

  if (quick) {
  if (quick.providerId !== undefined) {
    if (typeof quick.providerId !== 'string') return { error: 'captureModes.quick.providerId must be a string', changed: false }
    existing.providerId = quick.providerId.trim()
  }
  if (quick.modelId !== undefined) {
    if (typeof quick.modelId !== 'string') return { error: 'captureModes.quick.modelId must be a string', changed: false }
    existing.modelId = quick.modelId.trim()
  }
  const providerId = (existing.providerId ?? '') as string
  const modelId = (existing.modelId ?? '') as string
  if ((providerId === '') !== (modelId === '')) {
    return { error: 'captureModes.quick.providerId and captureModes.quick.modelId must both be set, or both empty', changed: false }
  }
  if (quick.thinkingLevel !== undefined) {
    const err = validateEnum(quick.thinkingLevel, SETTINGS_THINKING_LEVELS, 'captureModes.quick.thinkingLevel')
    if (err) return { error: err, changed: false }
    existing.thinkingLevel = quick.thinkingLevel
  }
  if (quick.styleHint !== undefined) {
    if (typeof quick.styleHint !== 'string') return { error: 'captureModes.quick.styleHint must be a string', changed: false }
    if (quick.styleHint.length > CAPTURE_STYLE_HINT_MAX_LENGTH) {
      return { error: `captureModes.quick.styleHint must be at most ${CAPTURE_STYLE_HINT_MAX_LENGTH} characters`, changed: false }
    }
    existing.styleHint = quick.styleHint.trim()
  }
  if (quick.strandTitle !== undefined) {
    if (typeof quick.strandTitle !== 'string') return { error: 'captureModes.quick.strandTitle must be a string', changed: false }
    if (quick.strandTitle.length > CAPTURE_STRAND_TITLE_MAX_LENGTH) {
      return { error: `captureModes.quick.strandTitle must be at most ${CAPTURE_STRAND_TITLE_MAX_LENGTH} characters`, changed: false }
    }
    existing.strandTitle = quick.strandTitle.trim()
  }

  existingModes.quick = existing
  }

  // `captureModes.assist` owns nothing but its style hint: no model, no
  // thinking level, no strand. The mode deliberately runs on the persona's
  // own model and through the normal router, so there is nothing else here
  // that could be misconfigured.
  if (assist) {
    const existingAssist = (existingModes.assist ?? {}) as Record<string, unknown>
    if (assist.styleHint !== undefined) {
      if (typeof assist.styleHint !== 'string') return { error: 'captureModes.assist.styleHint must be a string', changed: false }
      if (assist.styleHint.length > CAPTURE_STYLE_HINT_MAX_LENGTH) {
        return { error: `captureModes.assist.styleHint must be at most ${CAPTURE_STYLE_HINT_MAX_LENGTH} characters`, changed: false }
      }
      existingAssist.styleHint = assist.styleHint.trim()
    }
    existingModes.assist = existingAssist
  }

  settingsRaw.captureModes = existingModes
  return { error: null, changed: true }
}

/** `captureSources.puck.styleHint`: free text, same length bound as the mode hint. */
export function mergeCaptureSources(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const captureSources = body.captureSources as Record<string, unknown> | undefined
  if (!captureSources) return { error: null, changed: false }
  const puck = captureSources.puck as Record<string, unknown> | undefined
  if (!puck) return { error: null, changed: false }

  const existingSources = (settingsRaw.captureSources ?? {}) as Record<string, unknown>
  const existing = (existingSources.puck ?? {}) as Record<string, unknown>

  if (puck.styleHint !== undefined) {
    if (typeof puck.styleHint !== 'string') return { error: 'captureSources.puck.styleHint must be a string', changed: false }
    if (puck.styleHint.length > CAPTURE_STYLE_HINT_MAX_LENGTH) {
      return { error: `captureSources.puck.styleHint must be at most ${CAPTURE_STYLE_HINT_MAX_LENGTH} characters`, changed: false }
    }
    existing.styleHint = puck.styleHint.trim()
  }

  existingSources.puck = existing
  settingsRaw.captureSources = existingSources
  return { error: null, changed: true }
}

/**
 * `instanceIdentity`: both fields are free-text strings, trimmed on write.
 * An empty `name` is valid and switches the `<runtime_instance>` prompt
 * block off again.
 */
export function mergeInstanceIdentity(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const identity = body.instanceIdentity as Record<string, unknown> | undefined
  if (!identity) return { error: null, changed: false }

  const existing = (settingsRaw.instanceIdentity ?? {}) as Record<string, unknown>

  if (identity.name !== undefined) {
    if (typeof identity.name !== 'string') {
      return { error: 'instanceIdentity.name must be a string', changed: false }
    }
    if (identity.name.length > INSTANCE_IDENTITY_NAME_MAX_LENGTH) {
      return { error: `instanceIdentity.name must be at most ${INSTANCE_IDENTITY_NAME_MAX_LENGTH} characters`, changed: false }
    }
    existing.name = identity.name.trim()
  }

  if (identity.notes !== undefined) {
    if (typeof identity.notes !== 'string') {
      return { error: 'instanceIdentity.notes must be a string', changed: false }
    }
    if (identity.notes.length > INSTANCE_IDENTITY_NOTES_MAX_LENGTH) {
      return { error: `instanceIdentity.notes must be at most ${INSTANCE_IDENTITY_NOTES_MAX_LENGTH} characters`, changed: false }
    }
    existing.notes = identity.notes.trim()
  }

  settingsRaw.instanceIdentity = existing
  return { error: null, changed: true }
}

export function mergeRetry(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): MergeGroupResult {
  const retry = body.retry as Record<string, unknown> | undefined
  if (!retry) return { error: null, changed: false }

  const existing = (settingsRaw.retry ?? {}) as Record<string, unknown>

  if (retry.enabled !== undefined) existing.enabled = !!retry.enabled

  if (retry.maxRetries !== undefined) {
    const err = validateIntegerRange(retry.maxRetries, 'retry.maxRetries', 0, 10)
    if (err) return { error: err, changed: false }
    existing.maxRetries = retry.maxRetries
  }

  if (retry.baseDelayMs !== undefined) {
    const err = validateIntegerRange(retry.baseDelayMs, 'retry.baseDelayMs', 100, 60000)
    if (err) return { error: err, changed: false }
    existing.baseDelayMs = retry.baseDelayMs
  }

  settingsRaw.retry = existing
  return { error: null, changed: true }
}

export function mergeStt(
  body: Record<string, unknown>,
  settingsRaw: Record<string, unknown>,
): { error: string | null } {
  const stt = body.stt as Record<string, unknown> | undefined
  if (!stt) return { error: null }

  const existing = (settingsRaw.stt ?? {}) as Record<string, unknown>

  if (stt.enabled !== undefined) existing.enabled = !!stt.enabled

  if (stt.provider !== undefined) {
    const err = validateEnum(stt.provider, SETTINGS_STT_PROVIDERS, 'stt.provider')
    if (err) return { error: err }
    existing.provider = stt.provider
  }

  if (stt.whisperUrl !== undefined) {
    if (typeof stt.whisperUrl !== 'string') {
      return { error: 'stt.whisperUrl must be a string' }
    }
    existing.whisperUrl = stt.whisperUrl
  }

  if (stt.providerId !== undefined) {
    if (typeof stt.providerId !== 'string') {
      return { error: 'stt.providerId must be a string' }
    }
    existing.providerId = stt.providerId
  }

  if (stt.openaiModel !== undefined) {
    const err = validateEnum(stt.openaiModel, SETTINGS_STT_OPENAI_MODELS, 'stt.openaiModel')
    if (err) return { error: err }
    existing.openaiModel = stt.openaiModel
  }

  if (stt.ollamaModel !== undefined) {
    if (typeof stt.ollamaModel !== 'string') {
      return { error: 'stt.ollamaModel must be a string' }
    }
    existing.ollamaModel = stt.ollamaModel
  }

  if (stt.deepgramModel !== undefined) {
    if (typeof stt.deepgramModel !== 'string' || !stt.deepgramModel.trim()) {
      return { error: 'stt.deepgramModel must be a non-empty string' }
    }
    existing.deepgramModel = stt.deepgramModel.trim()
  }

  if (stt.deepgramLanguage !== undefined) {
    if (typeof stt.deepgramLanguage !== 'string') {
      return { error: 'stt.deepgramLanguage must be a string' }
    }
    existing.deepgramLanguage = stt.deepgramLanguage.trim()
  }

  if (stt.deepgramApiKey !== undefined) {
    if (typeof stt.deepgramApiKey !== 'string') {
      return { error: 'stt.deepgramApiKey must be a string' }
    }
    const raw = stt.deepgramApiKey
    if (!raw.includes('•')) {
      existing.deepgramApiKey = raw ? encrypt(raw) : ''
    }
  }

  if (stt.rewrite !== undefined) {
    const rewrite = stt.rewrite as Record<string, unknown>
    const existingRewrite = (existing.rewrite ?? {}) as Record<string, unknown>

    if (rewrite.enabled !== undefined) existingRewrite.enabled = !!rewrite.enabled

    if (rewrite.providerId !== undefined) {
      if (typeof rewrite.providerId !== 'string') {
        return { error: 'stt.rewrite.providerId must be a string' }
      }
      existingRewrite.providerId = rewrite.providerId
    }

    existing.rewrite = existingRewrite
  }

  settingsRaw.stt = existing
  return { error: null }
}
