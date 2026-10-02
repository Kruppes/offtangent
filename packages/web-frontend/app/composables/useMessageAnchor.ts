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
 *
 * Rich content above the target (lazy images, tables, artifacts) can still
 * change height after the jump; the row then drifts out of view. For a short
 * window the row is therefore followed: whenever the transcript resizes and
 * the row is no longer fully visible, the jump is repeated. Any user input
 * (wheel, touch, pointer, key) ends the follow at once, so it never fights
 * the reader.
 */
import { onScopeDispose, watch } from 'vue'

export const MESSAGE_ANCHOR_PATTERN = /^#msg-(\d{1,15})$/
const MARK_MS = 2400
/** The follow ends after this much layout quiet ... */
export const FOLLOW_SETTLE_MS = 700
/** ... or at the latest after this long. */
export const FOLLOW_MAX_MS = 5000
const USER_INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

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

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

/** Fully visible inside the scroll container (or the top edge, for a row taller than the view). */
function inView(row: HTMLElement, scroller: HTMLElement | null): boolean {
  const r = row.getBoundingClientRect()
  const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
  if (r.height > view.bottom - view.top) return r.top >= view.top - 1 && r.top <= view.bottom
  return r.top >= view.top - 1 && r.bottom <= view.bottom + 1
}

/** Keep `row` in view while the layout above it settles; returns the stop function. */
function follow(row: HTMLElement, behavior: ScrollBehavior): () => void {
  if (typeof ResizeObserver !== 'function') return () => {}
  const scroller = scrollParent(row)
  let frame: (() => void) | null = null
  let quiet: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const check = () => {
    frame = null
    if (!stopped && row.isConnected && !inView(row, scroller)) row.scrollIntoView({ block: 'center', behavior })
  }
  const observer = new ResizeObserver(() => {
    if (!frame) frame = afterPaint(check)
    if (quiet) clearTimeout(quiet)
    quiet = setTimeout(() => { check(); stop() }, FOLLOW_SETTLE_MS)
  })
  const hard = setTimeout(() => { check(); stop() }, FOLLOW_MAX_MS)
  function stop() {
    if (stopped) return
    stopped = true
    observer.disconnect()
    frame?.()
    if (quiet) clearTimeout(quiet)
    clearTimeout(hard)
    for (const type of USER_INTENT) window.removeEventListener(type, stop, true)
  }
  for (const type of USER_INTENT) window.addEventListener(type, stop, { capture: true, passive: true })
  // Every block between the scroll container and the row grows with the content above it.
  const container = scroller ?? document.body
  for (let node: HTMLElement | null = row; node && node !== container; node = node.parentElement) observer.observe(node)
  for (const child of Array.from(container.children)) observer.observe(child)
  return stop
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
  let unfollow: (() => void) | null = null
  function stop() {
    cancel?.()
    cancel = null
    unfollow?.()
    unfollow = null
  }
  function jump(id: number) {
    const row = document.getElementById(`msg-${id}`)
    if (!row) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth'
    row.scrollIntoView({ block: 'center', behavior })
    unfollow = follow(row, behavior)
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
