/**
 * useMessageAnchor (W5b): open a strand AT a message. Search hits, recalled
 * messages and the "forked from" link route to `/strands/:id#msg-<id>`; the
 * transcript loads asynchronously, so this waits (bounded) for the row to
 * appear, scrolls it into view, marks it briefly and moves the focus there.
 * A message older than the loaded window is not found; the page then simply
 * stays at its normal position (see FOLLOWUPS: load around a message).
 */
import { onBeforeUnmount, watch } from 'vue'

export const MESSAGE_ANCHOR_PATTERN = /^#msg-(\d{1,15})$/
const WAIT_MS = 6000
const STEP_MS = 150
const MARK_MS = 2400

export function anchoredMessageId(hash: string | null | undefined): number | null {
  const match = MESSAGE_ANCHOR_PATTERN.exec(hash ?? '')
  return match ? Number(match[1]) : null
}

/** `scope` re-arms the jump when the strand changes while the hash stays the same. */
export function useMessageAnchor(hash: () => string | null | undefined, scope: () => string = () => '') {
  let timer: ReturnType<typeof setTimeout> | null = null
  let unmark: ReturnType<typeof setTimeout> | null = null
  function stop() {
    if (timer) clearTimeout(timer)
    timer = null
  }
  function seek(id: number, started: number) {
    const row = document.getElementById(`msg-${id}`)
    if (row) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
      row.setAttribute('data-anchored', 'true')
      row.focus({ preventScroll: true })
      if (unmark) clearTimeout(unmark)
      unmark = setTimeout(() => row.removeAttribute('data-anchored'), MARK_MS)
      return
    }
    if (Date.now() - started < WAIT_MS) timer = setTimeout(() => seek(id, started), STEP_MS)
  }
  watch(() => [hash(), scope()] as const, ([value]) => {
    stop()
    const id = anchoredMessageId(value)
    if (id !== null && typeof document !== 'undefined') seek(id, Date.now())
  }, { immediate: true, flush: 'post' })
  onBeforeUnmount(() => { stop(); if (unmark) clearTimeout(unmark) })
}
