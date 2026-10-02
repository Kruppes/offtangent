/**
 * Pure decisions of the overview <-> strand transition (W4d).
 *
 * The browser part lives in `plugins/strandViewTransition.client.ts`; it asks
 * these functions whether a navigation animates, and in which direction.
 *
 *  - Only `/strands` (the overview) <-> `/strands/:id` animates, and only
 *    from the two-column width up (below 768 px the phone shows the list OR
 *    the strand and the browser's own navigation is enough).
 *  - Strand -> strand (switching in the side list, j/k + Enter) does not
 *    animate: that is the fast path and a morph per step would be noise.
 *  - `prefers-reduced-motion: reduce` or a browser without
 *    `document.startViewTransition` = an instant switch.
 */

export type StrandTransitionDirection = 'open' | 'close'

export interface StrandTransitionInput {
  supported: boolean
  reducedMotion: boolean
  viewport: number
  fromPath: string
  toPath: string
}

/** Two columns start here (same as `TWO_COLUMN_MIN` in shellLayout). */
export const TRANSITION_MIN_WIDTH = 768
/** Duration of the transition, inside the 220-280 ms of the brief. */
export const STRAND_TRANSITION_MS = 240
/** Name of the one row that morphs; only the opened row ever carries it. */
export const STRAND_ROW_TRANSITION_NAME = 'strand-active-row'

/** The strand id of a `/strands/:id` path, `null` for the overview, `undefined` for anything else. */
export function strandIdOfPath(path: string): string | null | undefined {
  const clean = path.split(/[?#]/, 1)[0]!.replace(/\/+$/, '')
  if (clean === '/strands') return null
  const match = /^\/strands\/([^/]+)$/.exec(clean)
  if (!match) return undefined
  try { return decodeURIComponent(match[1]!) } catch { return match[1]! }
}

/** `open` = overview -> strand, `close` = strand -> overview, otherwise null. */
export function transitionDirection(fromPath: string, toPath: string): StrandTransitionDirection | null {
  const from = strandIdOfPath(fromPath)
  const to = strandIdOfPath(toPath)
  if (from === null && typeof to === 'string') return 'open'
  if (typeof from === 'string' && to === null) return 'close'
  return null
}

/** Whether to run a view transition, and which one. */
export function strandTransition(input: StrandTransitionInput): StrandTransitionDirection | null {
  if (!input.supported || input.reducedMotion || input.viewport < TRANSITION_MIN_WIDTH) return null
  return transitionDirection(input.fromPath, input.toPath)
}

/**
 * Which strand row morphs: on open the row of the strand that opens, on
 * close the row of the strand that was open.
 */
export function morphingStrandId(fromPath: string, toPath: string): string | null {
  const direction = transitionDirection(fromPath, toPath)
  if (direction === 'open') return strandIdOfPath(toPath) as string
  if (direction === 'close') return strandIdOfPath(fromPath) as string
  return null
}
