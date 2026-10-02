/**
 * useStrandDock — binds the pure dock state (`~/utils/strandDock`) to
 * localStorage. One global preference, not per strand: width, height split
 * and fold states describe how the user likes the workspace on this screen;
 * a per-strand width would shift the conversation on every strand switch.
 * Whether the column is open at all stays per strand (`useShellLayout`).
 */
import { useStorage } from '@vueuse/core'
import {
  DEFAULT_DOCK_STATE, parseDockState, resetActivityHeight, resetDockWidth, setActivityHeight, setDockWidth, setSectionOpen, toggleSection,
  type DockSection, type DockState,
} from '~/utils/strandDock'

export const DOCK_STORAGE_KEY = 'offtangent-strand-dock'

const serializer = {
  read: (raw: string): DockState => parseDockState(raw),
  write: (value: DockState): string => JSON.stringify(value),
}

export function useStrandDock() {
  const state = useStorage<DockState>(DOCK_STORAGE_KEY, { ...DEFAULT_DOCK_STATE }, undefined, { serializer })
  return {
    state,
    setWidth(width: number) { state.value = setDockWidth(state.value, width) },
    resetWidth() { state.value = resetDockWidth(state.value) },
    setActivityHeight(height: number) { state.value = setActivityHeight(state.value, height) },
    resetActivityHeight() { state.value = resetActivityHeight(state.value) },
    setSectionOpen(section: DockSection, open: boolean) { state.value = setSectionOpen(state.value, section, open) },
    toggleSection(section: DockSection) { state.value = toggleSection(state.value, section) },
  }
}
