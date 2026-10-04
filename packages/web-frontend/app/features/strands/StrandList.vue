<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import type { Thread, Project } from '@axiom/core'
import { SEARCH_MAX_LENGTH, filterQuery, highlightParts, normalizeSearch, readFilters, useStrandPagination, type StrandRow } from './pagination'
import StrandActions from './StrandActions.vue'
import MessageSearchResults from './MessageSearchResults.vue'
import { parseBackendTimestamp } from '~/utils/datetime'
import { useShellCommands } from '~/composables/useShellCommands'
import {
  STRAND_SORTS, activeFilterCount as countFilters, clearFilters, filterRows, groupRows, mergeOverviewQuery, overviewQueryOf,
  parseOverviewQuery, previewLine, relativeParts, sortRows, type OverviewState, type StrandSort,
} from '~/utils/strandOverview'
import { STRAND_ROW_TRANSITION_NAME } from '~/utils/strandTransition'
/** Turn state of other strands as reported by the chat socket (`sessionActivity`). */
type Activity = Record<string, { state: string } | undefined>
/**
 * `compact` = the 304 px side column next to an open strand; otherwise the
 * full-width overview (W4d) with search, filter chips, sort and time groups.
 * Both read and write the same URL query, so a filter set in the overview
 * stays on in the side column.
 */
