/**
 * useMessageAnchor (W5b): open a strand AT a message. Search hits, recalled
 * messages and the "forked from" link route to `/strands/:id#msg-<id>`.
 *
 * The jump happens once, after the strand's history is in place (`ready`):
 * on a strand to strand navigation the transcript of the other strand loads
 * asynchronously, and anchoring earlier would hit nothing or a row that the
 * load replaces. The attempt waits one animation frame so the transcript's
 * own "scroll to the bottom after loading" has run and does not undo it. A
 * message older than the loaded window is not found; the page then simply
 * stays at its normal position (see FOLLOWUPS: load around a message).
 */
import { onScopeDispose, watch } from 'vue'

export const MESSAGE_ANCHOR_PATTERN = /^#msg-(\d{1,15})$/
const MARK_MS = 2400

export function anchoredMessageId(hash: string | null | undefined): number | null {
  const match = MESSAGE_ANCHOR_PATTERN.exec(hash ?? '')
  return match ? Number(match[1]) : null
}

function afterPaint(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const handle = requestAnimationFrame(fn)
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle) }
  }
  const handle = setTimeout(fn, 0)
  return () => clearTimeout(handle)
}

/**
 * `scope` re-arms the jump when the strand changes while the hash stays the
 * same; `ready` is true once that strand's history has been loaded.
 */
export function useMessageAnchor(
  hash: () => string | null | undefined,
  scope: () => string = () => '',
  ready: () => boolean = () => true,
) {
  let cancel: (() => void) | null = null
  let unmark: ReturnType<typeof setTimeout> | null = null
  function stop() {
    cancel?.()
    cancel = null
  }
  function jump(id: number) {
    const row = document.getElementById(`msg-${id}`)
    if (!row) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
    row.setAttribute('data-anchored', 'true')
    row.focus({ preventScroll: true })
    if (unmark) clearTimeout(unmark)
    unmark = setTimeout(() => row.removeAttribute('data-anchored'), MARK_MS)
  }
  watch(() => [hash(), scope(), ready()] as const, ([value, , isReady]) => {
    stop()
    const id = anchoredMessageId(value)
    if (id === null || !isReady || typeof document === 'undefined') return
    cancel = afterPaint(() => { cancel = null; jump(id) })
  }, { immediate: true, flush: 'post' })
  onScopeDispose(() => { stop(); if (unmark) clearTimeout(unmark) })
}
