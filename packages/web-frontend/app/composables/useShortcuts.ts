/**
 * useShortcuts — the ONE global keydown listener of the shell (W3).
 *
 * Components register a handler for a shortcut id while they are mounted
 * (`onShortcut('list.next', fn)`); the binding table and the rules about
 * input fields and browser standards live in `~/utils/shortcuts`. The most
 * recently registered handler of an id runs first, so a page can take over a
 * key from the layout while it is on screen; returning `false` hands the key
 * to the next handler (e.g. Esc: canvas first, then the floating sidebar).
 *
 * Overlays of the shell (palette, help) mark themselves open via
 * `setOverlayOpen`, which mutes every plain-key shortcut while they are up.
 */
import { onBeforeUnmount, ref } from 'vue'
import { isEditableElement, resolveShortcut, type ShortcutId } from '~/utils/shortcuts'

/** Return `false` when the key was not for you: the event then stays untouched. */
type Handler = (event: KeyboardEvent) => boolean | void

const handlers = new Map<ShortcutId, Handler[]>()
const openOverlays = ref(0)
let installed = false

function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  const active = typeof document !== 'undefined' ? document.activeElement : null
  const editable = isEditableElement(event.target) || isEditableElement(active)
  const binding = resolveShortcut(event, { editable, overlayOpen: openOverlays.value > 0 })
  if (!binding) return
  // Newest handler first; one that returns `false` passes the key on.
  const stack = [...(handlers.get(binding.id) ?? [])].reverse()
  for (const handler of stack) {
    if (handler(event) === false) continue
    event.preventDefault()
    return
  }
}

function install(): void {
  if (installed || typeof window === 'undefined') return
  window.addEventListener('keydown', onKeydown)
  installed = true
}

/** Registers a handler; returns the function that removes it again. */
export function registerShortcut(id: ShortcutId, handler: Handler): () => void {
  install()
  const stack = handlers.get(id) ?? []
  stack.push(handler)
  handlers.set(id, stack)
  return () => {
    const current = handlers.get(id)
    if (!current) return
    const index = current.lastIndexOf(handler)
    if (index >= 0) current.splice(index, 1)
    if (!current.length) handlers.delete(id)
  }
}

/** Component helper: registered for the lifetime of the calling component. */
export function onShortcut(id: ShortcutId, handler: Handler): void {
  if (typeof window === 'undefined') return
  const release = registerShortcut(id, handler)
  onBeforeUnmount(release)
}

export function useShortcutOverlay() {
  return {
    overlayOpen: openOverlays,
    setOverlayOpen(open: boolean) {
      openOverlays.value = Math.max(0, openOverlays.value + (open ? 1 : -1))
    },
  }
}

/** Test seam. */
export function resetShortcutsForTest(): void {
  handlers.clear()
  openOverlays.value = 0
  if (installed && typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown)
  installed = false
}

export const __test = { onKeydown }
