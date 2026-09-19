import type { Thread } from '~/api/threads'
import { parseBackendTimestamp } from '../../utils/datetime'

/**
 * Pure display helpers for the thread inbox. Kept out of the composable so the
 * ordering and the labels can be unit-tested without a Nuxt runtime.
 */

/** Pinned threads first, then most recent activity first. */
export function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.lastActivity.localeCompare(a.lastActivity)
  })
}

export interface ThreadGroup {
  key: 'pinned' | 'recent'
  threads: Thread[]
}

/**
 * Split the sorted list into the two sections the inbox renders. Empty groups
 * are dropped so the UI never shows a headline without rows.
 */
export function groupThreads(threads: Thread[]): ThreadGroup[] {
  const sorted = sortThreads(threads)
  const groups: ThreadGroup[] = [
    { key: 'pinned', threads: sorted.filter(t => t.pinned) },
    { key: 'recent', threads: sorted.filter(t => !t.pinned) },
  ]
  return groups.filter(group => group.threads.length > 0)
}

/** Trim an excerpt to `max` characters, adding an ellipsis when it was cut. */
export function truncate(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

/**
 * Title fallback for an unnamed thread: the excerpt of its last message.
 * Returns `null` when the thread has no message at all, so the caller can
 * render a localized placeholder instead.
 */
export function threadFallbackTitle(thread: Thread): string | null {
  const content = thread.lastMessage?.content?.trim()
  if (!content) return null
  return truncate(content, 60)
}

/** One-line excerpt of the last message, prefixed for assistant replies. */
export function threadExcerpt(thread: Thread): string | null {
  const content = thread.lastMessage?.content?.trim()
  if (!content) return null
  return truncate(content, 140)
}

/**
 * Compact relative time for list rows: "now", "12m", "5h", "3d", then the
 * absolute date. English only by design (the UI has no German strings).
 */
export function formatRelativeTime(value: string, now: Date = new Date()): string {
  const date = parseBackendTimestamp(value)
  if (!date) return ''
  const diffMs = now.getTime() - date.getTime()
  const minutes = Math.floor(diffMs / 60_000)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date)
}
