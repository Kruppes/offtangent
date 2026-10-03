<script setup lang="ts">
/**
 * The strand dock (W4c, N6): the right column of the strand workspace with
 * two sections, "Activity" (what runs for this strand, SPEC 10.x) and
 * "Context" (canvas views, strand facts, the W4b context details).
 *
 * Each section folds on its own; when both are open a horizontal handle
 * splits the height between them. Inline the dock's width is set by the page
 * (the vertical handle on the dock's left edge); as a sheet below the inline
 * breakpoint nothing is dragged, both sections still fold.
 *
 * Sizes and fold states come from `useStrandDock` (one global preference).
 */
import { computed, ref } from 'vue'
import { useElementSize } from '@vueuse/core'
import StrandActivityPanel from '~/features/threads/components/StrandActivityPanel.vue'
import StrandContextPanel from '~/features/strands/StrandContextPanel.vue'
import DockSeparator from '~/components/shell/DockSeparator.vue'
import type { StrandDetail } from '~/features/strands/detailApi'
import { useStrandDock } from '~/composables/useStrandDock'
import { activityHeightBounds, clampActivityHeight, dockSplit } from '~/utils/strandDock'

const props = defineProps<{
  strandId: string
  strand: StrandDetail | null
  turnRunning: boolean
  /** Inline column (draggable split) or sheet (folding only). */
  resizable: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()

const dock = useStrandDock()
const activityOpen = computed({
  get: () => dock.state.value.activityOpen,
  set: (open: boolean) => dock.setSectionOpen('activity', open),
})
const contextOpen = computed(() => dock.state.value.contextOpen)
const split = computed(() => dockSplit(dock.state.value))

// Space both sections share; the split is clamped to it while drawing, the
// stored height stays what the user chose (a taller window gets it back).
const sections = ref<HTMLElement | null>(null)
const { height: available } = useElementSize(sections)
const bounds = computed(() => activityHeightBounds(available.value))
const activityHeight = computed(() => clampActivityHeight(dock.state.value.activityHeight, available.value))
const showSplitter = computed(() => props.resizable && split.value === 'split' && available.value > 0)

const activityStyle = computed(() => (showSplitter.value ? { height: `${activityHeight.value}px` } : undefined))
const activityClass = computed(() => {
  if (split.value === 'activity-only') return 'flex-1'
  // Sheet: no handle, the activity takes what it needs up to about half.
  if (split.value === 'split' && !props.resizable) return 'max-h-[45%] shrink-0'
  return 'shrink-0'
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="strand-dock" :data-split="split">
    <div class="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3">
      <h2 id="strand-context-title" class="min-w-0 flex-1 truncate text-sm font-semibold">{{ t('shell.dock') }}</h2>
      <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('shell.contextClose')" data-testid="context-close" @click="emit('close')">
        <AppIcon name="close" />
      </button>
    </div>
    <div ref="sections" class="flex min-h-0 flex-1 flex-col">
      <StrandActivityPanel
        v-model:open="activityOpen"
        :strand-id="strandId"
        :turn-running="turnRunning"
        body-id="strand-activity-body"
        :class="activityClass"
        :style="activityStyle"
      />
      <div class="relative shrink-0 border-t border-border">
        <DockSeparator
          v-if="showSplitter"
          orientation="horizontal"
          :value="activityHeight"
          :min="bounds.min"
          :max="bounds.max"
          :label="t('shell.dockSplit')"
          controls="strand-activity-body"
          @update="dock.setActivityHeight($event)"
          @reset="dock.resetActivityHeight()"
        />
      </div>
      <section class="flex min-h-0 flex-col" :class="contextOpen ? 'flex-1' : 'shrink-0'" data-testid="dock-context" :data-open="contextOpen ? 'true' : 'false'" aria-labelledby="strand-context-section-title">
        <h3 id="strand-context-section-title" class="shrink-0">
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-2 px-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            :aria-expanded="contextOpen"
            aria-controls="strand-context-body"
            data-testid="dock-context-toggle"
            @click="dock.toggleSection('context')"
          >
            <AppIcon :name="contextOpen ? 'chevronDown' : 'chevronRight'" class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="text-xs font-semibold uppercase tracking-label text-muted-foreground">{{ t('shell.context') }}</span>
          </button>
        </h3>
        <div v-if="contextOpen" id="strand-context-body" class="min-h-0 flex-1">
          <StrandContextPanel :strand-id="strandId" :strand="strand" labelled-by="strand-context-section-title">
            <template #extra><slot name="context-extra" /></template>
          </StrandContextPanel>
        </div>
      </section>
    </div>
  </div>
</template>
