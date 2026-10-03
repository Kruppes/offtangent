<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import type { ChatAttachment } from '~/composables/useChat'
import { formatElapsed } from '~/utils/dictation'

/**
 * A kept dictation recording waiting in the composer: play/pause and remove.
 * The recording is already stored on the server (`keepAudio=1`); sending the
 * message references it, it is not uploaded again.
 */
const props = defineProps<{ attachment: ChatAttachment; index: number; durationMs?: number }>()
const emit = defineEmits<{ remove: [] }>()

const config = useRuntimeConfig()
const { getAccessToken } = useAuth()
const playing = ref(false)
let audio: HTMLAudioElement | null = null

/** Same auth path as ChatAttachments: the token travels as query parameter. */
function source(): string {
  const params = new URLSearchParams()
  const token = getAccessToken()
  if (token) params.set('token', token)
  const query = params.toString()
  return `${config.public.apiBase}${props.attachment.urlPath}${query ? `?${query}` : ''}`
}

async function toggle() {
  if (playing.value && audio) {
    audio.pause()
    return
  }
  if (!audio) {
    audio = new Audio(source())
    audio.addEventListener('ended', () => { playing.value = false })
    audio.addEventListener('pause', () => { playing.value = false })
    audio.addEventListener('play', () => { playing.value = true })
  }
  try {
    await audio.play()
  } catch {
    playing.value = false
  }
}

onBeforeUnmount(() => {
  audio?.pause()
  audio = null
})
</script>

<template>
  <div data-testid="dictation-audio-chip" class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted pl-1 pr-1 text-xs" :title="$t('chat.dictation.audio.attached')">
    <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-label="playing ? $t('chat.dictation.audio.pause', { n: index }) : $t('chat.dictation.audio.play', { n: index })" :aria-pressed="playing" @click="toggle">
      <AppIcon :name="playing ? 'pause' : 'play'" />
    </button>
    <AppIcon name="mic" size="sm" class="text-muted-foreground" />
    <span class="truncate font-medium">{{ $t('chat.dictation.audio.label', { n: index }) }}</span>
    <span v-if="durationMs" class="font-mono tabular-nums text-muted-foreground">{{ formatElapsed(durationMs) }}</span>
    <button type="button" class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-label="$t('chat.dictation.audio.remove', { n: index })" @click="emit('remove')">
      <AppIcon name="close" />
    </button>
  </div>
</template>
