<template>
  <!-- A voice message as its own highlighted element (VoiceNoteBubble.kt):
       the spoken version of an answer, a kept dictation, or an audio file.
       It is never regenerated here; it plays what the server stored. -->
  <div
    class="mt-2 w-full max-w-sm rounded-lg border border-primary/40 bg-primary/[0.08] px-2 py-1.5"
    :data-voice-note="kind"
  >
    <p class="flex items-center gap-1.5 px-1 text-xs font-medium text-foreground">
      <AppIcon :name="kind === 'dictation' ? 'mic' : 'volume'" size="sm" class="h-3.5 w-3.5 text-primary" />
      <span class="min-w-0 truncate">{{ title }}</span>
      <span v-if="seconds > 0" class="ml-auto shrink-0 tabular-nums text-muted-foreground">{{ formatClock(seconds) }}</span>
    </p>
    <AudioPlayer :clip-id="clipId" :label="title" :resolve="resolve" :duration-hint="seconds" :show-rate="kind !== 'file'" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AudioPlayer from './AudioPlayer.vue'
import { uploadSrc } from '~/api/speech'
import { formatClock } from '~/utils/audioPlayer'

const props = withDefaults(defineProps<{
  /** `urlPath` of a stored upload (`/api/uploads/...`), checked by the caller. */
  url: string
  seconds?: number
  kind: 'assistant' | 'dictation' | 'file'
  /** Visible title; defaults to the kind's label. */
  name?: string
}>(), { seconds: 0, name: '' })

const { t } = useI18n()
const config = useRuntimeConfig()
const { getAccessToken } = useAuth()
const clipId = computed(() => `upload:${props.url}`)
const title = computed(() => props.name || t(`w4b.voice.${props.kind}`))
/** Resolved at play time so a refreshed token is used. */
function resolve(): string {
  return uploadSrc(String(config.public.apiBase ?? ''), props.url, getAccessToken())
}
</script>
