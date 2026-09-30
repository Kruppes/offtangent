<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { elapsedTurnSeconds, isTurnActive } from '~/features/threads/turnProgress'
const props = defineProps<{ strandId: string | null }>()
const { turnProgress } = useChat()
const turn = computed(() => props.strandId ? turnProgress.value[props.strandId] : undefined)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(() => isTurnActive(turn.value), active => {
  if (timer) clearInterval(timer)
  timer = undefined
  now.value = Date.now()
  if (active) timer = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>
<template>
  <div v-if="turn" class="flex min-h-11 shrink-0 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground" data-turn-progress>
    <span class="h-2 w-2 rounded-full" :class="isTurnActive(turn) ? 'bg-primary motion-safe:animate-pulse' : 'bg-muted-foreground'" />
    <span role="status">{{ $t(`turnProgress.${turn.phase}`) }}</span>
    <span class="tabular-nums">{{ elapsedTurnSeconds(turn, now) }}s</span>
  </div>
</template>
