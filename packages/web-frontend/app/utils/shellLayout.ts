/**
 * Pure layout state of the app shell (W3): the sidebar's three modes, the
 * column tiers of the strand workspace and where the context column goes.
 *
 * Everything here is a plain function of its inputs so it can be unit-tested
 * without a browser; the composable `useShellLayout` only binds it to
 * localStorage and the window size.
 */

import { DOCK_DEFAULT_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, clampDockWidth } from './strandDock'

/** Labelled (256 px), icons only (56 px) or gone (0 px). */
export type SidebarMode = 'full' | 'rail' | 'hidden'
export type VisibleSidebarMode = Exclude<SidebarMode, 'hidden'>

export const SIDEBAR_WIDTH: Record<SidebarMode, number> = { full: 256, rail: 56, hidden: 0 }

export interface SidebarState {
  mode: SidebarMode
  /** The mode to return to when the sidebar comes back from `hidden`. */
  lastVisible: VisibleSidebarMode
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = { mode: 'full', lastVisible: 'full' }

function isMode(value: unknown): value is SidebarMode {
  return value === 'full' || value === 'rail' || value === 'hidden'
}

/** Reads a stored value defensively: anything unknown falls back to the default. */
export function parseSidebarState(raw: unknown): SidebarState {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return { ...DEFAULT_SIDEBAR_STATE } }
  }
  if (!value || typeof value !== 'object') return { ...DEFAULT_SIDEBAR_STATE }
  const { mode, lastVisible } = value as Partial<SidebarState>
  const safeMode = isMode(mode) ? mode : DEFAULT_SIDEBAR_STATE.mode
  const safeLast: VisibleSidebarMode = lastVisible === 'rail' || lastVisible === 'full'
    ? lastVisible
    : safeMode === 'hidden' ? 'full' : safeMode
  return { mode: safeMode, lastVisible: safeMode === 'hidden' ? safeLast : safeMode }
}

export function setSidebarMode(state: SidebarState, mode: SidebarMode): SidebarState {
  return { mode, lastVisible: mode === 'hidden' ? state.lastVisible : mode }
}

/** The collapse button: labelled <-> icons. From `hidden` it brings the sidebar back. */
export function toggleSidebarCompact(state: SidebarState): SidebarState {
  if (state.mode === 'hidden') return setSidebarMode(state, state.lastVisible)
  return setSidebarMode(state, state.mode === 'full' ? 'rail' : 'full')
}

/** The keyboard shortcut: away completely, and back to the last visible mode. */
export function toggleSidebarHidden(state: SidebarState): SidebarState {
  return state.mode === 'hidden' ? setSidebarMode(state, state.lastVisible) : setSidebarMode(state, 'hidden')
}

/** Below this the labelled sidebar would squeeze the reading column; it shows as icons. */
export const FULL_SIDEBAR_MIN = 1280

/**
 * The mode actually drawn at this window width. Phones use the drawer (no
 * width taken). Between 768 and 1279 px a labelled sidebar is drawn as icons
 * so list + conversation keep their measure; the user can still unfold it as
 * an overlay. From 1280 px the stored mode applies as is.
 */
export function effectiveSidebarMode(mode: SidebarMode, viewport: number): SidebarMode {
  if (viewport < TWO_COLUMN_MIN) return 'hidden'
  if (mode === 'full' && viewport < FULL_SIDEBAR_MIN) return 'rail'
  return mode
}

// ── Strand workspace columns ─────────────────────────────────────────

/** One column like the app, list + conversation, or list + conversation + context. */
export type ColumnTier = 'one' | 'two' | 'three'

export const TWO_COLUMN_MIN = 768
export const THREE_COLUMN_MIN = 1024
/** Strand list column (approved draft: 320 px; 304 px leaves the reading column its 31rem). */
export const LIST_WIDTH = 304
/** Default width of the right column (the dock; W4c makes it draggable, see `strandDock.ts`). */
export const CONTEXT_WIDTH = DOCK_DEFAULT_WIDTH
/**
 * Below this the conversation cannot hold its reading measure. An answer row
 * is capped at 34rem (31rem of running text plus avatar and bubble padding,
 * see `ChatMessageRow`); the transcript adds 2 x 16 px around it, so the
 * column needs 36rem = 576 px. W3 counted only the transcript padding
 * (528 px); measured at 528 px the answers dropped to 46-58 characters per
 * line, at 576 px they hold 59-64 (W4c report).
 */
