import { computed, ref } from 'vue'
import type { Thread } from '@axiom/core'
export interface StrandFilters { project_id: string; tag: string; now: boolean; include_archived: boolean; q: string }
/** Search bounds of `GET /api/strands?q=` (the backend answers 400 outside them). */
export const SEARCH_MIN_LENGTH = 2
export const SEARCH_MAX_LENGTH = 200
/** A strand row of a search: found through a message it carries a plain-text excerpt. */
export type StrandRow = Thread & { matchSnippet?: string }
/** The search text that is really sent: trimmed, cut at 200, empty below 2 characters. */
export function normalizeSearch(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().slice(0, SEARCH_MAX_LENGTH).trim()
  return trimmed.length >= SEARCH_MIN_LENGTH ? trimmed : ''
}
export function readFilters(query: Record<string, unknown>, projectId?: string): StrandFilters {
  const str = (key: string) => typeof query[key] === 'string' ? query[key] as string : ''
  const flag = (key: string) => ['1', 'true', 'yes'].includes(str(key).toLowerCase())
  return { project_id: projectId ?? str('project_id'), tag: str('tag'), now: flag('now'), include_archived: flag('include_archived'), q: normalizeSearch(str('q')) }
}
export function filterQuery(filters: StrandFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).flatMap(([key, value]) => value ? [[key, value === true ? '1' : String(value)]] : []))
}
/**
 * Split `text` into plain and matching parts for the search highlight. Every
 * whitespace separated word of `query` matches case-insensitively (the backend
 * treats each word as a prefix term). The parts are rendered as text nodes and
 * `<mark>`, never as HTML, so the strand text cannot inject markup.
 */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  if (!text) return []
  const words = [...new Set(query.trim().split(/\s+/).filter(word => word.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return [{ text, match: false }]
  // With one capturing group, `split` puts the matches at the odd indexes.
  const pattern = new RegExp(`(${words.join('|')})`, 'iu')
  return text.split(pattern)
    .map((part, index) => ({ text: part, match: index % 2 === 1 }))
    .filter(part => part.text.length > 0)
}
export function useStrandPagination(fetchPage: (offset: number) => Promise<StrandRow[]>, maxPages = 30) {
  const rows = ref<StrandRow[]>([])
  const loading = ref(false)
  const error = ref(false)
  const ended = ref(false)
  const pages = ref(0)
  const truncated = computed(() => !ended.value && pages.value >= maxPages)
  let generation = 0
  let offset = 0
  async function next() {
    if (loading.value || ended.value || truncated.value) return
    const request = generation
    loading.value = true
    error.value = false
    try {
      const page = await fetchPage(offset)
      if (request !== generation) return
      const ids = new Set(rows.value.map(row => row.id))
      rows.value.push(...page.filter(row => !ids.has(row.id)))
      offset += page.length
      pages.value++
      ended.value = page.length < 100
    } catch { if (request === generation) error.value = true }
    finally { if (request === generation) loading.value = false }
  }
  function reset() {
    generation++
    rows.value = []; offset = 0; pages.value = 0; ended.value = false; loading.value = false; error.value = false
    return next()
  }
  function dispose() { generation++ }
  return { rows, loading, error, ended, truncated, next, reset, dispose }
}
