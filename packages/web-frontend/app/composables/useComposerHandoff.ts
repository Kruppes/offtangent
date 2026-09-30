/**
 * useComposerHandoff — one piece of text handed from a screen to the capture
 * composer, in the same tab, exactly once.
 *
 * "Use in question" on a news story takes the reader to the composer with the
 * article snapshot already in the box and the cursor below it. The snapshot is
 * a kilobyte of text, so it does not belong in the URL (a query string that
 * long is logged, shared and truncated), and it must not survive the tab: it
 * is a draft, not state.
 *
 * `sessionStorage` is therefore the transport, and the read is destructive —
 * the composer takes the handoff, so a later reload or a second visit starts
 * empty instead of resurrecting an old snapshot. Nothing here is a secret: it
 * is board content the reader just had on screen. No token, no id, no session
 * data is written.
 */

/** One key: a second handoff replaces the first, it never queues behind it. */
export const COMPOSER_HANDOFF_KEY = 'offtangent.composer.handoff'

/** Hard cap, so a broken caller cannot fill the storage quota. */
export const COMPOSER_HANDOFF_MAX = 8000

/** Title cap, mirroring the server's `strandTitle` limit. */
export const COMPOSER_HANDOFF_TITLE_MAX = 60

/**
 * What a handoff carries besides the text.
 *
 * `newStrand` is the promise the news link makes: a question asked about an
 * article opens its OWN conversation. Without it the router would look for the
 * strand the article resembles most and the reader would be typing into an
 * unrelated conversation.
 */
export interface ComposerHandoff {
  text: string
  newStrand: boolean
  title: string | null
}

export interface ComposerHandoffOptions {
  newStrand?: boolean
  title?: string | null
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage ?? null
  } catch {
    // Storage denied (private mode, blocked cookies): the caller navigates
    // anyway and the composer simply opens empty.
    return null
  }
}

/** Put `text` in the composer's hands. Returns false when storage is unusable. */
export function setComposerHandoff(text: string, options: ComposerHandoffOptions = {}): boolean {
  const store = storage()
  const value = typeof text === 'string' ? text.slice(0, COMPOSER_HANDOFF_MAX) : ''
  if (!store || !value.trim()) return false
  const title = typeof options.title === 'string' ? options.title.replace(/\s+/g, ' ').trim().slice(0, COMPOSER_HANDOFF_TITLE_MAX) : ''
  const payload: ComposerHandoff = { text: value, newStrand: options.newStrand === true, title: title || null }
  try {
    store.setItem(COMPOSER_HANDOFF_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

/**
 * Read and remove the pending handoff, or null when there is none.
 *
 * A value written by an older tab is a bare string, not JSON; it is still a
 * valid handoff and stays one (text only, router decides).
 */
export function takeComposerHandoff(): ComposerHandoff | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(COMPOSER_HANDOFF_KEY)
    store.removeItem(COMPOSER_HANDOFF_KEY)
    if (!raw || !raw.trim()) return null
    if (!raw.startsWith('{')) return { text: raw, newStrand: false, title: null }
    const parsed = JSON.parse(raw) as Partial<ComposerHandoff>
    const text = typeof parsed.text === 'string' ? parsed.text : ''
    if (!text.trim()) return null
    return { text, newStrand: parsed.newStrand === true, title: typeof parsed.title === 'string' && parsed.title ? parsed.title : null }
  } catch {
    return null
  }
}
