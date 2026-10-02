/**
 * Navigation badge of the unsorted tray: exact `total` when the backend sends
 * it, the previous "n+" behaviour otherwise. Synthetic pages only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { useUnsortedCount } from './useUnsortedCount'

const globals = globalThis as unknown as Record<string, unknown>
let pages: Record<string, { captures: unknown[]; decisions: unknown[]; total?: number }>
const capture = (id: string) => ({ id, text: 'Synthetic', createdAt: '2026-01-01T10:00:00Z', status: 'unsorted', strandId: null, attachments: [] })
const decision = (captureId: string) => ({ id: `d-${captureId}`, captureId, createdAt: '2026-01-01T10:00:01Z', state: 'proposed', action: 'new_strand', alternatives: [] })

beforeEach(() => {
  pages = {}
  const states = new Map<string, Ref<unknown>>()
  globals.useState = <T>(key: string, init: () => T): Ref<T> => {
    if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
    return states.get(key) as Ref<T>
  }
  globals.computed = computed
  globals.useApi = () => ({
    apiFetch: async (path: string) => {
      const status = new URL(`https://x${path}`).searchParams.get('status')!
      return pages[status] ?? { captures: [], decisions: [] }
    },
  })
})
afterEach(() => {
  delete globals.useState
  delete globals.computed
  delete globals.useApi
})

describe('useUnsortedCount', () => {
  it('uses the summed totals of the tray statuses', async () => {
    const many = Array.from({ length: 50 }, (_, i) => capture(`c${i}`))
    pages = { unsorted: { captures: many, decisions: many.map(c => decision(c.id)), total: 120 }, needs_review: { captures: [], decisions: [], total: 3 }, failed: { captures: [], decisions: [], total: 0 } }
    const badge = useUnsortedCount()
    await badge.refresh()
    expect(badge.count.value).toBe(123)
    expect(badge.label.value).toBe('123')
  })

  it('keeps "n+" when the backend sends no total', async () => {
    const many = Array.from({ length: 50 }, (_, i) => capture(`c${i}`))
    pages = { unsorted: { captures: many, decisions: many.map(c => decision(c.id)) } }
    const badge = useUnsortedCount()
    await badge.refresh()
    expect(badge.label.value).toBe('50+')
  })
})
