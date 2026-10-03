/**
 * W7: after "Undo" restores acknowledged entries, the Undo button itself
 * disappears. Move keyboard focus to the dismiss button of the first restored
 * entry that is actually rendered (`data-ack-id`), or else onto the list, so
 * focus never falls back to <body>.
 */
export function focusRestored(container: HTMLElement | null | undefined, ids: readonly string[]): HTMLElement | null {
  if (!container) return null
  for (const id of ids) {
    const candidates = container.querySelectorAll<HTMLElement>('[data-ack-id]')
    for (const el of candidates) {
      if (el.dataset.ackId !== id) continue
      // Both layouts (table and cards) may be in the DOM; skip the hidden one.
      if (el.getClientRects().length === 0) continue
      el.focus()
      return el
    }
  }
  if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1')
  container.focus()
  return container
}
