<template>
  <!-- Docked in the slot of ChatMessageActions: read aloud, audio summary and
       — for a stored answer without one — "voice note". An existing voice
       note (also one made in the app) is shown in the bubble instead. -->
  <template v-if="ttsEnabled">
  <button
    v-for="action in actions"
    :key="action.mode"
    type="button"
    class="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary pointer-fine:min-h-8"
    :aria-pressed="entry?.mode === action.mode"
    :aria-busy="entry?.mode === action.mode && entry.status === 'loading' ? 'true' : undefined"
    :data-action="action.mode === 'read' ? 'read-aloud' : 'audio-summary'"
    @click.stop="speech.speak(action.mode, messageId, text)"
  >
    <AppIcon v-if="entry?.mode === action.mode && entry.status === 'loading'" name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
    <AppIcon v-else :name="action.icon" size="sm" />
    <span>{{ $t(action.label) }}</span>
  </button>
  <button
    v-if="canCreateNote"
    type="button"
    class="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:text-muted-foreground disabled:[&_svg]:text-border disabled:bg-muted pointer-fine:min-h-8"
    :disabled="job?.status === 'creating'"
    :aria-busy="job?.status === 'creating' ? 'true' : undefined"
    data-action="voice-note"
    @click.stop="speech.createVoiceNote(messageId!)"
  >
    <AppIcon v-if="job?.status === 'creating'" name="loader" size="sm" class="animate-spin motion-reduce:animate-none" />
    <AppIcon v-else name="mic" size="sm" />
    <span>{{ job?.status === 'creating' ? $t('w4b.speech.noteCreating') : $t('w4b.speech.note') }}</span>
  </button>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMessageSpeech, type SpeechMode } from '~/composables/useMessageSpeech'

const props = defineProps<{ messageId?: number; text: string; hasVoiceNote: boolean }>()
const speech = useMessageSpeech()
/** Same gate as the former read-aloud button: speech output configured on the server. */
const { ttsEnabled } = useTts()
const entry = computed(() => speech.entryFor(props.messageId, props.text))
const job = computed(() => speech.jobFor(props.messageId))
const canCreateNote = computed(() => typeof props.messageId === 'number' && !props.hasVoiceNote && !speech.voiceNoteFor(props.messageId))
const actions: Array<{ mode: SpeechMode; icon: string; label: string }> = [
  { mode: 'read', icon: 'volume', label: 'w4b.speech.read' },
  { mode: 'summary', icon: 'sparkles', label: 'w4b.speech.summary' },
]
</script>
