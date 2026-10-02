<script setup lang="ts">
/**
 * The strand head's "something runs" hint while the dock is closed (W4c).
 * Closing the right column must never hide the anti-freeze signal (SPEC
 * 10.x): a running answer or live tasks show up here, and a click opens the
 * dock with the activity section unfolded.
 */
import { computed } from 'vue'
import type { RunningHint } from '~/utils/strandDock'

const props = defineProps<{ hint: RunningHint }>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()

const label = computed(() => {
  switch (props.hint.kind) {
    case 'turn': return t('strandActivity.turnRunning')
    case 'tasks': return t('strandActivity.liveCount', { count: props.hint.count }, props.hint.count)
    case 'turn-and-tasks': return `${t('strandActivity.turnRunning')} · ${t('strandActivity.liveCount', { count: props.hint.count }, props.hint.count)}`
    default: return ''
  }
})
/** The compact form on phones: the dot plus the task count. */
const short = computed(() => ('count' in props.hint ? String(props.hint.count) : ''))
</script>

<template>
  <button
    v-if="hint.kind !== 'none'"
    type="button"
    data-testid="dock-running-hint"
    :data-kind="hint.kind"
    class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-lg px-2 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :aria-label="`${label} – ${t('shell.dockOpenActivity')}`"
    aria-expanded="false"
    aria-controls="strand-context-column"
    @click="emit('open')"
  >
    <span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full bg-success motion-safe:animate-pulse" />
    <span aria-hidden="true" class="hidden max-w-56 truncate tabular-nums sm:inline">{{ label }}</span>
    <span v-if="short" aria-hidden="true" class="tabular-nums sm:hidden">{{ short }}</span>
  </button>
</template>
