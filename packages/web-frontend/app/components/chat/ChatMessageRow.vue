<template>
  <div
    class="group/msg"
    :id="typeof msg.id === 'number' && msg.role !== 'divider' ? `msg-${msg.id}` : undefined"
    :data-message-id="typeof msg.id === 'number' ? msg.id : undefined"
    :tabindex="typeof msg.id === 'number' ? -1 : undefined"
    :class="[
      // Mobile: messages fill the available width (minus avatar + gap
      // or the pl-11 offset for tool cards). On sm+ screens we cap them
      // so bubbles don't span edge-to-edge on wider viewports.
      msg.role === 'divider' ? 'w-full' : steps ? 'self-start w-full max-w-full pl-11 sm:max-w-[min(100%,max(75%,34rem))]' : (msg.role === 'tool' || (msg.role === 'system' && (msg.isTaskResult || msg.isTaskStatusUpdate || msg.stallInfo || msg.errorInfo || msg.picker || msg.chatAction)) || msg.isThinking) ? 'self-start w-full max-w-full sm:max-w-[75%] pl-11' : msg.role === 'assistant'
        // Answers keep their reading measure (~31rem of text) when the shell's
        // columns make the conversation narrow (two/three columns, W3).
        ? 'flex max-w-full gap-3 sm:max-w-[min(100%,max(75%,34rem))]'
        : 'flex max-w-full gap-3 sm:max-w-[75%]',
      {
        'self-end flex-row-reverse': msg.role === 'user',
        'self-start': msg.role === 'assistant' && !msg.isThinking,
        'self-center max-w-full sm:max-w-[85%]': msg.role === 'system' && !msg.isTaskResult && !msg.isTaskStatusUpdate && !msg.stallInfo && !msg.errorInfo && !msg.picker && !msg.chatAction,
        // A message carrying an interaction card spans the full column:
        // the card is a sibling of the bubble and needs the same width.
        'w-full': !!interactionCard(msg),
      },
    ]"
  >
    <ChatSessionDivider v-if="msg.role === 'divider'" :msg="msg" :index="index" />
    <!-- All tool calls and reasoning of a turn: ONE collapsed line (N4). -->
    <TurnLine v-else-if="steps" :steps="steps" :active="turnActive" :turn-end="turnEnd" :label-of="stepLabel">
      <template #tool="{ msg: toolMsg }">
        <ChatToolCall :tool-data="toolMsg.toolData!" />
      </template>
    </TurnLine>
    <ChatStatusRow v-else-if="msg.role === 'system' && (msg.isTaskStatusUpdate || msg.stallInfo)" :msg="msg" />
    <ChatTurnError v-else-if="msg.role === 'system' && msg.errorInfo" :msg="msg" />
    <ChatTaskResult v-else-if="msg.role === 'system' && msg.isTaskResult" :msg="msg" :index="index" />
    <ChatActionCard v-else-if="msg.role === 'system' && (msg.chatAction || msg.picker)" :msg="msg" />
    <ChatBubble v-else :msg="msg" :index="index" />
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import type { TranscriptRow } from '../content/transcript'
import { useChatView } from '~/composables/chat/chatViewContext'
import { useToolPresentation } from '~/composables/chat/useToolPresentation'
import TurnLine from '../content/TurnLine.vue'
import ChatSessionDivider from './ChatSessionDivider.vue'
import ChatToolCall from './ChatToolCall.vue'
import ChatStatusRow from './ChatStatusRow.vue'
import ChatTurnError from './ChatTurnError.vue'
import ChatTaskResult from './ChatTaskResult.vue'
import ChatActionCard from './ChatActionCard.vue'
import ChatBubble from './ChatBubble.vue'

/**
 * One transcript row. The row element carries the width and alignment of
 * its kind (full-width divider, indented cards, left/right bubbles); the
 * content is picked by kind, in the same order the checks always ran.
 */
defineProps<{ msg: ChatMessage; index: number; steps?: TranscriptRow['steps']; turnEnd?: string }>()

const { interactionCard, turnActive } = useChatView()
const { toolDisplayName } = useToolPresentation()
const stepLabel = (step: ChatMessage) => (step.toolData ? toolDisplayName(step.toolData) : '')
</script>
