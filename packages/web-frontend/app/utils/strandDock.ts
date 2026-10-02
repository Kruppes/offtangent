/**
 * Pure state of the strand dock (W4c): the right column of the strand
 * workspace with two sections, "Activity" and "Context".
 *
 * - The column width is set by a drag handle between 280 and 560 px, but never
 *   so wide that the conversation loses its reading measure (see
 *   `dockMaxWidth` in `shellLayout.ts`).
 * - The height between the two sections is split by a second handle.
 * - Each section folds on its own.
 *
 * Width, split and the two fold states are one global preference (not per
 * strand): they describe how the user likes the workspace on this screen, and
 * a per-strand width would make the conversation jump sideways on every strand
 * switch. Whether the column is open at all stays per strand (W3).
 *
 * Everything here is a plain function of its inputs so it is unit-tested
 * without a browser; `useStrandDock` binds it to localStorage.
 */

export const DOCK_MIN_WIDTH = 280
export const DOCK_MAX_WIDTH = 560
/** Same as the W3 context column, so nothing moves for users who never drag. */
export const DOCK_DEFAULT_WIDTH = 320

/** The activity section never gets smaller than about three task rows. */
export const ACTIVITY_MIN_HEIGHT = 96
/** The context section keeps room for its first block. */
export const CONTEXT_MIN_HEIGHT = 120
export const ACTIVITY_DEFAULT_HEIGHT = 240

/** Arrow key step of both handles; with Shift the large step. */
export const DOCK_STEP = 16
export const DOCK_STEP_LARGE = 64

export type DockSection = 'activity' | 'context'

export interface DockState {
  /** Stored column width in px (the drawn width is clamped to the window). */
  width: number
  /** Stored height of the activity section in px when both sections are open. */
  activityHeight: number
  activityOpen: boolean
  contextOpen: boolean
}

export const DEFAULT_DOCK_STATE: DockState = {
  width: DOCK_DEFAULT_WIDTH,
  activityHeight: ACTIVITY_DEFAULT_HEIGHT,
  activityOpen: true,
  contextOpen: true,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Reads a stored value defensively: unknown or broken fields fall back to the defaults. */
export function parseDockState(raw: unknown): DockState {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return { ...DEFAULT_DOCK_STATE } }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_DOCK_STATE }
  const stored = value as Partial<Record<keyof DockState, unknown>>
  return {
    width: finite(stored.width) ? clamp(Math.round(stored.width), DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) : DEFAULT_DOCK_STATE.width,
    activityHeight: finite(stored.activityHeight) ? Math.max(ACTIVITY_MIN_HEIGHT, Math.round(stored.activityHeight)) : DEFAULT_DOCK_STATE.activityHeight,
    activityOpen: typeof stored.activityOpen === 'boolean' ? stored.activityOpen : DEFAULT_DOCK_STATE.activityOpen,
    contextOpen: typeof stored.contextOpen === 'boolean' ? stored.contextOpen : DEFAULT_DOCK_STATE.contextOpen,
  }
}

/**
 * The width actually drawn: the stored width inside 280..560 and inside what
 * the window leaves next to the conversation's reading measure. `maxWidth`
 * below the minimum still yields the minimum; the caller only places the dock
 * inline when the minimum fits (`contextPlacement`).
 */
export function clampDockWidth(width: number, maxWidth: number = DOCK_MAX_WIDTH): number {
  return clamp(Math.round(width), DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, maxWidth))
}

/** Largest activity height that still leaves the context section its minimum. */
export function activityMaxHeight(available: number): number {
  return Math.max(ACTIVITY_MIN_HEIGHT, Math.round(available) - CONTEXT_MIN_HEIGHT)
}

/** The activity height actually drawn inside the space both sections share. */
export function clampActivityHeight(height: number, available: number): number {
  return clamp(Math.round(height), ACTIVITY_MIN_HEIGHT, activityMaxHeight(available))
}

/** Bounds of a separator, as announced by aria-valuemin / -max. */
export interface SeparatorBounds { min: number; max: number }

/**
 * Keyboard of a separator (WAI-ARIA window splitter). `towardsGrow` names the
 * arrow keys that make the controlled pane bigger: for the column handle on
 * the dock's left edge that is ArrowLeft (the edge moves left), for the
 * height handle below the activity section ArrowDown. Home/End jump to the
 * bounds. Returns null for keys the separator does not handle.
 */
