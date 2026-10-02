<script setup lang="ts">
/**
 * Right context column of a strand (W3 frame). Shows what exists today: the
 * strand's canvas views (opened in the existing canvas, one renderer only)
 * and the strand's facts. The `extra` slot is where W4 puts the context
 * gauge and the audio list.
 */
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import type { StrandDetail } from '~/features/strands/detailApi'
import { parseBackendTimestamp } from '~/utils/datetime'

const props = defineProps<{ strandId: string; strand: StrandDetail | null }>()
const emit = defineEmits<{ close: [] }>()
const { locale } = useI18n()
const canvas = useStrandCanvas(() => props.strandId)
const views = computed(() => canvas.views.value)
function when(value: string | null | undefined) {
  const date = parseBackendTimestamp(value ?? null)
  return date ? date.toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' }) : ''
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="strand-context">
    <div class="flex min-h-14 shrink-0 items-center gap-2 border-b border-border px-3">
      <h2 id="strand-context-title" class="min-w-0 flex-1 text-sm font-semibold">{{ $t('shell.context') }}</h2>
      <button type="button" class="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="$t('shell.contextClose')" data-testid="context-close" @click="emit('close')">
        <AppIcon name="close" />
      </button>
    </div>
    <div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-3">
      <section aria-labelledby="ctx-canvas">
        <h3 id="ctx-canvas" class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('shell.contextCanvas') }}</h3>
        <ul v-if="views.length" class="space-y-1">
          <li v-for="view in views" :key="view.viewKey">
            <button type="button" class="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :aria-current="canvas.openViewKey.value === view.viewKey ? 'true' : undefined" @click="canvas.open(view.viewKey)">
              <AppIcon name="file" size="sm" class="text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ view.title }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">r{{ view.latestRevision }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground" data-testid="context-canvas-empty">{{ $t('shell.contextCanvasEmpty') }}</p>
      </section>
      <section aria-labelledby="ctx-strand">
        <h3 id="ctx-strand" class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('shell.contextStrand') }}</h3>
        <p v-if="!strand" class="text-sm text-muted-foreground" role="status">{{ $t('common.loading') }}</p>
        <dl v-else class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-muted-foreground">{{ $t('shell.contextMessages') }}</dt><dd>{{ strand.messageCount }}</dd>
          <dt class="text-muted-foreground">{{ $t('shell.contextStarted') }}</dt><dd>{{ when(strand.startedAt) }}</dd>
          <dt class="text-muted-foreground">{{ $t('shell.contextLastActivity') }}</dt><dd>{{ when(strand.lastActivity) }}</dd>
        </dl>
      </section>
      <!-- W4 slot: context gauge, audio list and further strand context. -->
      <slot name="extra" />
    </div>
  </div>
</template>
