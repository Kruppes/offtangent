<template>
  <div class="w-full min-w-0" data-turn-line :data-turn-state="summary.live ? 'live' : summary.errorCount ? 'error' : 'done'">
    <!-- ONE line per turn. It keeps its height while the turn streams, so the
         answer below never jumps; the live step only changes its text. -->
    <button
      type="button"
      class="inline-flex min-h-11 max-w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8"
      :aria-expanded="open"
      :aria-controls="listId"
      data-turn-toggle
      @click="open = !open"
    >
      <AppIcon v-if="summary.live" name="loader" size="sm" class="animate-spin text-primary motion-reduce:animate-none" />
      <AppIcon v-else-if="summary.errorCount" name="warning" size="sm" class="text-destructive" />
      <AppIcon v-else name="wrench" size="sm" />
      <span class="min-w-0 truncate" data-turn-summary>
        <template v-if="summary.live">
          {{ $t('w4a.turn.live', { step: summary.currentStep ?? 1 }) }}<template v-if="liveLabel"> · {{ liveLabel.i18n ? $t(liveLabel.i18n) : liveLabel.text }}</template>
        </template>
        <template v-else>
          {{ $t(stepsLabel.key, stepsLabel.params) }}
        </template>
        <span v-if="durationLabel" class="tabular-nums"> · {{ $t(durationLabel.key, durationLabel.params) }}</span>
        <span v-if="!summary.live && summary.errorCount" class="text-destructive"> · {{ $t('w4Content.errors', { count: summary.errorCount }) }}</span>
      </span>
      <AppIcon name="chevronDown" size="sm" class="transition-transform motion-reduce:transition-none" :class="open ? 'rotate-180' : ''" />
    </button>
    <!-- Screen readers hear a new step once, not every second of the clock. -->
    <span class="sr-only" aria-live="polite">{{ summary.live && liveLabel ? (liveLabel.i18n ? $t(liveLabel.i18n) : liveLabel.text) : '' }}</span>

    <ul v-if="open" :id="listId" class="mt-1 space-y-1 border-l border-border pl-3" data-turn-steps>
      <li v-if="thinking.length" data-turn-reasoning>
        <button
          type="button"
          class="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8"
          :aria-expanded="reasoningOpen"
          :aria-controls="`${listId}-reasoning`"
          data-reasoning-toggle
          @click="reasoningOpen = !reasoningOpen"
        >
          <AppIcon name="brain" size="sm" />
          <span>{{ $t('w4a.turn.reasoning') }}</span>
          <span v-if="thinking.length > 1" class="tabular-nums">({{ thinking.length }})</span>
          <AppIcon name="chevronDown" size="sm" class="transition-transform motion-reduce:transition-none" :class="reasoningOpen ? 'rotate-180' : ''" />
        </button>
        <div v-if="reasoningOpen" :id="`${listId}-reasoning`" class="mt-1 max-h-80 space-y-2 overflow-y-auto rounded-md bg-muted px-3 py-2" tabindex="0" :aria-label="$t('w4a.turn.reasoning')">
          <p v-for="(block, i) in thinking" :key="block.id ?? i" class="whitespace-pre-wrap break-words text-sm text-muted-foreground">{{ block.content }}</p>
        </div>
      </li>
      <li v-for="(tool, i) in tools" :key="tool.toolData?.toolCallId || tool.id || i" class="min-w-0" :data-tool-state="stateOf(tool)">
        <div class="mb-1 flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <AppIcon v-if="stateOf(tool) === 'running'" name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
          <AppIcon v-else-if="stateOf(tool) === 'error'" name="warning" size="sm" class="text-destructive" />
          <AppIcon v-else-if="stateOf(tool) === 'complete'" name="check" size="sm" />
          <AppIcon v-else name="info" size="sm" />
          <span :class="stateOf(tool) === 'error' ? 'text-destructive' : ''">{{ $t(`w4Content.${stateOf(tool) === 'running' ? 'runningState' : stateOf(tool)}`) }}</span>
        </div>
        <slot name="tool" :msg="tool" />
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import type { ChatMessage } from '../../composables/useChat'
import { formatTurnDuration, summarizeTurn, toolState } from './transcript'

/**
 * The work of one assistant turn (tool calls and reasoning) as ONE collapsed
 * line: "12 steps · 40 s". Opening it lists the steps; the reasoning sits one
 * level deeper behind its own toggle. Pure presentation: the steps are the
 * transcript rows as they are, nothing is re-derived or mutated.
 */
const props = withDefaults(defineProps<{
  steps: ChatMessage[]
  /** A turn of this conversation is still in flight (streaming or running). */
  active?: boolean
  /** End of the turn when known (timestamp of its final answer). */
  turnEnd?: string
  /** Display name of a tool step, e.g. the formatted tool name. */
  labelOf?: (message: ChatMessage) => string
}>(), { active: false, turnEnd: undefined, labelOf: (message: ChatMessage) => message.toolData?.toolName ?? '' })

const listId = `turn-${useId()}`
const open = ref(false)
const reasoningOpen = ref(false)
const now = ref(Date.now())

const tools = computed(() => props.steps.filter(step => step.role === 'tool'))
const thinking = computed(() => props.steps.filter(step => step.isThinking))
const stateOf = (message: ChatMessage) => toolState(message, props.active)
const summary = computed(() => summarizeTurn(props.steps, { active: props.active, now: now.value, turnEnd: props.turnEnd }))

const stepsLabel = computed((): { key: string; params: Record<string, number> } => {
  const s = summary.value
  if (s.toolCount === 0) return { key: 'w4a.turn.reasoningOnly', params: {} }
  return s.toolCount === 1 ? { key: 'w4a.turn.stepsOne', params: {} } : { key: 'w4a.turn.steps', params: { count: s.toolCount } }
})
const durationLabel = computed(() => {
  const seconds = summary.value.durationSeconds
  if (seconds === null) return null
  const { key, params } = formatTurnDuration(seconds)
  return { key: `w4a.turn.duration.${key}`, params }
})
const liveLabel = computed((): { i18n?: string; text?: string } | null => {
  const current = summary.value.current
  if (!current) return null
  return current.kind === 'thinking' ? { i18n: 'w4a.turn.thinkingNow' } : { text: props.labelOf(current.message) }
})

let timer: ReturnType<typeof setInterval> | undefined
watch(() => summary.value.live, (live) => {
  clearInterval(timer)
  if (live && typeof window !== 'undefined') {
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
onUnmounted(() => clearInterval(timer))
</script>
