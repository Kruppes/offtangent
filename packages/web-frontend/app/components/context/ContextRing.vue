<template>
  <!-- Context ring (N2). Track in --ring-track (>= 3:1), fill in --ring-fill;
       the 70 % and 90 % thresholds are tick marks on the track (form), from
       70 % the part beyond the mark is a separate caution segment, and from
       90 % an outer notch ring marks "full" — so no state relies on colour. -->
  <span
    class="relative inline-flex shrink-0 items-center justify-center"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="label"
    :data-band="geometry.band"
    data-context-ring
  >
    <svg :width="size" :height="size" :viewBox="`0 0 ${box} ${box}`" aria-hidden="true" focusable="false">
      <circle :cx="c" :cy="c" :r="r" fill="none" class="stroke-ring-track" :stroke-width="stroke" :stroke-dasharray="geometry.band === 'unknown' ? `${stroke} ${stroke}` : undefined" />
      <circle
        v-if="geometry.base > 0"
        :cx="c" :cy="c" :r="r" fill="none" class="stroke-ring-fill" :stroke-width="stroke" stroke-linecap="butt"
        :stroke-dasharray="base.dasharray" :stroke-dashoffset="base.dashoffset" :transform="`rotate(-90 ${c} ${c})`"
      />
      <circle
        v-if="geometry.over > 0"
        :cx="c" :cy="c" :r="r" fill="none" :class="geometry.band === 'full' ? 'stroke-ring-full' : 'stroke-ring-caution'" :stroke-width="stroke + (large ? 2 : 1)" stroke-linecap="butt"
        :stroke-dasharray="over.dasharray" :stroke-dashoffset="over.dashoffset" :transform="`rotate(-90 ${c} ${c})`"
        data-ring-over
      />
      <line
        v-for="tick in ticks" :key="tick.at"
        :x1="tick.inner.x" :y1="tick.inner.y" :x2="tick.outer.x" :y2="tick.outer.y"
        class="stroke-foreground" :stroke-width="large ? 2 : 1.25" :data-ring-tick="tick.at"
      />
      <circle v-if="geometry.band === 'full'" :cx="c" :cy="c" :r="r + stroke" fill="none" class="stroke-ring-full" :stroke-width="large ? 1.5 : 1" stroke-dasharray="2 2" data-ring-full-mark />
    </svg>
    <span v-if="large" class="absolute inset-0 flex flex-col items-center justify-center text-center leading-tight">
      <span class="text-lg font-semibold tabular-nums">{{ percent === null ? '–' : `${percent} %` }}</span>
      <span v-if="geometry.band === 'caution' || geometry.band === 'full'" class="text-2xs font-semibold uppercase tracking-label" :class="geometry.band === 'full' ? 'text-destructive' : 'text-foreground'">{{ geometry.band === 'full' ? '!!' : '!' }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { arcDash, gaugePercent, ringGeometry, tickPoint } from '~/utils/contextGauge'

const props = withDefaults(defineProps<{
  ratio: number | null
  /** Accessible name, e.g. "Context 64 % of 200k tokens". */
  label: string
  size?: number
}>(), { size: 24 })

const large = computed(() => props.size >= 48)
const box = 40
const c = box / 2
const stroke = computed(() => (large.value ? 4 : 5))
const r = computed(() => c - stroke.value - 2)
const circumference = computed(() => 2 * Math.PI * r.value)
const geometry = computed(() => ringGeometry(props.ratio))
const percent = computed(() => gaugePercent(props.ratio))
const base = computed(() => arcDash(circumference.value, 0, geometry.value.base))
const over = computed(() => arcDash(circumference.value, geometry.value.base, geometry.value.over))
const ticks = computed(() => geometry.value.ticks.map(at => ({
  at,
  inner: tickPoint(c, c, r.value - stroke.value / 2 - 1, at),
  outer: tickPoint(c, c, r.value + stroke.value / 2 + 1, at),
})))
</script>
