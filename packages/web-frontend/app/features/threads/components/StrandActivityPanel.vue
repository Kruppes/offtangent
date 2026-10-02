<template>
  <!--
    "What is working for this strand right now" (SPEC 10.x).

    A strand in which something runs must never look dead: the running turn
    and every delegated task — including sub-tasks, recursively — are listed
    here with a status dot and a counter that keeps ticking. The counter is
    the anti-freeze signal: as long as it moves, the user knows the system is
    alive even when no text streams.

    W4c: the panel is the "Activity" section of the strand dock (right
    column), no longer the tail of the transcript. Its header line stays when
    the section is folded, with the live dot and the counter, so folding can
    never hide the signal.
  -->
  <section
    class="flex min-h-0 flex-col"
    data-testid="dock-activity"
    :data-open="open ? 'true' : 'false'"
    aria-labelledby="strand-activity-title"
  >
    <h3 id="strand-activity-title" class="shrink-0">
      <button
        type="button"
        class="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        :aria-expanded="open"
        :aria-controls="bodyElementId"
        data-testid="dock-activity-toggle"
        @click="open = !open"
      >
        <AppIcon :name="open ? 'chevronDown' : 'chevronRight'" class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="shrink-0 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ $t('strandActivity.title') }}
        </span>
        <!-- Live dot: pulses while anything runs; reduced motion keeps it still. -->
        <span
          aria-hidden="true"
          data-testid="dock-activity-dot"
          :data-live="live ? 'true' : 'false'"
          class="h-2 w-2 shrink-0 rounded-full"
          :class="live ? ['bg-success', reducedMotion ? '' : 'motion-safe:animate-pulse'] : 'bg-border'"
        />
        <span
          v-if="headline"
          class="min-w-0 flex-1 truncate text-xs tabular-nums text-muted-foreground"
          data-testid="dock-activity-count"
        >{{ headline }}</span>
        <span v-else class="flex-1" />
        <span
          v-if="turnRunning"
          class="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success"
        >{{ $t('strandActivity.turnRunning') }}</span>
      </button>
    </h3>

    <!-- Focusable so a long task tree can be scrolled by keyboard (axe scrollable-region-focusable). -->
    <div
      v-if="open"
      :id="bodyElementId"
      class="min-h-0 flex-1 overflow-y-auto px-3 pb-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      tabindex="0"
      role="region"
      aria-labelledby="strand-activity-title"
    >
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
  /** Id of the folding body, for the header's aria-controls. */
  bodyId?: string
}>()

/** Fold state of the section; the dock owns and remembers it. */
const open = defineModel<boolean>('open', { default: true })
const bodyElementId = computed(() => props.bodyId ?? 'strand-activity-body')

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

// Legacy backends may lack identity in the tree. Detail is only a fallback
// for missing identity; it never replaces live usage, status or timestamps.
const metadata = ref<Record<string, TaskMetadata | null>>({})
let stopMetadataWatch: (() => void) | undefined
let disposed = false
onMounted(() => {
  const cache = createTaskMetadataCache(useTasksApi().getTask)
  stopMetadataWatch = watch(() => visibleRows.value.map(row => ({
    id: row.id,
    needsIdentity: !row.provider && !row.model,
  })), rows => {
    for (const { id, needsIdentity } of rows) {
      if (!needsIdentity || id in metadata.value) continue
      metadata.value[id] = null
      void cache(id).then(value => { if (!disposed) metadata.value[id] = value })
    }
  }, { immediate: true })
})
onBeforeUnmount(() => { disposed = true; stopMetadataWatch?.() })

/** Something runs: the dot in the header line pulses. */
const live = computed(() => Boolean(props.turnRunning) || liveCount.value > 0)

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
