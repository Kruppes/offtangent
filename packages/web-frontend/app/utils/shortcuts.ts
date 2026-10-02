/**
 * Pure keyboard-shortcut matching for the shell (W3).
 *
 * One table of bindings, one decision function. The composable
 * `useShortcuts` installs the single window listener and calls
 * `resolveShortcut`; components only register handlers by id.
 *
 * Rules:
 *  - plain keys (j, k, /, ?) never fire while the focus is in an input,
 *    textarea, select or contenteditable element;
 *  - Ctrl/Cmd combinations fire there only when the binding says so;
 *  - browser standards (Ctrl+F, Ctrl+L, Ctrl+T, ...) are never bound — the
 *    table is checked against `RESERVED_BROWSER_COMBOS` in the tests.
 */

export type ShortcutId =
  | 'palette.toggle'
  | 'sidebar.toggle'
  | 'help.open'
  | 'search.focus'
  | 'list.next'
  | 'list.previous'
  | 'canvas.toggle'
  | 'dismiss'
  | 'context.toggle'

export type ShortcutGroup = 'general' | 'navigation' | 'strand'

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  repeat?: boolean
}

export interface ShortcutBinding {
  id: ShortcutId
  /** `mod` = Ctrl on Windows/Linux, Cmd on macOS (either is accepted). */
  mod?: boolean
  shift?: boolean
  /** Compared case-insensitively against `event.key`. */
  key: string
  /** Whether it may fire while typing in a field (only sensible with `mod`). */
  inEditable?: boolean
  /** Whether it still fires while a modal overlay (palette, help) is open. */
  inOverlay?: boolean
  group: ShortcutGroup
  /** Display keys for the help overlay, e.g. ['Ctrl', 'K']. `Ctrl` is shown as ⌘ on macOS. */
  display: string[]
}

export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  { id: 'palette.toggle', mod: true, key: 'k', inEditable: true, inOverlay: true, group: 'general', display: ['Ctrl', 'K'] },
  { id: 'help.open', key: '?', shift: true, group: 'general', display: ['?'] },
  { id: 'sidebar.toggle', mod: true, key: 'b', group: 'general', display: ['Ctrl', 'B'] },
  { id: 'sidebar.toggle', mod: true, key: '\\', inEditable: true, group: 'general', display: ['Ctrl', '\\'] },
  { id: 'search.focus', key: '/', group: 'navigation', display: ['/'] },
  { id: 'list.next', key: 'j', group: 'navigation', display: ['J'] },
  { id: 'list.previous', key: 'k', group: 'navigation', display: ['K'] },
  // Existing canvas keys (SPEC 2.8), moved here unchanged from the canvas' own listener.
  { id: 'canvas.toggle', mod: true, key: 'j', inEditable: true, group: 'strand', display: ['Ctrl', 'J'] },
  // Esc closes the canvas (SPEC 2.8) or the floating sidebar; overlays of reka-ui handle their own Esc.
  { id: 'dismiss', key: 'Escape', inEditable: true, group: 'general', display: ['Esc'] },
  { id: 'context.toggle', mod: true, key: '.', inEditable: true, group: 'strand', display: ['Ctrl', '.'] },
]

/**
 * Shortcuts handled elsewhere but listed in the help overlay so it shows ALL
 * keys: native Enter on a focused row, Esc in overlays, and the W1 dictation
 * keys (unchanged, bound in the composer).
 */
export interface ShortcutHint { id: string; group: ShortcutGroup; display: string[] }
export const EXTERNAL_SHORTCUT_HINTS: readonly ShortcutHint[] = [
  { id: 'list.open', group: 'navigation', display: ['Enter'] },
  { id: 'dictation.toggle', group: 'strand', display: ['Ctrl', 'M'] },
  { id: 'dictation.cancel', group: 'strand', display: ['Esc'] },
  // Text fields that send (Home capture, task reply): Ctrl/⌘+Enter sends, plain Enter is a new line.
  { id: 'field.submit', group: 'general', display: ['Ctrl', 'Enter'] },
  { id: 'palette.move', group: 'general', display: ['↑', '↓'] },
  { id: 'palette.run', group: 'general', display: ['Enter'] },
]

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['general', 'navigation', 'strand']

