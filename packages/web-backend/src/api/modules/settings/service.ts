import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getConfigDir, loadConfig, SETTINGS_THINKING_LEVELS } from '@axiom/core'
import type { SettingsData, SettingsRouterOptions, TelegramData } from './types.js'
import {
  mergeAgentHeartbeat,
  mergeConsolidation,
  mergeFactExtraction,
  mergeHealthMonitor,
  mergeInstanceIdentity,
  mergeMultiPersona,
  mergeOfftangent,
  mergeRetry,
  mergeStt,
  mergeTasks,
  mergeTts,
  mergeUploads,
  mergeWatchdog,
  normalizeSettingsPayload,
  validateEnum,
  validateNonEmptyString,
  validateNonNegativeNumber,
  validatePositiveNumber,
} from './schema.js'
import { mapSettingsResponse, mapSettingsUpdateResponse } from './mapper.js'

export class SettingsValidationError extends Error {}

export interface SettingsService {
  readSettings: () => ReturnType<typeof mapSettingsResponse>
  updateSettings: (payload: Record<string, unknown>) => ReturnType<typeof mapSettingsUpdateResponse>
}

export function createSettingsService(options: SettingsRouterOptions = {}): SettingsService {
  const getAgentCore = options.getAgentCore ?? (() => null)

  function readConfigFiles(): { settings: SettingsData; telegram: TelegramData } {
    ensureConfigTemplates()

    return {
      settings: loadConfig<SettingsData>('settings.json'),
      telegram: loadConfig<TelegramData>('telegram.json'),
    }
  }

  function readSettings() {
    const { settings, telegram } = readConfigFiles()

    return mapSettingsResponse({
      settings,
      telegram,
      batchingDelayMs: telegram.batchingDelayMs ?? 2500,
    })
  }

  function updateSettings(payload: Record<string, unknown>) {
    const body = normalizeSettingsPayload(payload)

    ensureConfigTemplates()

    const configDir = getConfigDir()
    const settingsPath = path.join(configDir, 'settings.json')
    const telegramPath = path.join(configDir, 'telegram.json')

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsData
    const telegram = JSON.parse(fs.readFileSync(telegramPath, 'utf-8')) as TelegramData

    const previousHealthMonitorInterval = settings.healthMonitorIntervalMinutes ?? 5
    const previousBatchingDelayMs = telegram.batchingDelayMs ?? 2500
    const previousTelegramEnabled = telegram.enabled
    const previousTelegramBotToken = telegram.botToken

    if (body.sessionTimeoutMinutes !== undefined) {
      // 0 disables the inactivity timer: the session manager treats
      // `timeoutMs <= 0` as "never end", and the runtime loader accepts 0.
      // A stricter check here locked the whole settings form once a 0 was
      // on disk, because the form echoes every field back.
      const err = validateNonNegativeNumber(body.sessionTimeoutMinutes, 'sessionTimeoutMinutes')
      if (err) throw new SettingsValidationError(err)
      settings.sessionTimeoutMinutes = body.sessionTimeoutMinutes as number
    }

    if (body.sessionSummaryProviderId !== undefined) {
      if (typeof body.sessionSummaryProviderId !== 'string') {
        throw new SettingsValidationError('sessionSummaryProviderId must be a string')
      }
      (settings as unknown as Record<string, unknown>).sessionSummaryProviderId = body.sessionSummaryProviderId
    }

    if (body.language !== undefined) {
      const err = validateNonEmptyString(body.language, 'language')
      if (err) throw new SettingsValidationError(err)
      settings.language = (body.language as string).trim()
    }

    if (body.timezone !== undefined) {
      const err = validateNonEmptyString(body.timezone, 'timezone')
      if (err) throw new SettingsValidationError(err)
      settings.timezone = (body.timezone as string).trim()
    }

    if (body.thinkingLevel !== undefined) {
      const err = validateEnum(body.thinkingLevel, SETTINGS_THINKING_LEVELS, 'thinkingLevel')
      if (err) throw new SettingsValidationError(err)
      ;(settings as unknown as Record<string, unknown>).thinkingLevel = body.thinkingLevel
    }

    if (body.healthMonitorIntervalMinutes !== undefined) {
      const err = validatePositiveNumber(body.healthMonitorIntervalMinutes, 'healthMonitorIntervalMinutes')
      if (err) throw new SettingsValidationError(err)
      settings.healthMonitorIntervalMinutes = body.healthMonitorIntervalMinutes as number
    }



    const settingsRaw = settings as unknown as Record<string, unknown>

    const healthMonitorMerge = mergeHealthMonitor(body, settingsRaw)
    if (healthMonitorMerge.error) throw new SettingsValidationError(healthMonitorMerge.error)

    const consolidationMerge = mergeConsolidation(body, settingsRaw)
    if (consolidationMerge.error) throw new SettingsValidationError(consolidationMerge.error)

    const factExtractionMerge = mergeFactExtraction(body, settingsRaw)
    if (factExtractionMerge.error) throw new SettingsValidationError(factExtractionMerge.error)

    const agentHeartbeatMerge = mergeAgentHeartbeat(body, settingsRaw)
    if (agentHeartbeatMerge.error) throw new SettingsValidationError(agentHeartbeatMerge.error)

    const multiPersonaMerge = mergeMultiPersona(body, settingsRaw)
    if (multiPersonaMerge.error) throw new SettingsValidationError(multiPersonaMerge.error)

    const tasksMerge = mergeTasks(body, settingsRaw)
    if (tasksMerge.error) throw new SettingsValidationError(tasksMerge.error)

    const ttsMerge = mergeTts(body, settingsRaw)
    if (ttsMerge.error) throw new SettingsValidationError(ttsMerge.error)

    const sttMerge = mergeStt(body, settingsRaw)
    if (sttMerge.error) throw new SettingsValidationError(sttMerge.error)

    const uploadsMerge = mergeUploads(body, settingsRaw)
    if (uploadsMerge.error) throw new SettingsValidationError(uploadsMerge.error)

    const watchdogMerge = mergeWatchdog(body, settingsRaw)
    if (watchdogMerge.error) throw new SettingsValidationError(watchdogMerge.error)

    const retryMerge = mergeRetry(body, settingsRaw)
    if (retryMerge.error) throw new SettingsValidationError(retryMerge.error)

    const offtangentMerge = mergeOfftangent(body, settingsRaw)
    if (offtangentMerge.error) throw new SettingsValidationError(offtangentMerge.error)

    const instanceIdentityMerge = mergeInstanceIdentity(body, settingsRaw)
    if (instanceIdentityMerge.error) throw new SettingsValidationError(instanceIdentityMerge.error)

    const telegramBody = body.telegram as Record<string, unknown> | undefined
    if (telegramBody !== undefined) {
      if (telegramBody.enabled !== undefined) {
        telegram.enabled = !!telegramBody.enabled
      }

      if (telegramBody.botToken !== undefined) {
        if (typeof telegramBody.botToken !== 'string') {
          throw new SettingsValidationError('telegram.botToken must be a string')
        }
        telegram.botToken = telegramBody.botToken.trim()
      }

      if (telegramBody.batchingDelayMs !== undefined) {
        const err = validateNonNegativeNumber(telegramBody.batchingDelayMs, 'telegram.batchingDelayMs')
        if (err) throw new SettingsValidationError(err)
        telegram.batchingDelayMs = telegramBody.batchingDelayMs as number
      }

      if (telegramBody.sendVoiceReply !== undefined) {
        telegram.sendVoiceReply = !!telegramBody.sendVoiceReply
      }

      if (telegramBody.sendStallWarnings !== undefined) {
        telegram.sendStallWarnings = !!telegramBody.sendStallWarnings
      }
    }

    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    fs.writeFileSync(telegramPath, `${JSON.stringify(telegram, null, 2)}\n`, 'utf-8')

    const agentCore = getAgentCore()
    if (agentCore) {
      try {
        if (body.sessionTimeoutMinutes !== undefined) {
          agentCore.getSessionManager().setTimeoutMinutes(settings.sessionTimeoutMinutes)
        }
        if (body.language !== undefined || body.timezone !== undefined || instanceIdentityMerge.changed) {
          agentCore.refreshSystemPrompt()
        }
        if (body.thinkingLevel !== undefined) {
          agentCore.setThinkingLevel(body.thinkingLevel as string)
        }
      } catch (err) {
        console.error('[axiom] Failed to apply live settings update:', err)
      }
    }

    if ((settings.healthMonitorIntervalMinutes ?? 5) !== previousHealthMonitorInterval || healthMonitorMerge.changed) {
      options.onHealthMonitorSettingsChanged?.()
    }

    if (consolidationMerge.changed) {
      options.onConsolidationSettingsChanged?.()
    }

    if (agentHeartbeatMerge.changed) {
      options.onAgentHeartbeatSettingsChanged?.()
    }

    // Multi-persona toggles which Telegram bots run (pool vs single bot),
    // so a change must restart the Telegram layer too.
    if (
      telegram.enabled !== previousTelegramEnabled
      || telegram.botToken !== previousTelegramBotToken
      || multiPersonaMerge.changed
    ) {
      options.onTelegramSettingsChanged?.()
    }

    return mapSettingsUpdateResponse({
      settings,
      telegram,
      batchingDelayMs: telegram.batchingDelayMs ?? previousBatchingDelayMs,
    })
  }

  return {
    readSettings,
    updateSettings,
  }
}