const props = withDefaults(defineProps<{ projectId?: string; compact?: boolean; activeId?: string | null; activity?: Activity; liveTasks?: Record<string, number>; morphId?: string | null }>(), {
  projectId: undefined, compact: false, activeId: null, activity: () => ({}), liveTasks: () => ({}), morphId: null,
})
function turnState(id: string): 'running' | 'queued' | null {
  const state = props.activity[id]?.state
  if (state === 'queued') return 'queued'
  return state ? 'running' : null
}
function tasksOf(id: string): number { return props.liveTasks[id] ?? 0 }
function isLive(id: string): boolean { return turnState(id) !== null || tasksOf(id) > 0 }
const emit = defineEmits<{ changed: [] }>()
function changed() { emit('changed'); void pager.reset() }
const route = useRoute()
const router = useRouter()
const { locale } = useI18n()
const { apiFetch } = useApi()
const projects = ref<Project[]>([])
const metadataError = ref(false)
const selected = ref<Thread | null>(null)
const scrollElement = ref<HTMLElement | null>(null)
function manage(strand: Thread) { selected.value = { ...strand }; scrollElement.value?.scrollTo({ top: 0 }) }
/** Server side part of the query (what the list endpoint filters). */
const filters = computed(() => readFilters(route.query, props.projectId))
/** The whole overview state, including the client side chips and the sort. */
const state = computed<OverviewState>(() => ({ ...parseOverviewQuery(route.query), q: filters.value.q, project_id: filters.value.project_id }))
const activeFilterCount = computed(() => countFilters(state.value, !!props.projectId))
const pager = useStrandPagination(async offset => {
  const query = new URLSearchParams({ ...filterQuery(filters.value), limit: '100', offset: String(offset) })
  return (await apiFetch<{ strands: StrandRow[] }>(`/api/strands?${query}`)).strands
})
const { rows, loading, error, ended, truncated } = pager
// A palette action (archive) changed strand data: reload the visible list.
watch(useShellCommands().strandsVersion, () => { void pager.reset() })
const visibleRows = computed(() => filterRows(
  rows.value.filter(row => filters.value.include_archived || !(selected.value?.id === row.id ? selected.value.archived : row.archived)),
  state.value, isLive,
))
// Relative times move on once a minute.
const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | null = null
const groups = computed(() => groupRows(sortRows(visibleRows.value, state.value.sort, locale.value), state.value.sort, now.value, isLive))
// Sorting by title or creation needs every strand, not the first page.
const loadingAll = computed(() => state.value.sort !== 'activity' && !ended.value && !truncated.value && !error.value)
watch([() => state.value.sort, loading, () => rows.value.length], () => {
  if (loadingAll.value && !loading.value) void pager.next()
})
function writeState(next: OverviewState) {
  const query = mergeOverviewQuery(route.query, next)
  if (props.projectId) delete query.project_id
  void router.replace({ query })
}
function setFilter(key: string, value: string | boolean) {
  const query = { ...route.query }
  for (const name of ['project_id', 'tag', 'now', 'include_archived', 'q']) delete query[name]
  Object.assign(query, filterQuery({ ...filters.value, [key]: value }))
  if (props.projectId) delete query.project_id
  void router.replace({ query })
}
type Chip = 'running' | 'pinned' | 'unsorted' | 'archived' | 'now'
function chipOn(chip: Chip): boolean {
  if (chip === 'unsorted') return state.value.project_id === 'none'
  if (chip === 'archived') return state.value.include_archived
  return state.value[chip]
}
function toggleChip(chip: Chip) {
  const on = !chipOn(chip)
  if (chip === 'unsorted') writeState({ ...state.value, project_id: on ? 'none' : '' })
  else if (chip === 'archived') writeState({ ...state.value, include_archived: on })
  else writeState({ ...state.value, [chip]: on })
}
const chips = computed<Chip[]>(() => [
  'running', 'pinned', ...(props.projectId ? [] : ['unsorted' as const]), 'archived', ...(state.value.now ? ['now' as const] : []),
])
function setProject(id: string) { writeState({ ...state.value, project_id: id }) }
function setSort(sort: StrandSort) { if (sort !== state.value.sort) writeState({ ...state.value, sort }) }
function resetFilters() { writeState(clearFilters(state.value)) }
const filtersOpen = ref(false)
function project(id: string | null) { return projects.value.find(p => p.id === id) }
function color(id: string | null) { const value = project(id)?.color; return value && /^#[\da-f]{6}$/i.test(value) ? value : undefined }
function date(value: string) { const parsed = parseBackendTimestamp(value); return parsed ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed) : value }
function relative(value: string) {
  const parts = relativeParts(value, now.value)
  return parts ? new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' }).format(parts.value, parts.unit) : date(value)
}
function preview(strand: StrandRow) { return previewLine(strand.lastMessage?.content) }
/** Strand links carry the overview's query, so filters survive the side column and Back. */
function linkTo(strand: StrandRow) { return { path: `/strands/${encodeURIComponent(strand.id)}`, query: overviewQueryOf(route.query) } }
/** Only one row ever carries the morph name: the open one, or the one that just closed. */
function morphStyle(id: string) {
  const morph = props.compact ? id === props.activeId : id === props.morphId
  return morph ? { viewTransitionName: STRAND_ROW_TRANSITION_NAME } : undefined
}
async function loadProjects() {
  metadataError.value = false
  try { projects.value = (await apiFetch<{ projects: Project[] }>('/api/projects?include_archived=1')).projects }
  catch { metadataError.value = true }
}
function scroll(event: Event) {
  const el = event.target as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && !error.value) void pager.next()
}
// ── Search (`?q=`, title and message content, server side) ──────────
// The field updates the URL 250 ms after the last keystroke. Starting or
// clearing a search pushes a history entry (Back returns to the list before),
// refining it replaces the entry, so Back is not one step per letter.
const searchInput = ref<HTMLInputElement | null>(null)
const searchText = ref(filters.value.q)
const searchActive = computed(() => filters.value.q !== '')
let searchTimer: ReturnType<typeof setTimeout> | null = null
function applySearch(value: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = null
  const q = normalizeSearch(value)
  if (q === filters.value.q) return
  const query = { ...route.query }
  delete query.q
  if (q) query.q = q
  if (props.projectId) delete query.project_id
  const navigate = !q || !filters.value.q ? router.push : router.replace
  void navigate({ query })
}
watch(searchText, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => applySearch(value), 250)
})
// Back/forward or a link changed `q`: the field follows the URL.
watch(() => filters.value.q, (q) => { if (normalizeSearch(searchText.value) !== q) searchText.value = q })
function clearSearch() {
  searchText.value = ''
  applySearch('')
  searchInput.value?.focus()
}
function onSearchKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !searchText.value) return
  event.preventDefault()
  event.stopPropagation()
  clearSearch()
}
// `/` (focus search) and j/k are bound by the page through the central
// shortcut composable (`useShortcuts`), not by a listener of this list.
// Only a real change of the server side filters reloads. Opening a strand
// changes the route too (and `filters` is a fresh object each time); a reload
// then would empty the list mid-transition and refetch for nothing.
watch(() => JSON.stringify(filterQuery(filters.value)), () => { void pager.reset() })
onMounted(() => {
  void pager.reset(); void loadProjects()
  clock = setInterval(() => { now.value = new Date() }, 60_000)
})
onUnmounted(() => {
  pager.dispose()
  if (searchTimer) clearTimeout(searchTimer)
  if (clock) clearInterval(clock)
})
const chipClass = 'inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="$t('strandsW3.title')" :data-mode="compact ? 'side' : 'overview'">
    <div class="shrink-0" :class="compact ? 'border-b px-3 pb-2 pt-3' : 'px-3 pt-2 md:px-6'">
      <div :class="compact ? '' : 'mx-auto w-full max-w-4xl'">
        <div role="search">
          <label for="strand-search" class="mb-1 block text-xs font-medium text-muted-foreground">{{ $t('strandsW3.search') }}</label>
          <div class="relative flex items-center">
            <AppIcon name="search" class="pointer-events-none absolute left-3 text-muted-foreground" />
            <input id="strand-search" ref="searchInput" :value="searchText" data-testid="strand-search" type="search" autocomplete="off" enterkeyhint="search" :maxlength="SEARCH_MAX_LENGTH"
              class="w-full min-w-0 rounded-md border border-input bg-background pl-9 pr-12 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
              :class="compact ? 'min-h-11 text-sm' : 'min-h-12 text-base'"
              :placeholder="compact ? $t('strandsW3.searchPlaceholder') : $t('strandsW4d.searchPlaceholder')" :aria-describedby="'strand-search-hint'" @input="searchText = ($event.target as HTMLInputElement).value" @keydown="onSearchKeydown">
            <button v-if="searchText" type="button" data-testid="strand-search-clear" class="absolute right-0 inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="$t('strandsW3.searchClear')" @click="clearSearch">
              <AppIcon name="close" />
            </button>
          </div>
          <p id="strand-search-hint" class="measure mt-1 text-help text-muted-foreground" :class="compact ? 'sr-only' : ''">{{ $t('strandsW3.searchHint') }}</p>
        </div>
        <button v-if="compact" type="button" data-testid="strand-filters-toggle" class="mt-2 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-expanded="filtersOpen" aria-controls="strand-filter-panel" @click="filtersOpen = !filtersOpen">
          <AppIcon name="filter" size="sm" />{{ $t('strandsW3.filters') }}
          <span v-if="activeFilterCount" class="rounded-full bg-primary px-2 text-xs text-primary-foreground">{{ activeFilterCount }}</span>
          <AppIcon :name="filtersOpen ? 'chevronDown' : 'chevronRight'" size="sm" class="ml-auto" />
        </button>
        <div v-show="!compact || filtersOpen" id="strand-filter-panel" data-testid="strand-filters" class="flex flex-col gap-2" :class="compact ? 'pt-2' : 'pb-1 pt-3'">
          <div role="group" :aria-label="$t('strandsW4d.chips')" class="flex min-w-0 flex-wrap items-center gap-2">
            <button v-for="chip in chips" :key="chip" type="button" :data-testid="`strand-chip-${chip}`" :aria-pressed="chipOn(chip)"
              :class="[chipClass, chipOn(chip) ? 'border-primary bg-selected-container text-on-selected-container' : 'border-border text-foreground hover:bg-accent']"
              @click="toggleChip(chip)">
              <AppIcon v-if="chipOn(chip)" name="check" size="sm" />{{ $t(`strandsW4d.chip.${chip}`) }}
            </button>
            <label v-if="!projectId" class="relative inline-flex min-w-0 max-w-full">
              <span class="sr-only">{{ $t('strandsW4d.projectChip') }}</span>
              <select data-testid="project-filter" :class="[chipClass, 'max-w-full min-w-0 appearance-none truncate pr-8', state.project_id && state.project_id !== 'none' ? 'border-primary bg-selected-container text-on-selected-container' : 'border-input bg-background text-foreground hover:bg-accent']"
                :value="state.project_id === 'none' ? '' : state.project_id" @change="setProject(($event.target as HTMLSelectElement).value)">
                <option value="">{{ $t('strandsW4d.allProjects') }}</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
              <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center" aria-hidden="true"><AppIcon name="chevronDown" size="sm" /></span>
            </label>
            <label class="inline-flex min-w-0">
              <span class="sr-only">{{ $t('strandsW3.tag') }}</span>
              <input data-testid="tag-filter" :class="[chipClass, 'w-28 min-w-0 bg-background placeholder:text-muted-foreground', state.tag ? 'border-primary' : 'border-input']" :placeholder="$t('strandsW4d.tagPlaceholder')"
                :value="filters.tag" @change="setFilter('tag', ($event.target as HTMLInputElement).value.trim())">
            </label>
            <button v-if="activeFilterCount" type="button" data-testid="strand-filters-clear" class="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="resetFilters">
              {{ $t('strandsW4d.clearFilters') }}
            </button>
          </div>
          <div role="group" :aria-label="$t('strandsW4d.sort')" data-testid="strand-sort" class="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span class="text-muted-foreground" aria-hidden="true">{{ $t('strandsW4d.sort') }}</span>
            <div class="inline-flex min-w-0 rounded-md border border-border">
              <button v-for="sort in STRAND_SORTS" :key="sort" type="button" :data-testid="`strand-sort-${sort}`" :aria-pressed="state.sort === sort"
                class="min-h-11 rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :class="state.sort === sort ? 'bg-selected-container font-semibold text-on-selected-container' : 'text-muted-foreground hover:text-foreground'"
                @click="setSort(sort)">{{ $t(`strandsW4d.sortBy.${sort}`) }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div ref="scrollElement" data-testid="strand-scroll" class="min-h-0 flex-1 overflow-y-auto" :class="compact ? 'p-2 pb-6' : 'px-3 pb-24 pt-2 md:px-6'" @scroll="scroll">
      <div class="flex flex-col" :class="compact ? 'gap-1' : 'mx-auto w-full max-w-4xl gap-1'" data-testid="strand-rows">
        <div v-if="metadataError" role="alert" class="rounded-md border p-3">{{ $t('strandsW3.projectsError') }} <Button variant="outline" class="min-h-11 min-w-11" @click="loadProjects">{{ $t('common.retry') }}</Button></div>
        <section v-if="selected" class="rounded-xl border bg-card p-3" :aria-label="$t('strandsW3.manage')">
          <div class="flex items-center justify-between gap-2"><h2 class="min-w-0 break-words font-semibold">{{ selected.title || $t('strandsW3.untitled') }}</h2><Button variant="ghost" class="min-h-11 min-w-11" @click="selected = null">{{ $t('common.close') }}</Button></div>
          <StrandActions :key="selected.id" :strand-id="selected.id" v-model:archived="selected.archived" @changed="changed" @deleted="selected = null; changed()" />
        </section>
        <p v-if="loading" role="status" aria-busy="true" :class="rows.length ? 'text-sm text-muted-foreground' : 'sr-only'">{{ loadingAll ? $t('strandsW4d.loadingAll') : $t('common.loading') }}</p>
        <div v-if="loading && !rows.length" data-testid="strand-skeleton" class="flex flex-col gap-1" aria-hidden="true">
          <div v-for="n in 4" :key="n" class="rounded-lg px-3 py-3">
            <div class="h-5 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
            <div class="mt-2 h-4 w-5/6 rounded bg-muted motion-safe:animate-pulse" />
          </div>
        </div>
        <div v-if="error" role="alert" class="rounded-md border p-3">{{ $t('strandsW3.error') }} <Button class="min-h-11 min-w-11" @click="pager.next">{{ $t('common.retry') }}</Button></div>
        <div v-if="!loading && !error && !rows.length && searchActive" data-testid="strand-search-empty" class="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
          <p class="break-words [overflow-wrap:anywhere]">{{ $t('strandsW3.searchEmpty', { q: filters.q }) }}</p>
          <Button variant="outline" class="min-h-11 min-w-11" @click="clearSearch">{{ $t('strandsW3.searchReset') }}</Button>
        </div>
        <div v-else-if="!loading && !error && !visibleRows.length && (activeFilterCount || rows.length)" data-testid="strand-empty" class="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
          <p>{{ $t('strandsW3.empty') }}</p>
          <Button v-if="activeFilterCount" variant="outline" class="min-h-11 min-w-11" @click="resetFilters">{{ $t('strandsW4d.clearFilters') }}</Button>
        </div>
        <p v-else-if="!loading && !error && !rows.length" data-testid="strand-none" class="py-12 text-center text-muted-foreground">{{ $t('strandsW4d.noStrands') }}</p>
        <template v-for="group in groups" :key="group.key">
          <h2 class="text-sm font-semibold text-muted-foreground" :class="compact ? 'px-3 pt-2' : 'px-3 pb-1 pt-4'" :data-testid="`strand-group-${group.key}`">{{ $t(`strandsW4d.group.${group.key}`) }}</h2>
          <template v-if="compact">
            <article v-for="strand in group.rows" :key="strand.id" data-testid="strand-row" :data-strand-id="strand.id" :data-active="strand.id === activeId ? 'true' : undefined"
              class="relative flex min-w-0 items-start rounded-lg" :style="morphStyle(strand.id)"
              :class="strand.id === activeId ? 'bg-selected-container text-on-selected-container selected-marker' : 'hover:bg-accent'">
              <NuxtLink :to="linkTo(strand)" data-testid="strand-row-link" :aria-current="strand.id === activeId ? 'page' : undefined"
                class="flex min-h-11 min-w-0 flex-1 flex-col gap-1 rounded-lg py-2 pl-3 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                :class="strand.id === activeId ? 'text-on-selected-container' : 'text-foreground'">
                <span class="flex min-w-0 items-start gap-2">
                  <span v-if="turnState(strand.id)" data-testid="strand-status" class="mt-2 h-2 w-2 shrink-0 rounded-full" :class="turnState(strand.id) === 'running' ? 'bg-primary motion-safe:animate-pulse' : 'border border-current'" aria-hidden="true" />
                  <span class="line-clamp-2 min-w-0 break-words text-sm font-semibold [overflow-wrap:anywhere]"><template v-for="(part, i) in highlightParts(strand.title || $t('strandsW3.untitled'), filters.q)" :key="i"><mark v-if="part.match" class="rounded-sm bg-primary-subtle-hover px-1 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
                </span>
                <span v-if="searchActive && strand.matchSnippet" data-testid="strand-snippet" class="line-clamp-2 break-words text-xs [overflow-wrap:anywhere]" :class="strand.id === activeId ? '' : 'text-muted-foreground'"><template v-for="(part, i) in highlightParts(strand.matchSnippet, filters.q)" :key="i"><mark v-if="part.match" class="rounded-sm bg-primary-subtle-hover px-1 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
                <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" :class="strand.id === activeId ? '' : 'text-muted-foreground'">
                  <span v-if="turnState(strand.id)" class="font-semibold">{{ $t(`strandsW3.state.${turnState(strand.id)}`) }}</span>
                  <span v-if="strand.nowRank != null">{{ $t('strandsW3.now') }} {{ strand.nowRank }}</span>
                  <span v-if="strand.projectId" class="inline-flex min-w-0 max-w-full items-center gap-1"><span class="h-2 w-2 shrink-0 rounded-full bg-primary" :style="{ backgroundColor: color(strand.projectId) }" /><span class="truncate">{{ project(strand.projectId)?.name || $t('strandsW3.project') }}</span></span>
                  <span v-if="strand.archived">{{ $t('strandsW3.archived') }}</span>
                  <time :datetime="strand.lastActivity" :title="date(strand.lastActivity)">{{ relative(strand.lastActivity) }}</time>
                </span>
              </NuxtLink>
              <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :class="strand.id === activeId ? '' : 'text-muted-foreground hover:text-foreground'" :aria-label="`${$t('strandsW3.manage')}: ${strand.title || $t('strandsW3.untitled')}`" @click="manage(strand)">
                <AppIcon name="moreVertical" size="sm" />
              </button>
            </article>
          </template>
          <template v-else>
            <article v-for="strand in group.rows" :key="strand.id" data-testid="strand-row" :data-strand-id="strand.id" :data-live="isLive(strand.id) ? 'true' : undefined"
              class="relative flex min-w-0 items-start rounded-lg hover:bg-accent" :style="morphStyle(strand.id)">
              <NuxtLink :to="linkTo(strand)" data-testid="strand-row-link"
                class="flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-lg py-2 pl-3 pr-1 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <span class="mt-2 flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden="true">
                  <span v-if="isLive(strand.id)" data-testid="strand-status" class="h-2.5 w-2.5 rounded-full" :class="turnState(strand.id) === 'queued' && !tasksOf(strand.id) ? 'border-2 border-primary' : 'bg-primary motion-safe:animate-pulse'" />
                  <AppIcon v-else-if="strand.pinned" name="pin" size="sm" class="text-muted-foreground" />
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="flex min-w-0 items-baseline gap-3">
                    <span class="min-w-0 flex-1 truncate text-base font-semibold"><template v-for="(part, i) in highlightParts(strand.title || $t('strandsW3.untitled'), filters.q)" :key="i"><mark v-if="part.match" class="rounded-sm bg-primary-subtle-hover px-1 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
                    <time class="shrink-0 text-xs tabular-nums text-muted-foreground" :datetime="strand.lastActivity" :title="date(strand.lastActivity)">{{ relative(strand.lastActivity) }}</time>
                  </span>
                  <span v-if="searchActive && strand.matchSnippet" data-testid="strand-snippet" class="truncate text-sm text-muted-foreground"><template v-for="(part, i) in highlightParts(strand.matchSnippet, filters.q)" :key="i"><mark v-if="part.match" class="rounded-sm bg-primary-subtle-hover px-1 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
                  <span v-else data-testid="strand-preview" class="truncate text-sm text-muted-foreground"><template v-if="preview(strand)"><span v-if="strand.lastMessage?.role === 'user'">{{ $t('strandsW4d.you') }} </span>{{ preview(strand) }}</template><template v-else>{{ $t('strandsW4d.noPreview') }}</template></span>
                  <span class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span v-if="turnState(strand.id)" class="font-semibold text-primary">{{ turnState(strand.id) === 'running' ? $t('strandsW4d.turnRunning') : $t('strandsW4d.turnQueued') }}</span>
                    <span v-if="tasksOf(strand.id)" class="font-semibold text-primary">{{ $t('strandsW4d.tasksRunning', tasksOf(strand.id)) }}</span>
                    <span v-if="strand.projectId" class="inline-flex min-w-0 max-w-full items-center gap-1"><span class="h-2 w-2 shrink-0 rounded-full bg-primary" :style="{ backgroundColor: color(strand.projectId) }" /><span class="truncate">{{ project(strand.projectId)?.name || $t('strandsW3.project') }}</span></span>
                    <span v-if="strand.pinned" class="sr-only">{{ $t('strandsW4d.pinnedLabel') }}</span>
                    <span v-if="strand.nowRank != null">{{ $t('strandsW3.now') }} {{ strand.nowRank }}</span>
                    <span v-for="tag in strand.tags" :key="tag" class="max-w-full truncate">#{{ tag }}</span>
                    <span v-if="strand.archived">{{ $t('strandsW3.archived') }}</span>
                    <span>{{ $t('strandsW3.messages', { count: strand.messageCount }) }}</span>
                  </span>
                </span>
              </NuxtLink>
              <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="`${$t('strandsW3.manage')}: ${strand.title || $t('strandsW3.untitled')}`" @click="manage(strand)">
                <AppIcon name="moreVertical" size="sm" />
              </button>
            </article>
          </template>
        </template>
        <MessageSearchResults v-if="searchActive" :query="filters.q" :limit="compact ? 8 : 20" />
        <p v-if="(state.running || state.pinned) && !ended" class="measure px-3 pt-2 text-help text-muted-foreground">{{ $t('strandsW4d.clientFilterHint') }}</p>
        <p data-testid="loaded-count" role="status" :class="compact ? 'px-3 pt-2 text-xs text-muted-foreground' : 'px-3 pt-4 text-xs text-muted-foreground'">{{ $t('strandsW3.loaded', { count: rows.length }) }}</p>
        <p v-if="truncated" role="status" class="rounded-md border p-3">{{ $t('strandsW3.truncated') }}</p>
        <Button v-if="!ended && !truncated" variant="outline" class="min-h-11 min-w-11" :disabled="loading" @click="pager.next">{{ $t('strandsW3.loadMore') }}</Button>
      </div>
    </div>
  </section>
</template>