export function separatorKeyValue(
  key: string,
  shiftKey: boolean,
  current: number,
  bounds: SeparatorBounds,
  orientation: 'vertical' | 'horizontal',
): number | null {
  const step = shiftKey ? DOCK_STEP_LARGE : DOCK_STEP
  const grow = orientation === 'vertical' ? ['ArrowLeft'] : ['ArrowDown']
  const shrink = orientation === 'vertical' ? ['ArrowRight'] : ['ArrowUp']
  let next: number
  if (grow.includes(key)) next = current + step
  else if (shrink.includes(key)) next = current - step
  else if (key === 'Home') next = bounds.min
  else if (key === 'End') next = bounds.max
  else return null
  return clamp(next, bounds.min, bounds.max)
}

/**
 * Pointer drag of a separator. The column handle sits on the dock's LEFT
 * edge (vertical): moving the pointer left by N px makes the dock N px wider.
 * The height handle sits below the activity section (horizontal): moving it
 * down makes the activity section taller.
 */
export function separatorDragValue(
  orientation: 'vertical' | 'horizontal',
  startValue: number,
  startPos: number,
  pos: number,
  bounds: SeparatorBounds,
): number {
  const delta = orientation === 'vertical' ? startPos - pos : pos - startPos
  return clamp(Math.round(startValue + delta), bounds.min, bounds.max)
}

/** Bounds of the column handle at this window: 280 up to what the reading measure leaves. */
export function dockWidthBounds(maxWidth: number): SeparatorBounds {
  return { min: DOCK_MIN_WIDTH, max: Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(maxWidth))) }
}

/** Bounds of the height handle inside the space both sections share. */
export function activityHeightBounds(available: number): SeparatorBounds {
  return { min: ACTIVITY_MIN_HEIGHT, max: activityMaxHeight(available) }
}

export function setDockWidth(state: DockState, width: number): DockState {
  return { ...state, width: clampDockWidth(width) }
}

export function setActivityHeight(state: DockState, height: number): DockState {
  return { ...state, activityHeight: Math.max(ACTIVITY_MIN_HEIGHT, Math.round(height)) }
}

export function setSectionOpen(state: DockState, section: DockSection, open: boolean): DockState {
  return section === 'activity' ? { ...state, activityOpen: open } : { ...state, contextOpen: open }
}

export function toggleSection(state: DockState, section: DockSection): DockState {
  return setSectionOpen(state, section, !(section === 'activity' ? state.activityOpen : state.contextOpen))
}

/** Double click on a handle: back to the default size. */
export function resetDockWidth(state: DockState): DockState {
  return { ...state, width: DOCK_DEFAULT_WIDTH }
}

export function resetActivityHeight(state: DockState): DockState {
  return { ...state, activityHeight: ACTIVITY_DEFAULT_HEIGHT }
}

/** Layout of the two sections inside the dock. */
export type DockSplit =
  /** Both open: activity gets its height, a handle, context takes the rest. */
  | 'split'
  /** Only one open: it fills the dock below the other's header. */
  | 'activity-only'
  | 'context-only'
  /** Both folded: two header lines, nothing else. */
  | 'collapsed'

export function dockSplit(state: Pick<DockState, 'activityOpen' | 'contextOpen'>): DockSplit {
  if (state.activityOpen && state.contextOpen) return 'split'
  if (state.activityOpen) return 'activity-only'
  if (state.contextOpen) return 'context-only'
  return 'collapsed'
}

// ── Strand head hint while the column is closed ──────────────────────

export type RunningHint =
  | { kind: 'none' }
  | { kind: 'turn' }
  | { kind: 'tasks'; count: number }
  | { kind: 'turn-and-tasks'; count: number }

/**
 * What the strand head says while the dock is closed and something runs, so
 * the anti-freeze signal never disappears with the column (SPEC 10.x). An
 * open dock shows the signal itself, so the head says nothing.
 */
export function runningHint(dockOpen: boolean, turnRunning: boolean, liveTasks: number): RunningHint {
  if (dockOpen) return { kind: 'none' }
  const count = Math.max(0, Math.floor(liveTasks))
  if (turnRunning && count > 0) return { kind: 'turn-and-tasks', count }
  if (turnRunning) return { kind: 'turn' }
  if (count > 0) return { kind: 'tasks', count }
  return { kind: 'none' }
}
