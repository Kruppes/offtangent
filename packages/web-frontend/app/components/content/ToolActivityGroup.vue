<template>
  <details class="rounded-lg border border-border bg-muted/20 text-xs" data-tool-group>
    <summary class="min-h-11 cursor-pointer rounded-lg px-3 py-3 text-muted-foreground focus-visible:outline-2 focus-visible:outline-primary">
      {{ $t('w4Content.toolCalls', { count: tools.length }) }}
      <span v-if="errors" class="ml-2 text-destructive">{{ $t('w4Content.errors', { count: errors }) }}</span>
      <span v-if="running" class="ml-2">{{ $t('w4Content.running', { count: running }) }}<span v-if="elapsed !== null"> · {{ elapsed }}s</span></span>
    </summary>
    <div class="space-y-2 border-t border-border p-2">
      <div v-for="(msg, index) in tools" :key="msg.toolData?.toolCallId || msg.id || index">
        <p class="mb-1 flex gap-2 px-1 text-muted-foreground" :data-tool-state="stateOf(msg)">
          <span>{{ $t(`w4Content.${stateOf(msg) === 'running' ? 'runningState' : stateOf(msg)}`) }}</span>
          <span v-if="stateOf(msg) === 'running' && elapsedToolSeconds(msg, now) !== null">{{ elapsedToolSeconds(msg, now) }}s</span>
        </p>
        <slot :msg="msg" />
      </div>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { ChatMessage } from '../../composables/useChat'
import { elapsedToolSeconds, toolState } from './transcript'
const props = withDefaults(defineProps<{ tools: ChatMessage[]; active?: boolean }>(), { active: true })
const stateOf = (message: ChatMessage) => toolState(message, props.active)
const running = computed(() => props.tools.filter(m => stateOf(m) === 'running').length)
const errors = computed(() => props.tools.filter(m => stateOf(m) === 'error').length)
const now = ref(Date.now())
const elapsed = computed(() => {
  const values = props.tools.filter(m => stateOf(m) === 'running').map(m => elapsedToolSeconds(m, now.value)).filter((value): value is number => value !== null)
  return values.length ? Math.max(...values) : null
})
let timer: ReturnType<typeof setInterval> | undefined
watch(running, (count) => {
  clearInterval(timer)
  if (count && typeof window !== 'undefined') {
    now.value = Date.now()
    timer = setInterval(() => { now.value = Date.now() }, 1000)
  }
}, { immediate: true })
onUnmounted(() => clearInterval(timer))
</script>
