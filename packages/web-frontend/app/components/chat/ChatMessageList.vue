<template>
  <div ref="messagesContainer" data-transcript-scroll class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown" @click="handleMarkdownCodeCopy">
    <TranscriptState :state="state" @retry="$emit('retry')">
      <OlderHistoryControl :state="olderState ?? 'end'" @load="$emit('loadOlder')" />
      <ChatMessageRow
        v-for="{ message: msg, index: i, key, steps, turnEnd } in rows"
        :key="key"
        :msg="msg"
        :index="i"
        :steps="steps"
        :turn-end="turnEnd"
      />
      <!-- The catch-up after a turn failed: the transcript may miss stored
           rows (files, ids). Not blocking, the chat keeps working. -->
      <div v-if="syncError" role="alert" class="flex flex-wrap items-center justify-center gap-3 rounded-md border border-border p-3 text-center text-sm text-muted-foreground" data-history-sync="error">
        <span>{{ $t('chat.historySyncError') }}</span>
        <button type="button" class="min-h-11 rounded-md border border-border px-4 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" @click="$emit('retrySync')">{{ $t('common.refresh') }}</button>
      </div>
    </TranscriptState>
  </div>
</template>

<script setup lang="ts">
import type { TranscriptRow, transcriptState } from '../content/transcript'
import { useChatView } from '~/composables/chat/chatViewContext'
import TranscriptState from '../content/TranscriptState.vue'
import type { OlderHistoryState } from '~/composables/useChat'
import ChatMessageRow from './ChatMessageRow.vue'
import OlderHistoryControl from './OlderHistoryControl.vue'

/**
 * The scrolling transcript: loading / empty / error state and one row per
 * transcript entry. The strand activity lives in the strand dock (W4c).
 */
defineProps<{ rows: TranscriptRow[]; state: ReturnType<typeof transcriptState>; olderState?: OlderHistoryState; syncError?: boolean }>()
defineEmits<{ retry: []; loadOlder: []; retrySync: [] }>()

const { scroll } = useChatView()
const { messagesContainer, onMessagesScroll } = scroll
const { handleCopyAsMarkdown, handleMarkdownCodeCopy } = useMarkdown()
</script>