export const MIN_CONVERSATION_WIDTH = 576

export function columnTier(viewport: number): ColumnTier {
  if (viewport >= THREE_COLUMN_MIN) return 'three'
  if (viewport >= TWO_COLUMN_MIN) return 'two'
  return 'one'
}

/**
 * The widest the right column may get at this window width: what is left
 * after sidebar, list and the conversation's reading measure (31rem plus its
 * padding), and never more than 560 px. This is the hard rule of W4c: dragging
 * the column can never squeeze the conversation below its measure.
 */
export function dockMaxWidth(viewport: number, sidebarWidth: number): number {
  return Math.min(DOCK_MAX_WIDTH, viewport - sidebarWidth - LIST_WIDTH - MIN_CONVERSATION_WIDTH)
}

/**
 * Where the right column (context dock) goes. Inline only when the
 * conversation keeps its reading width next to sidebar, list and the column
 * at its minimum width; otherwise it opens as a sheet over the conversation
 * (also on two-column and phone widths).
 */
export function contextPlacement(viewport: number, sidebarWidth: number): 'inline' | 'overlay' {
  if (columnTier(viewport) !== 'three') return 'overlay'
  return dockMaxWidth(viewport, sidebarWidth) >= DOCK_MIN_WIDTH ? 'inline' : 'overlay'
}

/** The width the inline column is drawn with: the stored width, clamped to the window. */
export function inlineDockWidth(storedWidth: number, viewport: number, sidebarWidth: number): number {
  return clampDockWidth(storedWidth, dockMaxWidth(viewport, sidebarWidth))
}

/**
 * Which panes a strand route shows at this tier. Without an open strand the
 * list is the full-width overview (W4d) on every tier; only an open strand
 * shrinks it to the side column (two and three columns) or replaces it
 * (phone). The side list keeps `LIST_WIDTH`, which `dockMaxWidth` relies on.
 */
export function visiblePanes(tier: ColumnTier, strandOpen: boolean): { list: boolean; conversation: boolean } {
  if (tier === 'one') return { list: !strandOpen, conversation: strandOpen }
  return { list: true, conversation: strandOpen }
}

/** The list is the full-width overview (no strand open) or the side column. */
export function listMode(tier: ColumnTier, strandOpen: boolean): 'overview' | 'side' | 'hidden' {
  if (!strandOpen) return 'overview'
  return tier === 'one' ? 'hidden' : 'side'
}

// ── Context column open/closed, remembered per strand ────────────────

export type ContextOverrides = Record<string, boolean>
const MAX_OVERRIDES = 100

/**
 * Approved draft, assumption 3: open by default only when the strand has
 * something to show (canvas views); a manual toggle is remembered per strand.
 */
export function isContextOpen(overrides: ContextOverrides, strandId: string, hasContent: boolean): boolean {
  const manual = overrides[strandId]
  return typeof manual === 'boolean' ? manual : hasContent
}

/** Stores a manual choice; the oldest entries drop out beyond 100 strands. */
export function rememberContext(overrides: ContextOverrides, strandId: string, open: boolean): ContextOverrides {
  const next: ContextOverrides = {}
  const keys = Object.keys(overrides).filter(key => key !== strandId)
  for (const key of keys.slice(Math.max(0, keys.length - (MAX_OVERRIDES - 1)))) next[key] = overrides[key]!
  next[strandId] = open
  return next
}

export function parseContextOverrides(raw: unknown): ContextOverrides {
  let value = raw
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return {} }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: ContextOverrides = {}
  for (const [key, open] of Object.entries(value)) if (typeof open === 'boolean') out[key] = open
  return out
}
