<script setup lang="ts">
import { computed } from 'vue'
import type { SeriesPoint } from '~/api/boards'

const props = defineProps<{ points: SeriesPoint[]; label: string }>()

const WIDTH = 100
const HEIGHT = 28

const shape = computed(() => {
  const values = props.points.map(point => point.value).filter(value => Number.isFinite(value))
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = WIDTH / (values.length - 1)
  const coords = values.map((value, index) => {
    const x = index * step
    const y = HEIGHT - ((value - min) / span) * HEIGHT
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const last = values[values.length - 1] ?? 0
  const first = values[0] ?? 0
  return { line: coords.join(' '), rising: last >= first, count: values.length }
})
</script>

<template>
  <svg v-if="shape" viewBox="0 0 100 28" preserveAspectRatio="none" role="img" :aria-label="label"
    class="h-10 w-full" :class="shape.rising ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'">
    <polyline :points="shape.line" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"
      stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
