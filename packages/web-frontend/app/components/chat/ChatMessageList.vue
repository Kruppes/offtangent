<template>
  <div ref="messagesContainer" data-transcript-scroll class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown" @click="handleMarkdownCodeCopy">
    <TranscriptState :state="state" @retry="$emit('retry')">
      <ChatMessageRow
        v-for="{ message: msg, index: i, key, steps, turnEnd } in rows"
        :key="key"
        :msg="msg"
        :index="i"
        :steps="steps"
        :turn-end="turnEnd"
      />
    </TranscriptState>
  </div>
</template>

<script setup lang="ts">
import type { TranscriptRow, transcriptState } from '../content/transcript'
import { useChatView } from '~/composables/chat/chatViewContext'
import TranscriptState from '../content/TranscriptState.vue'
import ChatMessageRow from './ChatMessageRow.vue'

/**
 * The scrolling transcript: loading / empty / error state and one row per
 * transcript entry. The strand activity lives in the strand dock (W4c).
 */
defineProps<{ rows: TranscriptRow[]; state: ReturnType<typeof transcriptState> }>()
defineEmits<{ retry: [] }>()

const { scroll } = useChatView()
const { messagesContainer, onMessagesScroll } = scroll
const { handleCopyAsMarkdown, handleMarkdownCodeCopy } = useMarkdown()
</script>
