import type { CaptureListPage, CapturePart, CaptureResult } from '~/api/captures'
import { newestDecision } from '~/api/captures'

/**
 * Pure helpers for split captures and the unsorted tray. The backend hands
 * out `parts` additively; an older backend (or a capture that was not split)
 * has exactly one part, which is the decision itself.
 */
export function partsOf(result: CaptureResult): CapturePart[] {
  const parts = result.parts?.length ? [...result.parts] : [{ index: 0, title: null, text: result.capture.text, sentenceIds: [], decision: result.decision }]
  return parts.sort((a, b) => a.index - b.index)
}

export function isSplit(result: CaptureResult): boolean {
  return partsOf(result).length > 1
}

export type PartState = 'placed' | 'open' | 'undone'
/** Placed = applied or confirmed, open = still a proposal, undone = taken back. */
export function partState(part: CapturePart): PartState {
  const state = part.decision.state
  if (state === 'applied' || state === 'confirmed') return 'placed'
  if (state === 'undone' || state === 'superseded') return 'undone'
  return 'open'
}

/** Label of a part: its own title, else the first words of its text. */
export function partLabel(part: CapturePart, max = 60): string {
  const source = (part.title || part.text || '').trim().replace(/\s+/g, ' ')
  return source.length > max ? `${source.slice(0, max - 1).trimEnd()}…` : source
}

export const TRAY_STATUSES = ['unsorted', 'needs_review', 'failed'] as const

/** One list of tray cards from the per-status pages, newest first, each capture once. */
export function trayItems(pages: readonly CaptureListPage[]): CaptureResult[] {
  const seen = new Set<string>()
  const items: CaptureResult[] = []
  for (const page of pages) {
    for (const capture of page.captures) {
      if (seen.has(capture.id)) continue
      const decision = newestDecision(capture.id, page.decisions)
      if (!decision) continue
      seen.add(capture.id)
      const parts = page.parts?.[capture.id]
      items.push({ capture, decision, ...(parts?.length ? { parts, partCount: parts.length } : {}) })
    }
  }
  return items.sort((a, b) => b.capture.createdAt.localeCompare(a.capture.createdAt))
}

/** Whole days since an ISO timestamp, never negative; null for a broken value. */
export function daysSince(iso: string, nowMs: number): number | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000))
}
