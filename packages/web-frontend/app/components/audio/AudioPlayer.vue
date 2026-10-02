<template>
  <!-- One clip in the shared player: play/pause, a scrubber (ARIA slider,
       arrows ±5 s, PageUp/PageDown ±30 s, Home/End), time in tabular
       figures and an optional speed button. Nothing here starts by itself. -->
  <div class="flex min-w-0 items-center gap-2" :data-player-status="view.status" data-audio-player>
    <button
      type="button"
      class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
      :aria-label="view.status === 'playing' ? $t('w4b.player.pause', { label }) : $t('w4b.player.play', { label })"
      :disabled="disabled"
      data-player-toggle
      @click="onToggle"
    >
      <AppIcon v-if="view.status === 'loading'" name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
      <AppIcon v-else-if="view.status === 'playing'" name="pause" size="sm" />
      <AppIcon v-else name="play" size="sm" />
    </button>
    <div
      ref="track"
      role="slider"
      tabindex="0"
      class="group/scrub relative flex h-11 min-w-16 flex-1 cursor-pointer touch-none items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :aria-label="$t('w4b.player.position', { label })"
      aria-valuemin="0"
      :aria-valuemax="Math.round(view.duration)"
      :aria-valuenow="Math.round(view.position)"
      :aria-valuetext="$t('w4b.player.valueText', { position: formatClock(view.position), duration: formatClock(view.duration) })"
      :aria-disabled="!owns || view.duration <= 0 ? 'true' : undefined"
      data-player-scrubber
      @keydown="onKey"
      @pointerdown="onPointer"
    >
      <span class="relative block h-1.5 w-full overflow-hidden rounded-full bg-ring-track" aria-hidden="true">
        <span class="absolute inset-y-0 left-0 rounded-full bg-primary" :style="{ width: `${progress}%` }" />
      </span>
      <span
        class="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary"
        :style="{ left: `${progress}%` }"
        aria-hidden="true"
      />
    </div>
    <span class="shrink-0 text-xs tabular-nums text-muted-foreground" data-player-time>
      {{ formatClock(view.position) }} / {{ formatClock(view.duration) }}
    </span>
    <button
      v-if="showRate"
      type="button"
      class="inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-1 text-xs font-semibold tabular-nums text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:h-8"
      :aria-label="$t('w4b.player.rate', { rate: rateLabel })"
      data-player-rate
      @click="setRate(nextRate(view.rate))"
    >{{ rateLabel }}</button>
  </div>
  <p v-if="view.status === 'error'" class="mt-1 text-xs text-destructive" role="alert" data-player-error>
    {{ $t(`w4b.player.error.${view.error ?? 'unknown'}`) }}
  </p>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAudioPlayer, type SourceResolver } from '~/composables/useAudioPlayer'
import { formatClock, nextRate, progressPercent, seekForKey, seekForPointer, viewForClip } from '~/utils/audioPlayer'

const props = withDefaults(defineProps<{
  /** Stable id of the clip; the same id in two places is the same clip. */
  clipId: string
  /** Spoken name of the clip for the controls ("voice note", "read aloud"). */
  label: string
  /** Where the audio comes from; called on the first play only. */
  resolve: SourceResolver
  durationHint?: number
  showRate?: boolean
  disabled?: boolean
}>(), { durationHint: 0, showRate: false, disabled: false })

const player = useAudioPlayer()
const track = ref<HTMLElement | null>(null)
const view = computed(() => viewForClip(player.state.value, props.clipId, props.durationHint))
const owns = computed(() => player.state.value.id === props.clipId)
const progress = computed(() => progressPercent(view.value.position, view.value.duration))
const rateLabel = computed(() => `${view.value.rate}×`)

function onToggle() {
  void player.toggle(props.clipId, props.resolve, props.durationHint)
}

function onKey(event: KeyboardEvent) {
  if (!owns.value) return
  const next = seekForKey(event.key, view.value.position, view.value.duration)
  if (next === null) return
  event.preventDefault()
  player.seek(props.clipId, next)
}

function onPointer(event: PointerEvent) {
  if (!owns.value || !track.value) return
  const rect = track.value.getBoundingClientRect()
  const next = seekForPointer(event.clientX, rect.left, rect.width, view.value.duration)
  if (next !== null) player.seek(props.clipId, next)
}

function setRate(rate: number) {
  player.setRate(rate)
}
</script>
