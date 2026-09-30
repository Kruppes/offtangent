<template>
  <div
    class="group flex min-w-0 w-full items-stretch gap-1"
    :style="{ paddingInlineStart: `${Math.min(row.level, 3) * 16}px` }"
  >
    <button
      v-if="row.children.length > 0"
      type="button"
      class="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="expanded"
      :aria-label="ariaLabel"
      @click="$emit('toggle', row.id)"
    >
      <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" class="h-3.5 w-3.5 text-muted-foreground" />
    </button>
    <NuxtLink
      :to="`/tasks/${encodeURIComponent(row.id)}`"
      class="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-label="ariaLabel"
    >
      <!-- Status dot. Pulses only while live and only when the user has not
           asked for reduced motion; the counter carries the liveness either way. -->
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="[dotClass, isLive && !reducedMotion ? 'motion-safe:animate-pulse' : '']"
        aria-hidden="true"
      />

      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm text-foreground" :title="row.name">{{ row.name }}</span>
        <span class="block truncate text-xs text-muted-foreground" :title="modelLabel">{{ modelLabel }}</span>
        <span class="block break-words font-mono text-xs tabular-nums text-muted-foreground" :aria-label="usageLabel">
          ↑ {{ row.promptTokens ?? 0 }} · ↓ {{ row.completionTokens ?? 0 }} · ${{ (row.estimatedCost ?? 0).toFixed(4) }}
        </span>

        <span class="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{{ statusLabel }}</span>
          <span class="font-mono tabular-nums">{{ elapsedLabel }}</span>
        </span>
      </span>
    </NuxtLink>
  </div>
  <p
    v-if="row.status === 'failed' && row.errorMessage"
    class="ml-2 break-words rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
    :style="{ marginInlineStart: `${Math.min(row.level, 3) * 16 + 30}px` }"
  >
    {{ row.errorMessage }}
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { elapsedSeconds, formatElapsed, isLive as nodeIsLive, type StrandTaskRow } from '../taskActivity'

const props = defineProps<{
  row: StrandTaskRow
  expanded: boolean
  nowMs: number
  reducedMotion: boolean
  metadata?: { model: string | null; provider: string | null } | null
}>()

defineEmits<{ toggle: [taskId: string] }>()

const { t } = useI18n()

const modelLabel = computed(() => [props.metadata?.provider, props.metadata?.model].filter(Boolean).join(' · ') || '—')

const isLive = computed(() => nodeIsLive(props.row))

const dotClass = computed(() => {
  switch (props.row.status) {
    case 'running': return 'bg-success shadow-[0_0_6px_hsl(var(--success))]'
    case 'paused': return 'bg-warning'
    case 'failed': return 'bg-destructive'
    default: return 'bg-muted-foreground/60'
  }
})

const statusLabel = computed(() => {
  switch (props.row.status) {
    case 'running': return t('strandActivity.statusRunning')
    case 'paused': return t('strandActivity.statusPaused')
    case 'failed': return t('strandActivity.statusFailed')
    default: return t('strandActivity.statusCompleted')
  }
})

const usageLabel = computed(() => `${t('tasks.tokensTooltip.input')}: ${props.row.promptTokens ?? 0}, ${t('tasks.tokensTooltip.output')}: ${props.row.completionTokens ?? 0}, ${t('tasks.columns.cost')}: $${(props.row.estimatedCost ?? 0).toFixed(4)}`)

const elapsedLabel = computed(() => formatElapsed(elapsedSeconds(props.row, props.nowMs)))

const ariaLabel = computed(() =>
  `${props.row.name}, ${statusLabel.value}, ${elapsedLabel.value}` +
  (props.row.children.length > 0 ? `, ${t('strandActivity.subtaskCount', { count: props.row.children.length })}` : ''),
)
</script>