export interface HelpRow { id: string; combos: string[][] }

/**
 * Rows of the help overlay: every binding and every hint, one row per id
 * (alternatives such as Ctrl+B / Ctrl+\ become one row with two combos),
 * grouped in display order.
 */
export function helpSections(
  bindings: readonly ShortcutBinding[] = SHORTCUT_BINDINGS,
  hints: readonly ShortcutHint[] = EXTERNAL_SHORTCUT_HINTS,
): Array<{ group: ShortcutGroup; rows: HelpRow[] }> {
  return SHORTCUT_GROUPS.map(group => {
    const rows: HelpRow[] = []
    for (const entry of [...bindings, ...hints]) {
      if (entry.group !== group) continue
      const row = rows.find(r => r.id === entry.id)
      if (row) row.combos.push([...entry.display])
      else rows.push({ id: entry.id, combos: [[...entry.display]] })
    }
    return { group, rows }
  }).filter(section => section.rows.length > 0)
}

/** macOS shows ⌘ instead of Ctrl (both are accepted everywhere). */
export function isMacPlatform(nav: { platform?: string; userAgent?: string } | undefined): boolean {
  if (!nav) return false
  return /mac|iphone|ipad|ipod/i.test(nav.platform || nav.userAgent || '')
}

/** Browser/OS combinations the shell must never take over. */
export const RESERVED_BROWSER_COMBOS = ['f', 'l', 't', 'w', 'n', 'r', 'p', 's', 'd', 'h', 'o', 'u', 'g', 'e', 'a', 'c', 'v', 'x', 'z', 'y', 'q', 'tab', '+', '-', '0'] as const

export function isEditableElement(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const node = el as { tagName?: unknown; isContentEditable?: unknown; type?: unknown }
  if (node.isContentEditable === true) return true
  if (typeof node.tagName !== 'string') return false
  const tag = node.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  // Checkboxes, radios and buttons do not take text: plain keys stay usable.
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : 'text'
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type)
}

export interface ResolveContext {
  /** Focus (or the event target) is a text-entry element. */
  editable: boolean
  /** A modal overlay of the shell is open. */
  overlayOpen: boolean
}

function bindingMatches(binding: ShortcutBinding, event: KeyLike): boolean {
  const mod = Boolean(event.ctrlKey || event.metaKey)
  if (Boolean(binding.mod) !== mod) return false
  if (event.altKey) return false
  // `?` needs Shift on most layouts; the key value already says `?`.
  if (binding.key !== "?" && Boolean(binding.shift) !== Boolean(event.shiftKey)) return false
  return event.key.toLowerCase() === binding.key.toLowerCase()
}

/** The binding to run for this key press, or null to leave the event alone. */
export function resolveShortcut(event: KeyLike, context: ResolveContext, bindings: readonly ShortcutBinding[] = SHORTCUT_BINDINGS): ShortcutBinding | null {
  if (event.isComposing) return null
  for (const binding of bindings) {
    if (!bindingMatches(binding, event)) continue
    if (context.editable && !binding.inEditable) return null
    if (context.overlayOpen && !binding.inOverlay) return null
    return binding
  }
  return null
}

/** Display keys for the platform: Ctrl becomes ⌘ on macOS. */
export function displayKeys(keys: readonly string[], mac: boolean): string[] {
  return keys.map(key => (mac && key === 'Ctrl' ? '⌘' : key))
}

/**
 * Roving focus over list rows: the index to move to for j/k.
 * `current` is -1 when no row has focus; then j starts at the active row (or
 * the first) and k at the active row (or the last).
 */
export function stepIndex(current: number, count: number, direction: 1 | -1, activeIndex = -1): number {
  if (count <= 0) return -1
  if (current < 0) {
    if (activeIndex >= 0 && activeIndex < count) return activeIndex
    return direction === 1 ? 0 : count - 1
  }
  return Math.min(count - 1, Math.max(0, current + direction))
}
