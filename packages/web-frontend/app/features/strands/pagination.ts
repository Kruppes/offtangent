import { computed, ref } from 'vue'
import type { Thread } from '@axiom/core'
export interface StrandFilters { project_id: string; tag: string; now: boolean; include_archived: boolean }
export function readFilters(query: Record<string, unknown>, projectId?: string): StrandFilters {
  const str = (key: string) => typeof query[key] === 'string' ? query[key] as string : ''
  const flag = (key: string) => ['1', 'true', 'yes'].includes(str(key).toLowerCase())
  return { project_id: projectId ?? str('project_id'), tag: str('tag'), now: flag('now'), include_archived: flag('include_archived') }
}
export function filterQuery(filters: StrandFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).flatMap(([key, value]) => value ? [[key, value === true ? '1' : String(value)]] : []))
}
export function useStrandPagination(fetchPage: (offset: number) => Promise<Thread[]>, maxPages = 30) {
  const rows = ref<Thread[]>([])
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
