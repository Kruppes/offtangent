<template>
  <div class="shrink-0 border-t border-border bg-background p-3">
    <!-- The turn queue is global: a thread can wait behind another persona's
         turn, so the position is shown right above the composer. -->
    <div v-if="queuePosition !== null" class="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AppIcon name="clock" class="h-3.5 w-3.5 shrink-0" />
      <span>{{ $t('threads.queuedWithPosition', { position: queuePosition }) }}</span>
    </div>
    <form class="relative flex flex-col gap-2" data-testid="composer" @submit.prevent="handleSend" @keydown="handleComposerAreaKeydown">
      <ChatSkillAutocomplete
        v-if="skillAutocomplete.active.value"
        :suggestions="skillAutocomplete.suggestions.value"
        :selected-index="skillAutocomplete.selectedIndex.value"
        @select="handleSkillSelect"
        @hover="skillAutocomplete.selectedIndex.value = $event"
      />
      <!-- Dictation: recording / transcribing / error, above the input field -->
      <DictationBar
        v-if="sttEnabled && dictationPhase !== 'idle'"
        :phase="dictationPhase"
        :elapsed-ms="dictationElapsed"
        :levels="dictationLevels"
        :error="dictationError"
        :can-retry="dictationCanRetry"
        :bars="DICTATION_LEVEL_BARS"
        @cancel="cancelDictation"
        @finish="finishDictation"
        @retry="retryDictation"
        @dismiss="dismissDictation"
      />
      <p class="sr-only" aria-live="polite">{{ dictationAnnouncement }}</p>
      <!-- Kept dictation recordings, sent with the message -->
      <div v-if="pendingAudio.length" class="flex flex-wrap gap-2">
        <ComposerAudioChip
          v-for="(item, index) in pendingAudio"
          :key="item.attachment.relativePath"
          :attachment="item.attachment"
          :index="index + 1"
          :duration-ms="item.durationMs"
          @remove="removePendingAudio(index)"
        />
      </div>
      <!-- Pending files row -->
      <div v-if="pendingFiles.length" class="flex flex-wrap gap-2">
        <div
          v-for="(file, index) in pendingFiles"
          :key="`${file.name}-${index}`"
          class="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs"
        >
          <span>{{ file.name }}</span>
          <button type="button" class="text-muted-foreground hover:text-foreground" @click="removePendingFile(index)">×</button>
        </div>
      </div>

      <div class="flex items-end gap-2">
        <!-- ── Composer box ────────────────────────────────────────────────
             Brain button (left, admin-only) | Textarea | Paperclip (right)
             Buttons use mb-[7px] so they sit centered against the
             single-line textarea height of 42px: (42-28)/2 = 7px -->
        <div class="flex flex-1 items-end rounded-xl border border-input bg-background px-1 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <!-- Thinking-level / Brain button (left inside box, admin-only) -->
          <ChatThinkingLevelPicker v-if="isAdmin" />

          <!-- Textarea -->
          <textarea
            ref="inputRef"
            v-model="inputText"
            class="min-h-[42px] max-h-[150px] flex-1 resize-none bg-transparent py-2.5 pr-1 text-sm outline-none placeholder:text-muted-foreground"
            :class="isAdmin ? 'pl-2' : 'pl-3'"
            :placeholder="$t('chat.placeholder')"
            rows="1"
            @keydown="handleComposerKeydown"
            @input="autoResize"
          />

          <!-- File attachment button (right inside box) -->
          <label class="mb-[7px] flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
            <input class="hidden" type="file" multiple @change="handleFileSelection">
            <AppIcon name="paperclip" class="h-4 w-4" />
          </label>
        </div>

        <!-- ── Mic button ─────────────────────────────────────────────────
             Always shown when STT is on: a dictation is inserted into the
             field (never sent), so a second dictation must stay reachable
             while text is present, on mobile too. -->
        <button
          v-if="sttEnabled"
          type="button"
          data-testid="dictation-mic"
          class="h-[42px] w-[42px] shrink-0 select-none items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11 max-sm:w-11"
          :class="[
            'inline-flex',
            dictationPhase === 'recording' || dictationPhase === 'starting'
              ? 'border-destructive bg-destructive/10 text-destructive'
              : dictationPhase === 'transcribing'
                ? 'border-primary bg-primary/10 text-primary'
                : dictationPhase === 'error'
                  ? 'border-destructive text-destructive'
                  : 'border-input text-muted-foreground hover:bg-muted',
          ]"
          :title="micLabel"
          :aria-label="micLabel"
          :aria-pressed="dictationPhase === 'recording'"
          :disabled="dictationPhase === 'transcribing' || dictationPhase === 'starting'"
          @click="toggleDictation"
        >
          <AppIcon v-if="dictationPhase === 'transcribing'" name="loader" class="h-4 w-4 motion-safe:animate-spin" />
          <AppIcon v-else-if="dictationPhase === 'recording'" name="square" class="h-4 w-4" />
          <AppIcon v-else name="mic" class="h-4 w-4" />
        </button>

        <!-- ── Send button ─────────────────────────────────────────────────
             Mobile: icon-only square button, shown when text is present
             (or when STT is disabled — then always visible as sole action).
             Desktop (sm+): text label, always shown alongside the mic. -->
        <Button
          type="submit"
          :disabled="!hasText || connectionStatus !== 'connected'"
          class="h-[42px] w-[42px] shrink-0 rounded-xl p-0 sm:w-auto sm:px-4"
          :class="(!hasText && sttEnabled) ? 'hidden sm:inline-flex' : 'inline-flex'"
        >
          <AppIcon name="send" class="h-4 w-4 sm:hidden" />
          <span class="hidden sm:inline">{{ $t('chat.send') }}</span>
        </Button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import type { LoadableSkill } from '~/composables/useSkillAutocomplete'
