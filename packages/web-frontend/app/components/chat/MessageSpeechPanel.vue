<template>
  <!-- State of the read-aloud / summary clip of one answer and of a voice
       note being created: generating, ready (player), error with retry. -->
  <div v-if="entry || job?.status === 'error'" class="mt-1 w-full max-w-conversation space-y-2" data-speech-panel>
    <div v-if="entry" class="rounded-lg border border-border bg-card px-2 py-2" :data-speech-state="entry.status" :data-speech-mode="entry.mode">
      <div class="flex items-center gap-2 px-1">
        <AppIcon :name="entry.mode === 'read' ? 'volume' : 'sparkles'" size="sm" class="h-3.5 w-3.5 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ $t(entry.mode === 'read' ? 'w4b.speech.read' : 'w4b.speech.summary') }}</span>
        <button
          type="button"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:h-8 pointer-fine:w-8"
          :aria-label="$t('w4b.speech.close')"
          data-speech-close
          @click="speech.dismiss(messageId, text)"
        >
          <AppIcon name="close" size="sm" />
        </button>
      </div>
      <p v-if="entry.status === 'loading'" class="flex items-center gap-2 px-1 pb-1 text-sm text-muted-foreground" role="status">
        <AppIcon name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
        {{ $t(entry.mode === 'read' ? 'w4b.speech.generatingRead' : 'w4b.speech.generatingSummary') }}
      </p>
      <div v-else-if="entry.status === 'error'" class="flex flex-wrap items-center gap-2 px-1 pb-1" role="alert">
        <span class="text-sm text-destructive">{{ $t(`w4b.speech.error.${entry.error ?? 'generic'}`) }}</span>
        <button type="button" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8" data-speech-retry @click="retry(entry.mode)">
          <AppIcon name="retry" size="sm" />{{ $t('w4b.speech.retry') }}
        </button>
      </div>
      <template v-else-if="entry.src">
        <AudioPlayer :clip-id="speechClipId(key, entry.mode)" :label="$t(entry.mode === 'read' ? 'w4b.speech.read' : 'w4b.speech.summary')" :resolve="() => entry!.src!" show-rate />
        <p v-if="entry.summary" class="max-w-reading px-1 pb-1 pt-1 text-sm text-muted-foreground" data-speech-summary>{{ entry.summary }}</p>
      </template>
    </div>
    <div v-if="job?.status === 'error'" class="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2 py-1" role="alert" data-voice-note-error>
      <span class="text-sm text-destructive">{{ $t(`w4b.speech.error.${job.error ?? 'generic'}`) }}</span>
      <button type="button" class="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8" @click="speech.createVoiceNote(messageId!)">
        <AppIcon name="retry" size="sm" />{{ $t('w4b.speech.retry') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AudioPlayer from '~/components/audio/AudioPlayer.vue'
import { messageKey, speechClipId, useMessageSpeech, type SpeechMode } from '~/composables/useMessageSpeech'

const props = defineProps<{ messageId?: number; text: string }>()
const speech = useMessageSpeech()
const key = computed(() => messageKey(props.messageId, props.text))
const entry = computed(() => speech.entryFor(props.messageId, props.text))
const job = computed(() => speech.jobFor(props.messageId))
function retry(mode: SpeechMode) {
  speech.dismiss(props.messageId, props.text)
  void speech.speak(mode, props.messageId, props.text)
}
</script>
