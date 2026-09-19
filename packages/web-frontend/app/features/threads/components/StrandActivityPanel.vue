<template>
  <!--
    "What is working for this strand right now" (SPEC 10.x).

    A strand in which something runs must never look dead: the running turn
    and every delegated task — including sub-tasks, recursively — are listed
    here with a status dot and a counter that keeps ticking. The counter is
    the anti-freeze signal: as long as it moves, the user knows the system is
    alive even when no text streams.
  -->
  <section
    v-if="visible"
    class="border-t border-border bg-muted/20 px-3 py-2"
    :aria-label="$t('strandActivity.title')"
  >
    <button
      type="button"
      class="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:py-1"
      :aria-expanded="open"
      aria-controls="strand-activity-body"
      @click="open = !open"
    >
      <AppIcon :name="open ? 'chevronDown' : 'chevronRight'" class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ $t('strandActivity.title') }}
      </span>
      <span
        v-if="headline"
        class="min-w-0 flex-1 truncate text-xs text-muted-foreground"
      >{{ headline }}</span>
      <span v-else class="flex-1" />
      <span
        v-if="turnRunning"
        class="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
      >{{ $t('strandActivity.turnRunning') }}</span>
    </button>

    <div v-if="open" id="strand-activity-body" class="mt-1">
      <!-- Loading -->
      <div v-if="status === 'loading'" class="flex flex-col gap-1 px-2 py-1">
        <Skeleton class="h-4 w-40 rounded-md" />
        <Skeleton class="h-4 w-28 rounded-md" />
      </div>

      <!-- Error -->
      <div v-else-if="status === 'error'" class="flex flex-wrap items-center gap-2 px-2 py-1">
        <AppIcon name="warning" class="h-4 w-4 shrink-0 text-destructive/70" />
        <p class="min-w-0 flex-1 text-xs text-muted-foreground">{{ $t('strandActivity.errorDescription') }}</p>
        <Button variant="outline" size="sm" class="min-h-[44px] gap-2" @click="reload()">
          <AppIcon name="refresh" class="h-3.5 w-3.5" />
          {{ $t('common.refresh') }}
        </Button>
      </div>

      <!-- Empty: calm, not alarming -->
      <p v-else-if="visibleRows.length === 0" class="px-2 py-1 text-xs text-muted-foreground">
        {{ turnRunning ? $t('strandActivity.emptyWhileTurn') : $t('strandActivity.empty') }}
      </p>

      <!-- Success -->
      <div v-else class="flex flex-col gap-0.5">
        <StrandActivityRow
          v-for="row in visibleRows"
          :key="row.id"
          :row="row"
          :metadata="metadata[row.id]"
          :expanded="isExpanded(row.id)"
          :now-ms="nowMs"
          :reduced-motion="reducedMotion"
          @toggle="toggle"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTasksApi } from '../../../api/tasks'
import { createTaskMetadataCache, type TaskMetadata } from '../taskMetadata'
import { useStrandTasks } from '../composables/useStrandTasks'
import StrandActivityRow from './StrandActivityRow.vue'

const props = defineProps<{
  /** The strand whose activity is shown. Null = legacy chat without a thread. */
  strandId: string | null
  /** True while a turn streams in this strand. */
  turnRunning?: boolean
}>()

const { t } = useI18n()

const {
  status,
  visibleRows,
  liveCount,
  totalCount,
  nowMs,
  reload,
  toggle,
  isExpanded,
} = useStrandTasks(() => props.strandId)

// Metadata is intentionally separate: a stale detail response must never replace
// token/cost/status values supplied by the strand's live frames.
const metadata = ref<Record<string, TaskMetadata | null>>({})
let stopMetadataWatch: (() => void) | undefined
let disposed = false
onMounted(() => {
  const cache = createTaskMetadataCache(useTasksApi().getTask)
  stopMetadataWatch = watch(() => visibleRows.value.map(row => row.id), ids => {
    for (const id of ids) {
      if (id in metadata.value) continue
      metadata.value[id] = null
      void cache(id).then(value => { if (!disposed) metadata.value[id] = value })
    }
  }, { immediate: true })
})
onBeforeUnmount(() => { disposed = true; stopMetadataWatch?.() })

const open = ref(true)

/**
 * The panel hides itself only when there is genuinely nothing to say: no
 * tasks at all and no turn running. It stays visible during loading and on
 * error, so a failure is never silently equivalent to "nothing runs".
 */
const visible = computed(() =>
  Boolean(props.strandId) && (props.turnRunning || totalCount.value > 0 || status.value === 'error' || status.value === 'loading'),
)

const headline = computed(() => {
  if (liveCount.value > 0) return t('strandActivity.liveCount', { count: liveCount.value })
  if (totalCount.value > 0) return t('strandActivity.doneCount', { count: totalCount.value })
  return ''
})

/** `prefers-reduced-motion`: no pulse, but the counter keeps running. */
const reducedMotion = ref(false)
let media: MediaQueryList | null = null
function syncMotion(): void {
  reducedMotion.value = media?.matches ?? false
}
onMounted(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return
  media = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  media.addEventListener('change', syncMotion)
})
onBeforeUnmount(() => media?.removeEventListener('change', syncMotion))
</script>
