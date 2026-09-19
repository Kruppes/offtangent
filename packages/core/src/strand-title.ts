/**
 * strand-title.ts: a strand title derived from text, without a model call.
 *
 * Used wherever a strand would otherwise stay untitled: the first turn of a
 * plain chat session and the router guard that opens a strand instead of
 * appending blindly. A titleless strand is invisible to the router (it offers
 * no evidence) and unreadable in the list, so deriving one from the first
 * words is strictly better than leaving it empty.
 */

/** Upper bound for a derived title, same ceiling the router prompt gets. */
export const DERIVED_TITLE_MAX = 60

/**
 * First words of `text` as a title: whitespace collapsed, cut on a word
 * boundary when possible, at most {@link DERIVED_TITLE_MAX} characters
 * including the single trailing ellipsis. Empty input yields an empty string.
 */
export function deriveStrandTitle(text: string, max: number = DERIVED_TITLE_MAX): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace >= Math.floor(max / 2) ? cut.slice(0, lastSpace) : cut
  return `${base.replace(/[\s,;:.!?_\-–—]+$/u, '')}…`
}
