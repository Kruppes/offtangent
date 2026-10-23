/**
 * Panel text for the LED clock. The clock font (awtrix.bdf) carries printable
 * ASCII plus ÄÖÜäöüß and nothing else, so every string that leaves for the
 * clock goes through {@link panelText}: other letters lose their accents,
 * everything else unprintable is dropped, whitespace collapses to one line,
 * and the result is cut to a hard limit. The cut is marked with ".." because
 * the font has no "…" glyph.
 */

const KEEP = new Set(['Ä', 'Ö', 'Ü', 'ä', 'ö', 'ü', 'ß'])
const ELLIPSIS = '..'

function foldChar(ch: string): string {
  if (KEEP.has(ch)) return ch
  const code = ch.codePointAt(0) ?? 0
  if (code >= 0x20 && code <= 0x7e) return ch
  // Typographic quotes and dashes have obvious ASCII stand-ins.
  if ('‘’‚‛'.includes(ch)) return "'"
  if ('“”„‟'.includes(ch)) return '"'
  if ('–—‒―'.includes(ch)) return '-'
  if (ch === '…') return '...'
  // é -> e, ç -> c: decompose, keep the ASCII base letter.
  const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  if (base.length > 0 && [...base].every(c => (c.codePointAt(0) ?? 0) >= 0x20 && (c.codePointAt(0) ?? 0) <= 0x7e)) {
    return base
  }
  // Whitespace of any kind becomes a space; emoji and the rest disappear.
  return /\s/u.test(ch) ? ' ' : ''
}

/** Single line, clock-font-safe, at most `max` characters (code points). */
export function panelText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  // Markdown emphasis and code ticks are noise on twelve pixels of height.
  const stripped = raw.replace(/[*_`#>]+/g, ' ')
  const folded = [...stripped.normalize('NFC')].map(foldChar).join('')
  const line = folded.replace(/\s+/g, ' ').trim()
  const chars = [...line]
  if (chars.length <= max) return line
  return chars.slice(0, Math.max(0, max - ELLIPSIS.length)).join('').trimEnd() + ELLIPSIS
}

/**
 * The short form of an option label (≤ `max`, default 9): the label itself
 * when it fits, else its first word when that fits, else the label cut hard
 * (no ellipsis — nine pixels columns of "..": too expensive).
 */
export function shortLabel(label: string, max = 9): string {
  const chars = [...label]
  if (chars.length <= max) return label
  const firstWord = label.split(' ')[0] ?? ''
  if (firstWord.length >= 2 && [...firstWord].length <= max) return firstWord
  return chars.slice(0, max).join('').trimEnd()
}

/** Persona id as the clock knows it: lower case ASCII, accents folded. */
export function personaId(agentId: string | null | undefined): string {
  const raw = (agentId ?? 'main').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const clean = raw.replace(/[^a-z0-9_-]/g, '').slice(0, 16)
  return clean || 'main'
}
