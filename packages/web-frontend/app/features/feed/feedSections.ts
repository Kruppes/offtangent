import type { FeedItem } from '~/api/feed'
import { addDays, dayKey, parseInstant } from '~/utils/localDay'

/**
 * Pure helpers of the feed page (the app's FeedSections): day headings,
 * persona chips, the filter and the "body visible" rule. Midnight and time
 * zones are unit tests here, not a browser experiment.
 */
export type FeedDayLabel = { kind: 'today' } | { kind: 'yesterday' } | { kind: 'date'; day: string }
export interface FeedDayGroup { key: string; label: FeedDayLabel; items: FeedItem[] }

/** Items arrive newest first; each local calendar day becomes one group. Broken dates join the group above. */
export function feedDays(items: readonly FeedItem[], nowMs: number, timeZone?: string): FeedDayGroup[] {
  const today = dayKey(nowMs, timeZone)
  const yesterday = addDays(today, -1)
  const groups: FeedDayGroup[] = []
  for (const item of items) {
    const ms = parseInstant(item.createdAt)
    const key = ms === null ? (groups.at(-1)?.key ?? 'unknown') : dayKey(ms, timeZone)
    const last = groups.at(-1)
    if (last && last.key === key) { last.items.push(item); continue }
    const label: FeedDayLabel = key === today ? { kind: 'today' } : key === yesterday ? { kind: 'yesterday' } : { kind: 'date', day: key }
    groups.push({ key, label, items: [item] })
  }
  return groups
}

/** Persona key of an item; items without an agent belong to the default persona (''). */
export function personaKey(item: Pick<FeedItem, 'agentId'>): string {
  return item.agentId?.trim() || ''
}

/** Distinct personas in order of first appearance; chips only make sense with two or more. */
export function feedPersonas(items: readonly FeedItem[]): string[] {
  return [...new Set(items.map(personaKey))]
}

export interface FeedFilter { unreadOnly: boolean; kind: string; persona: string | null }
export function filterFeed(items: readonly FeedItem[], filter: FeedFilter): FeedItem[] {
  return items.filter(item => (!filter.unreadOnly || !item.readAt)
    && (!filter.kind || item.kind === filter.kind)
    && (filter.persona === null || personaKey(item) === filter.persona))
}

/** One rule for every kind: the body shows when expanded; a board update's body is its one-line summary and always shows. */
export function feedBodyVisible(item: Pick<FeedItem, 'kind' | 'body'>, expanded: boolean): boolean {
  return !!item.body?.trim() && (expanded || item.kind === 'board_update')
}

/** Whether a card has anything to expand. */
export function feedExpandable(item: Pick<FeedItem, 'kind' | 'body'>): boolean {
  return !!item.body?.trim() && item.kind !== 'board_update'
}

/** Initial letters for a persona badge (max two). */
export function personaInitials(label: string): string {
  const words = label.trim().split(/[\s_-]+/).filter(Boolean)
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}
