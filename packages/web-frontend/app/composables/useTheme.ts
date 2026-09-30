import { computed } from 'vue'
import { useColorMode, usePreferredDark } from '@vueuse/core'

export type ColorMode = 'dark' | 'light' | 'auto'

export const COLOR_MODE_STORAGE_KEY = 'offtangent-color-mode'
const LEGACY_COLOR_MODE_STORAGE_KEY = 'axiom-color-mode'

function isColorMode(value: string | null): value is ColorMode {
  return value === 'light' || value === 'dark' || value === 'auto'
}

export function readColorMode(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): ColorMode {
  let preference: ColorMode = 'auto'
  try {
    const current = storage.getItem(COLOR_MODE_STORAGE_KEY)
    if (isColorMode(current)) preference = current
    const legacy = storage.getItem(LEGACY_COLOR_MODE_STORAGE_KEY)
    if (current === null && isColorMode(legacy)) {
      preference = legacy
      // Remove the legacy value only after the replacement has been persisted.
      storage.setItem(COLOR_MODE_STORAGE_KEY, legacy)
    }
    if (legacy !== null) storage.removeItem(LEGACY_COLOR_MODE_STORAGE_KEY)
  } catch {
    // Restricted storage must not prevent the UI from rendering.
  }
  return preference
}

export function initializeTheme(): ColorMode {
  if (typeof window === 'undefined') return 'auto'
  let preference: ColorMode = 'auto'
  try {
    preference = readColorMode(window.localStorage)
  } catch {
    // Accessing localStorage itself can throw in privacy-restricted contexts.
  }
  const dark = preference === 'dark' || (preference === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.classList.toggle('light', !dark)
  return preference
}

/**
 * Composable for managing dark/light/system theme with persistence.
 * Uses @vueuse/core useColorMode which:
 *   - Persists the choice to localStorage
 *   - Adds/removes `.dark` class on <html>
 *   - Falls back to system preference when mode is 'auto'
 */
export function useTheme() {
  const initialValue = initializeTheme()
  const mode = useColorMode({
    attribute: 'class',
    modes: {
      dark: 'dark',
      light: 'light',
    },
    storageKey: COLOR_MODE_STORAGE_KEY,
    initialValue,
    emitAuto: true,
  })

  const prefersDark = usePreferredDark()

  /** The resolved mode (never 'auto') */
  const resolvedMode = computed<'dark' | 'light'>(() => {
    if (mode.value === 'auto') {
      return prefersDark.value ? 'dark' : 'light'
    }
    return mode.value as 'dark' | 'light'
  })

  const isDark = computed(() => resolvedMode.value === 'dark')

  function setMode(newMode: ColorMode) {
    mode.value = newMode as typeof mode.value
  }

  function toggle() {
    mode.value = isDark.value ? 'light' : 'dark'
  }

  return {
    /** Current stored preference: 'dark' | 'light' | 'auto' */
    mode,
    /** Resolved effective mode (system preference resolved) */
    resolvedMode,
    /** Whether dark mode is currently active */
    isDark,
    /** Set the color mode preference */
    setMode,
    /** Toggle between dark and light */
    toggle,
  }
}
