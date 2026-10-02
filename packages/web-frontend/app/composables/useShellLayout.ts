/**
 * useShellLayout — binds the pure shell state (`~/utils/shellLayout`) to
 * localStorage and the window width. Shared by the layout, the strand
 * workspace and the command palette, so they always agree.
 */
import { computed } from 'vue'
import { useStorage, useWindowSize } from '@vueuse/core'
import {
  DEFAULT_SIDEBAR_STATE, SIDEBAR_WIDTH, columnTier, effectiveSidebarMode, contextPlacement, isContextOpen, parseContextOverrides,
  parseSidebarState, rememberContext, setSidebarMode, toggleSidebarCompact, toggleSidebarHidden,
  type ContextOverrides, type SidebarMode, type SidebarState,
} from '~/utils/shellLayout'

export const SIDEBAR_STORAGE_KEY = 'offtangent-sidebar'
export const CONTEXT_STORAGE_KEY = 'offtangent-context-column'

const sidebarSerializer = {
  read: (raw: string): SidebarState => parseSidebarState(raw),
  write: (value: SidebarState): string => JSON.stringify(value),
}
const contextSerializer = {
  read: (raw: string): ContextOverrides => parseContextOverrides(raw),
  write: (value: ContextOverrides): string => JSON.stringify(value),
}

export function useShellLayout() {
  const sidebar = useStorage<SidebarState>(SIDEBAR_STORAGE_KEY, { ...DEFAULT_SIDEBAR_STATE }, undefined, { serializer: sidebarSerializer })
  const overrides = useStorage<ContextOverrides>(CONTEXT_STORAGE_KEY, {}, undefined, { serializer: contextSerializer })
  // SSR / first paint assume a desktop window; the real width arrives on mount.
  const { width } = useWindowSize({ initialWidth: 1440 })

  const isMobile = computed(() => width.value < 768)
  /** The stored choice of the user. */
  const sidebarMode = computed<SidebarMode>(() => sidebar.value.mode)
  /** What is drawn at this width (see `effectiveSidebarMode`). */
  const effectiveMode = computed<SidebarMode>(() => effectiveSidebarMode(sidebar.value.mode, width.value))
  /** Width the sidebar takes from the page (the mobile drawer floats, 0). */
  const sidebarWidth = computed(() => SIDEBAR_WIDTH[effectiveMode.value])
  const tier = computed(() => columnTier(width.value))
  const placement = computed(() => contextPlacement(width.value, sidebarWidth.value))

  return {
    width,
    isMobile,
    sidebarMode,
    effectiveMode,
    sidebarWidth,
    tier,
    contextPlacement: placement,
    setSidebarMode(mode: SidebarMode) { sidebar.value = setSidebarMode(sidebar.value, mode) },
    toggleSidebarCompact() { sidebar.value = toggleSidebarCompact(sidebar.value) },
    toggleSidebarHidden() { sidebar.value = toggleSidebarHidden(sidebar.value) },
    contextOpen(strandId: string, hasContent: boolean) { return isContextOpen(overrides.value, strandId, hasContent) },
    setContextOpen(strandId: string, open: boolean) { overrides.value = rememberContext(overrides.value, strandId, open) },
  }
}
