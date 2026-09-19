import {
  normalizeSettingsContract,
  type SettingsContract,
  type SettingsUpdateContract,
  type MemoryConsolidationSettingsContract,
  type FactExtractionSettingsContract,
  type HealthMonitorNotificationTogglesContract,
  type HealthMonitorSettingsContract,
  type AgentHeartbeatSettingsContract,
  type TasksSettingsContract,
  type TtsSettingsContract,
  type SttSettingsContract,
  type UploadsSettingsContract,
  type WatchdogSettingsContract,
  type RetrySettingsContract,
  type AgentHeartbeatNightModeContract,
  type TelegramSettingsContract,
  type OfftangentSettingsContract,
} from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'

export type MemoryConsolidationSettings = MemoryConsolidationSettingsContract
export type FactExtractionSettings = FactExtractionSettingsContract
export type HealthMonitorNotificationToggles = HealthMonitorNotificationTogglesContract
export type HealthMonitorSettings = HealthMonitorSettingsContract
export type TasksSettings = TasksSettingsContract
export type AgentHeartbeatNightMode = AgentHeartbeatNightModeContract
export type AgentHeartbeatSettings = AgentHeartbeatSettingsContract
export type TtsSettings = TtsSettingsContract
export type SttSettings = SttSettingsContract
export type UploadsSettings = UploadsSettingsContract
export type WatchdogSettings = WatchdogSettingsContract
export type RetrySettings = RetrySettingsContract
export type TelegramSettings = TelegramSettingsContract
export type OfftangentSettings = OfftangentSettingsContract
export type Settings = SettingsContract

export function useSettings() {
  const settingsApi = useSettingsApi()

  const settings = ref<Settings | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)

  async function fetchSettings(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const result = await settingsApi.getSettings()
      settings.value = normalizeSettingsContract(result)
    } catch (err) {
      error.value = (err as Error).message
    } finally {
      loading.value = false
    }
  }

  const { poll: pollConnectionStatus } = useConnectionStatus()

  async function updateSettings(updates: Partial<SettingsUpdateContract>): Promise<boolean> {
    saving.value = true
    error.value = null
    successMessage.value = null
    try {
      const result = await settingsApi.updateSettings(updates)

      settings.value = normalizeSettingsContract(result)
      successMessage.value = 'saved'

      // Refresh global connection status so the topbar reflects changes
      // (e.g. Health Monitor enabled/disabled) immediately instead of waiting
      // for the next 30s poll.
      void pollConnectionStatus()
      return true
    } catch (err) {
      error.value = (err as Error).message
      return false
    } finally {
      saving.value = false
    }
  }

  function clearMessages() {
    error.value = null
    successMessage.value = null
  }

  return {
    settings,
    loading,
    saving,
    error,
    successMessage,
    fetchSettings,
    updateSettings,
    clearMessages,
  }
}
