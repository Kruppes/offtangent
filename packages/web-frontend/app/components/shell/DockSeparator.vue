<script setup lang="ts">
/**
 * A window splitter (WAI-ARIA `separator` with a value): drag with mouse,
 * pen or touch, arrow keys (16 px, Shift 64 px), Home/End to the bounds,
 * double click back to the default size. The math lives in
 * `~/utils/strandDock`; this component only turns events into values.
 *
 * `vertical` = a vertical bar on the LEFT edge of the dock that sets its
 * width; `horizontal` = a horizontal bar below the activity section that
 * sets its height. The hit area is 24 px (44 px on coarse pointers); only a
 * hairline is drawn.
 */
import { ref } from 'vue'
import { separatorDragValue, separatorKeyValue } from '~/utils/strandDock'

const props = defineProps<{
  orientation: 'vertical' | 'horizontal'
  value: number
  min: number
  max: number
  label: string
  /** Id of the element whose size this separator controls. */
  controls: string
}>()
const emit = defineEmits<{ update: [value: number]; reset: [] }>()

const dragging = ref(false)
let start: { pos: number; value: number; pointerId: number } | null = null
const pos = (event: PointerEvent) => (props.orientation === 'vertical' ? event.clientX : event.clientY)

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
  start = { pos: pos(event), value: props.value, pointerId: event.pointerId }
  dragging.value = true
}
function onPointerMove(event: PointerEvent) {
  if (!start || event.pointerId !== start.pointerId) return
  const next = separatorDragValue(props.orientation, start.value, start.pos, pos(event), { min: props.min, max: props.max })
  if (next !== props.value) emit('update', next)
}
function onPointerEnd(event: PointerEvent) {
  if (!start || event.pointerId !== start.pointerId) return
  ;(event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId)
  start = null
  dragging.value = false
}
function onKeydown(event: KeyboardEvent) {
  const next = separatorKeyValue(event.key, event.shiftKey, props.value, { min: props.min, max: props.max }, props.orientation)
  if (next === null) return
  event.preventDefault()
  if (next !== props.value) emit('update', next)
}
</script>

<template>
  <!-- aria-orientation names the bar itself: a vertical bar splits left/right. -->
  <div
    role="separator"
    tabindex="0"
    :aria-orientation="orientation"
    :aria-valuenow="value"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-label="label"
    :aria-controls="controls"
    :data-dragging="dragging ? 'true' : undefined"
    :data-testid="`dock-separator-${orientation}`"
    class="group/sep absolute z-10 flex touch-none select-none items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    :class="orientation === 'vertical'
      ? 'inset-y-0 -left-3 w-6 cursor-col-resize any-pointer-coarse:-left-6 any-pointer-coarse:w-12'
      : 'inset-x-0 -top-3 h-6 cursor-row-resize any-pointer-coarse:-top-6 any-pointer-coarse:h-12'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerEnd"
    @pointercancel="onPointerEnd"
    @lostpointercapture="onPointerEnd"
    @keydown="onKeydown"
    @dblclick="emit('reset')"
  >
    <span
      aria-hidden="true"
      class="pointer-events-none rounded-full bg-transparent transition-colors group-hover/sep:bg-ring group-focus-visible/sep:bg-ring group-data-[dragging=true]/sep:bg-ring"
      :class="orientation === 'vertical' ? 'h-full w-0.5' : 'h-0.5 w-full'"
    />
  </div>
</template>
