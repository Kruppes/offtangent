<script setup lang="ts">
import { computed } from 'vue'
import { formatElapsed, type DictationErrorCode, type DictationPhase } from '~/utils/dictation'

/**
 * The visible state of a dictation above the composer: recording (red dot,
 * running time, live level, Cancel / Done), transcribing (spinner) and a
 * lasting error with the action that fits it. Pure view: `useStt` owns the
 * state, ChatView wires the events.
 */
const props = withDefaults(defineProps<{
  phase: DictationPhase
  elapsedMs?: number
  levels?: number[]
  error?: DictationErrorCode | null
  canRetry?: boolean
  bars?: number
}>(), { elapsedMs: 0, levels: () => [], error: null, canRetry: false, bars: 24 })

const emit = defineEmits<{ cancel: []; finish: []; retry: []; dismiss: [] }>()
const { t } = useI18n()

const elapsed = computed(() => formatElapsed(props.elapsedMs))
/** Fixed number of bars, newest on the right; missing history is silence. */
const shownLevels = computed(() => {
  const row = props.levels.slice(-props.bars)
  return [...Array.from({ length: props.bars - row.length }, () => 0), ...row]
})
const errorText = computed(() => props.error ? t(`chat.dictation.errors.${props.error}`) : '')
/** Short status line for screen readers; changes only on phase changes. */
const liveText = computed(() => {
  if (props.phase === 'recording') return t('chat.dictation.recording')
  if (props.phase === 'transcribing') return t('chat.dictation.transcribing')
  return ''
})
</script>

<template>
  <div data-testid="dictation-bar" :data-phase="phase">
    <!-- Polite status for phase changes; the error box below is its own alert. -->
    <p class="sr-only" aria-live="polite" role="status">{{ liveText }}</p>

    <div v-if="phase === 'recording' || phase === 'starting'" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2">
      <span class="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <span class="relative flex h-3 w-3 shrink-0" aria-hidden="true">
          <span class="absolute inline-flex h-full w-full rounded-full bg-destructive opacity-60 motion-safe:animate-ping" />
          <span class="relative inline-flex h-3 w-3 rounded-full bg-destructive" />
        </span>
        <span class="truncate">{{ $t('chat.dictation.recording') }}</span>
      </span>
      <time data-testid="dictation-elapsed" class="font-mono text-sm tabular-nums text-foreground" :aria-label="$t('chat.dictation.elapsed', { time: elapsed })">{{ elapsed }}</time>
      <div class="flex h-6 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" role="img" :aria-label="$t('chat.dictation.level')" data-testid="dictation-level">
        <span
          v-for="(level, index) in shownLevels"
          :key="index"
          class="w-[3px] shrink-0 rounded-full bg-destructive/80 motion-safe:transition-[height] motion-safe:duration-150"
          :style="{ height: `${Math.max(12, Math.round(level * 100))}%` }"
        />
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button type="button" data-testid="dictation-cancel" class="inline-flex min-h-11 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="emit('cancel')">
          {{ $t('chat.dictation.cancel') }}
        </button>
        <button type="button" data-testid="dictation-finish" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" :disabled="phase !== 'recording'" @click="emit('finish')">
          <AppIcon name="check" />{{ $t('chat.dictation.done') }}
        </button>
      </div>
      <p class="hidden w-full text-xs text-muted-foreground sm:block">{{ $t('chat.dictation.shortcutHint') }}</p>
    </div>

    <div v-else-if="phase === 'transcribing'" class="flex min-h-11 items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground">
      <AppIcon name="loader" class="motion-safe:animate-spin" />
      <span>{{ $t('chat.dictation.transcribing') }}</span>
    </div>

    <div v-else-if="phase === 'error' && error" role="alert" data-testid="dictation-error" :data-error="error" class="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-foreground">
      <AppIcon :name="error === 'permission_denied' ? 'micOff' : 'warning'" class="mt-0.5 text-destructive" />
      <div class="min-w-0 flex-1">
        <p class="break-words">{{ errorText }}</p>
        <p v-if="error === 'permission_denied'" class="mt-1 break-words text-xs text-muted-foreground">{{ $t('chat.dictation.errors.permission_help') }}</p>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <button v-if="canRetry" type="button" data-testid="dictation-retry" class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="emit('retry')">
          <AppIcon name="retry" />{{ $t('chat.dictation.retry') }}
        </button>
        <button type="button" data-testid="dictation-dismiss" class="inline-flex min-h-11 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="emit('dismiss')">
          {{ $t('chat.dictation.dismiss') }}
        </button>
      </div>
    </div>
  </div>
</template>
