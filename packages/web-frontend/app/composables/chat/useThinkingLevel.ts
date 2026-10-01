import { computed, ref, type Ref } from 'vue'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'

/**
 * Thinking level quick-switch in the composer. Backed by the same
 * `thinkingLevel` setting as the Settings page; changes are live-applied to
 * the agent (see `AgentCore.setThinkingLevel`). Admin-only because the main
 * agent is single-tenant — flipping this affects everyone's next turn.
 */
export function useThinkingLevel(isAdmin: Ref<boolean>) {
  const settingsApi = useSettingsApi()
  const current = ref<SettingsThinkingLevel>('off')
  const pickerOpen = ref(false)
  const saving = ref(false)

  // Brain button color encodes thinking intensity (no text label needed):
  // off=gray, minimal=white, low→xhigh progressively to red
  const brainColorClass = computed(() => {
    const map: Record<SettingsThinkingLevel, string> = {
      off: 'text-muted-foreground',
      minimal: 'text-foreground',
      low: 'text-yellow-500 dark:text-yellow-400',
      medium: 'text-orange-500 dark:text-orange-400',
      high: 'text-red-500 dark:text-red-400',
      xhigh: 'text-red-600 dark:text-red-500',
    }
    return map[current.value] ?? 'text-muted-foreground'
  })

  async function load() {
    if (!isAdmin.value) return
    try {
      const settings = await settingsApi.getSettings()
      if (settings.thinkingLevel && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(settings.thinkingLevel)) {
        current.value = settings.thinkingLevel as SettingsThinkingLevel
      }
    } catch {
      // keep default 'off' if we can't reach the endpoint
    }
  }

  async function change(level: SettingsThinkingLevel) {
    if (level === current.value) {
      pickerOpen.value = false
      return
    }
    const previous = current.value
    current.value = level // optimistic
    pickerOpen.value = false
    saving.value = true
    try {
      await settingsApi.updateSettings({ thinkingLevel: level })
    } catch {
      // rollback on failure
      current.value = previous
    } finally {
      saving.value = false
    }
  }

  return { levels: SETTINGS_THINKING_LEVELS, current, pickerOpen, saving, brainColorClass, load, change }
}

export type ThinkingLevelState = ReturnType<typeof useThinkingLevel>
