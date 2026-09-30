<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import type { Thread, Project } from '@axiom/core'
import { filterQuery, readFilters, useStrandPagination } from './pagination'
import StrandActions from './StrandActions.vue'
import { parseBackendTimestamp } from '~/utils/datetime'
const props = defineProps<{ projectId?: string }>()
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
const filters = computed(() => readFilters(route.query, props.projectId))
const pager = useStrandPagination(async offset => {
  const query = new URLSearchParams({ ...filterQuery(filters.value), limit: '100', offset: String(offset) })
  return (await apiFetch<{ strands: Thread[] }>(`/api/strands?${query}`)).strands
})
const { rows, loading, error, ended, truncated } = pager
const visibleRows = computed(() => rows.value.filter(row => filters.value.include_archived || !(selected.value?.id === row.id ? selected.value.archived : row.archived)))
const groups = computed(() => [
  { key: 'pinned', rows: visibleRows.value.filter(row => row.pinned) },
  { key: 'recent', rows: visibleRows.value.filter(row => !row.pinned) },
].filter(group => group.rows.length))
function setFilter(key: string, value: string | boolean) {
  const query = { ...route.query }
  for (const name of ['project_id', 'tag', 'now', 'include_archived']) delete query[name]
  Object.assign(query, filterQuery({ ...filters.value, [key]: value }))
  if (props.projectId) delete query.project_id
  void router.replace({ query })
}
function project(id: string | null) { return projects.value.find(p => p.id === id) }
function color(id: string | null) { const value = project(id)?.color; return value && /^#[\da-f]{6}$/i.test(value) ? value : undefined }
function date(value: string) { const parsed = parseBackendTimestamp(value); return parsed ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(parsed) : value }
async function loadProjects() {
  metadataError.value = false
  try { projects.value = (await apiFetch<{ projects: Project[] }>('/api/projects?include_archived=1')).projects }
  catch { metadataError.value = true }
}
function scroll(event: Event) {
  const el = event.target as HTMLElement
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 400 && !error.value) void pager.next()
}
watch(filters, () => { void pager.reset() }, { deep: true })
onMounted(() => { void pager.reset(); void loadProjects() })
onUnmounted(pager.dispose)
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="$t('strandsW3.title')">
    <form class="grid shrink-0 grid-cols-2 gap-2 border-b p-3 md:grid-cols-4" @submit.prevent>
      <label v-if="!projectId" class="min-w-0 text-sm">{{ $t('strandsW3.project') }}
        <select data-testid="project-filter" :aria-label="$t('strandsW3.project')" class="mt-1 min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :value="filters.project_id" @change="setFilter('project_id', ($event.target as HTMLSelectElement).value)">
          <option value="">{{ $t('strandsW3.allProjects') }}</option><option value="none">{{ $t('strandsW3.noProject') }}</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <label class="min-w-0 text-sm">{{ $t('strandsW3.tag') }}
        <input data-testid="tag-filter" class="mt-1 min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :value="filters.tag" @change="setFilter('tag', ($event.target as HTMLInputElement).value.trim())">
      </label>
      <label class="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" :checked="filters.now" @change="setFilter('now', ($event.target as HTMLInputElement).checked)">{{ $t('strandsW3.nowOnly') }}</label>
      <label class="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" :checked="filters.include_archived" @change="setFilter('include_archived', ($event.target as HTMLInputElement).checked)">{{ $t('strandsW3.includeArchived') }}</label>
    </form>
    <div ref="scrollElement" data-testid="strand-scroll" class="min-h-0 flex-1 overflow-y-auto p-3 pb-24 md:p-6" @scroll="scroll">
      <div class="mx-auto flex max-w-4xl flex-col gap-3">
        <div v-if="metadataError" role="alert" class="rounded-md border p-3">{{ $t('strandsW3.projectsError') }} <Button variant="outline" class="min-h-11 min-w-11" @click="loadProjects">{{ $t('common.retry') }}</Button></div>
        <section v-if="selected" class="rounded-xl border bg-card p-3" :aria-label="$t('strandsW3.manage')">
          <div class="flex items-center justify-between gap-2"><h2 class="min-w-0 break-words font-semibold">{{ selected.title || $t('strandsW3.untitled') }}</h2><Button variant="ghost" class="min-h-11 min-w-11" @click="selected = null">{{ $t('common.close') }}</Button></div>
          <StrandActions :key="selected.id" :strand-id="selected.id" v-model:archived="selected.archived" @changed="changed" @deleted="selected = null; changed()" />
        </section>
        <p v-if="loading" role="status" aria-busy="true">{{ $t('common.loading') }}</p>
        <div v-if="error" role="alert" class="rounded-md border p-3">{{ $t('strandsW3.error') }} <Button class="min-h-11 min-w-11" @click="pager.next">{{ $t('common.retry') }}</Button></div>
        <p v-if="!loading && !error && !rows.length" data-testid="strand-empty" class="py-12 text-center text-muted-foreground">{{ $t('strandsW3.empty') }}</p>
        <template v-for="group in groups" :key="group.key">
          <h2 class="text-sm font-semibold text-muted-foreground">{{ $t(`strandsW3.${group.key}`) }}</h2>
          <article v-for="strand in group.rows" :key="strand.id" data-testid="strand-row" :data-strand-id="strand.id" class="min-w-0 rounded-xl border bg-card p-3">
            <NuxtLink :to="`/strands/${encodeURIComponent(strand.id)}`" class="flex min-h-11 min-w-11 items-center break-words rounded-md font-semibold [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ strand.title || $t('strandsW3.untitled') }}</NuxtLink>
            <div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span v-if="strand.projectId" class="inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1 break-all"><span class="h-3 w-3 shrink-0 rounded-full bg-primary" :style="{ backgroundColor: color(strand.projectId) }" />{{ project(strand.projectId)?.name || $t('strandsW3.project') }}</span>
              <span v-for="tag in strand.tags" :key="tag" class="max-w-full break-all rounded-md bg-muted px-2 py-1">#{{ tag }}</span>
              <span v-if="strand.nowRank != null" class="rounded-md bg-primary px-2 py-1 text-primary-foreground">{{ $t('strandsW3.now') }} {{ strand.nowRank }}</span>
              <span v-if="strand.archived">{{ $t('strandsW3.archived') }}</span>
            </div>
            <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><time :datetime="strand.lastActivity">{{ date(strand.lastActivity) }}</time><span class="break-all">{{ strand.agentId }}</span><span>{{ $t('strandsW3.messages', { count: strand.messageCount }) }}</span></div>
          <Button variant="ghost" class="mt-2 min-h-11 min-w-11" @click="manage(strand)">{{ $t('strandsW3.manage') }}</Button>
          </article>
        </template>
        <p data-testid="loaded-count" role="status">{{ $t('strandsW3.loaded', { count: rows.length }) }}</p>
        <p v-if="truncated" role="status" class="rounded-md border p-3">{{ $t('strandsW3.truncated') }}</p>
        <Button v-if="!ended && !truncated" variant="outline" class="min-h-11 min-w-11" :disabled="loading" @click="pager.next">{{ $t('strandsW3.loadMore') }}</Button>
      </div>
    </div>
  </section>
</template>