import { useChatView } from '~/composables/chat/chatViewContext'
import { DICTATION_LEVEL_BARS, useComposerDictation } from '~/composables/chat/useComposerDictation'
import { provideCommand } from '~/composables/useShellCommands'
import ChatThinkingLevelPicker from './ChatThinkingLevelPicker.vue'

/**
 * The composer: queue position, skill autocomplete, dictation bar, pending
 * recordings and files, the input box (thinking level, textarea, paperclip),
 * mic and send. A dictation is inserted at the caret, never sent.
 */
const { t } = useI18n()
const { draft, stt, isAdmin, connectionStatus, queuePosition, sendMessage } = useChatView()
const { inputText, pendingFiles, pendingAudio, inputRef, hasText, removePendingFile, removePendingAudio, autoResize } = draft
const {
  phase: dictationPhase, error: dictationError, canRetry: dictationCanRetry, elapsedMs: dictationElapsed, levels: dictationLevels, sttEnabled,
} = stt
const {
  announcement: dictationAnnouncement, micLabel, finish: finishDictation, retry: retryDictation,
  cancel: cancelDictation, dismiss: dismissDictation, toggle: toggleDictation, handleComposerAreaKeydown,
} = useComposerDictation(draft, stt, t)

// The command palette can start a dictation while this composer is on screen.
provideCommand('dictation.start', async () => { inputRef.value?.focus(); await toggleDictation() }, () => sttEnabled.value && (dictationPhase.value === 'idle' || dictationPhase.value === 'error'))

const skillAutocomplete = useSkillAutocomplete(inputText)

function handleSkillSelect(skill: LoadableSkill) {
  skillAutocomplete.select(skill)
  inputRef.value?.focus()
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (skillAutocomplete.handleKeydown(event)) return
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    event.preventDefault()
    void handleSend()
  }
}

async function handleSend() {
  const files = [...pendingFiles.value]
  const stored = pendingAudio.value.map(item => item.attachment)
  const text = inputText.value
  if ((!text.trim() && files.length === 0 && stored.length === 0) || connectionStatus.value !== 'connected') return
  await sendMessage(text, files, stored)
  draft.clear()
}

function handleFileSelection(event: Event) {
  const target = event.target as HTMLInputElement
  draft.addFiles(Array.from(target.files || []))
  target.value = ''
}
</script>
