/**
 * Rendering helpers for sealed secret handles (plan 2026-09-26, step 1).
 *
 * A handle looks like `{{secret:github-token-1}}` and stands where a secret was
 * in the text a person sent. The chat shows it as a small lock chip instead of
 * the raw braces — in new messages, in old ones, and in assistant text.
 *
 * Security: the slug is the ONLY dynamic part of the generated markup, and it
 * comes out of the shared contract regex, i.e. it can only contain lowercase
 * letters, digits and dashes. Everything else in the text is left to the
 * ordinary markdown pipeline. There is no interpolation of unfiltered data.
 */

import { createSecretHandleRegex, SECRET_HANDLE_SLUG_RE } from '@axiom/core/contracts'

/** One piece of a message text: ordinary text or a handle. */
export type SecretTextPart =
  | { type: 'text'; text: string }
  | { type: 'handle'; slug: string }

/** Split text into plain parts and handles, in order. */
export function splitSecretHandles(text: string): SecretTextPart[] {
  if (!text) return []
  const re = createSecretHandleRegex()
  const parts: SecretTextPart[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    const slug = match[1] ?? ''
    if (!SECRET_HANDLE_SLUG_RE.test(slug)) continue
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) })
    parts.push({ type: 'handle', slug })
    cursor = match.index + match[0].length
  }

  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) })
  return parts
}

/** How many handles the text contains. */
export function countSecretHandles(text: string): number {
  if (!text) return 0
  let count = 0
  const re = createSecretHandleRegex()
  while (re.exec(text) !== null) count++
  return count
}

/** True when the text carries at least one handle. */
export function hasSecretHandle(text: string): boolean {
  return countSecretHandles(text) > 0
}

/**
 * Labels used inside generated chip markup. Set once from the component tree
 * (which owns i18n); the markdown renderer is a module, not a component, so it
 * cannot call `$t` itself.
 */
let chipTooltip = 'Stored secret — the value never reaches the model'

/** Install the localized tooltip for every chip rendered from now on. */
export function setSecretChipTooltip(tooltip: string): void {
  if (tooltip) chipTooltip = tooltip
}

/** Current chip tooltip (exported for tests and for the Vue chip component). */
export function secretChipTooltip(): string {
  return chipTooltip
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const LOCK_SVG =
  '<svg class="secret-chip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>'
  + '<path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'

/**
 * HTML for one chip. Only called with a slug that matched the contract regex,
 * so the slug needs no escaping — it is escaped anyway, on the principle that
 * a future caller must not be able to turn this into an injection.
 */
export function secretChipHtml(slug: string): string {
  const safeSlug = escapeAttribute(slug)
  const title = escapeAttribute(`${chipTooltip} ({{secret:${slug}}})`)
  return `<span class="secret-chip" data-secret-chip="${safeSlug}" tabindex="0" role="note" `
    + `title="${title}" aria-label="${title}">${LOCK_SVG}<span class="secret-chip-slug">${safeSlug}</span></span>`
}

/**
 * Replace every handle in already-rendered HTML-free text with chip markup.
 * Used by the markdown extension and by the plain-text renderer.
 */
export function renderSecretHandlesToHtml(text: string): string {
  return splitSecretHandles(text)
    .map(part => (part.type === 'handle' ? secretChipHtml(part.slug) : escapeAttribute(part.text)))
    .join('')
}
