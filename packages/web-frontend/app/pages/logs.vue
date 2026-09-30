<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('logs.title')" :subtitle="$t('logs.subtitle')">
      <template #actions>
        <!-- Live / Historical toggle -->
        <Button
          :variant="liveMode ? 'default' : 'outline'"
          size="sm"
          class="gap-1.5"
          @click="toggleLiveMode"
        >
          <span
            class="h-2 w-2 rounded-full"
            :class="liveMode ? 'bg-primary-foreground' : 'bg-muted-foreground'"
            :style="liveMode && !paused ? 'animation: pulse-dot 1.5s ease-in-out infinite' : ''"
          />
          {{ liveMode ? $t('logs.live') : $t('logs.historical') }}
        </Button>

        <!-- Pause / Resume (live mode only) -->
        <Button
          v-if="liveMode"
          :variant="paused ? 'outline' : 'ghost'"
          size="sm"
          :class="paused ? 'border-warning text-warning' : ''"
          @click="togglePause()"
        >
          {{ paused ? $t('logs.resume') : $t('logs.pause') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Filter toolbar -->
    <LogFilterToolbar
      v-model:search="searchQuery"
      v-model:session-type="selectedSessionType"
      v-model:tool-name="selectedToolName"
      v-model:date-from="dateFrom"
      v-model:date-to="dateTo"
      :tool-names="toolNames"
      @search="debouncedSearch"
      @apply="applyFilters"
    />

    <!-- Loading state -->
    <div
      v-if="loading && logs.length === 0"
      class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
    >
      {{ $t('logs.loading') }}
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!loading && logs.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-muted-foreground"
    >
      <AppIcon name="logs" size="xl" class="opacity-40" />
      <p class="text-sm">{{ $t('logs.noEntries') }}</p>
    </div>

    <!-- Log entries -->
    <div v-else ref="logsListRef" class="flex-1 overflow-y-auto">
      <div
        v-for="entry in logs"
        :key="entry.id"
        class="cursor-pointer border-b border-border transition-colors hover:bg-muted/40"
        :class="{
          'border-l-2 border-l-destructive': entry.status === 'error',
          'bg-muted/20': expandedId === entry.id,
        }"
      >
        <LogEntryRow
          :entry="entry"
          :expanded="expandedId === entry.id"
          @toggle="toggleExpand(entry.id)"
        />

        <LogEntryDetail
          v-if="expandedId === entry.id"
          :entry="expandedDetail"
          :loading="detailLoading"
        />
      </div>
    </div>

    <!-- Pagination (historical mode only) -->
    <div
      v-if="!liveMode && pagination.totalPages > 1"
      class="flex flex-shrink-0 items-center justify-center gap-4 border-t border-border px-5 py-3"
    >
      <Button
        variant="outline"
        size="sm"
        :disabled="pagination.page <= 1"
        class="gap-1"
        @click="goToPage(pagination.page - 1)"
      >
        <AppIcon name="arrowLeft" class="h-4 w-4" />
        {{ $t('logs.prev') }}
      </Button>

      <span class="text-sm text-muted-foreground">
        {{ $t('logs.pageInfo', { page: pagination.page, total: pagination.totalPages }) }}
      </span>

      <Button
        variant="outline"
        size="sm"
        :disabled="pagination.page >= pagination.totalPages"
        class="gap-1"
        @click="goToPage(pagination.page + 1)"
      >
        {{ $t('logs.next') }}
        <AppIcon name="arrowRight" class="h-4 w-4" />
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { LogEntry } from '~/composables/useLogs'

const {
  logs,
  pagination,
  toolNames,
  loading,
  liveMode,
  paused,
  fetchLogs,
  fetchLogDetail,
  fetchToolNames,
  connectLive,
  disconnectLive,
  togglePause,
  setLiveMode,
} = useLogs()

const searchQuery = ref('')
const selectedToolName = ref('')
const selectedSessionType = ref<'main' | 'task' | ''>('')
const dateFrom = ref('')
const dateTo = ref('')
const expandedId = ref<number | null>(null)
const expandedDetail = ref<LogEntry | null>(null)
const detailLoading = ref(false)
const logsListRef = ref<HTMLElement | null>(null)

let searchTimeout: ReturnType<typeof setTimeout> | null = null

function debouncedSearch() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => applyFilters(), 300)
}

async function applyFilters() {
  if (liveMode.value) {
    setLiveMode(false)
  }
  await fetchLogs({
    page: 1,
    search: searchQuery.value || undefined,
    toolName: selectedToolName.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
    sessionType: selectedSessionType.value || undefined,
  })
}

function toggleLiveMode() {
  if (liveMode.value) {
    setLiveMode(false)
    fetchLogs()
  } else {
    setLiveMode(true)
    fetchLogs()
  }
}

async function toggleExpand(id: number) {
  if (expandedId.value === id) {
    expandedId.value = null
    expandedDetail.value = null
    return
  }
  expandedId.value = id
  expandedDetail.value = null
  detailLoading.value = true
  try {
    expandedDetail.value = await fetchLogDetail(id)
  } finally {
    detailLoading.value = false
  }
}

function goToPage(page: number) {
  fetchLogs({
    page,
    search: searchQuery.value || undefined,
    toolName: selectedToolName.value || undefined,
    dateFrom: dateFrom.value || undefined,
    dateTo: dateTo.value || undefined,
    sessionType: selectedSessionType.value || undefined,
  })
}

onMounted(async () => {
  await fetchToolNames()
  await fetchLogs()
  if (liveMode.value) {
    connectLive()
  }
})

onUnmounted(() => {
  disconnectLive()
})
</script>
