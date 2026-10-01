<template>
    <ChatCollapsibleCard
      icon="sparkles"
      :expanded="expandedThinking.has(String(msg.id ?? index))"
      @toggle="toggleThinking(String(msg.id ?? index))"
    >
      <template #header>
        <span class="font-medium">{{ $t('chat.thinking') }}</span>
        <span v-if="msg.streaming" class="ml-2 inline-flex items-center gap-1">
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
          <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
        </span>
      </template>
      <div class="max-h-80 overflow-y-auto px-3 py-2">
        <p class="whitespace-pre-wrap break-words text-muted-foreground">{{ msg.content }}</p>
      </div>
    </ChatCollapsibleCard>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'

/** A thinking block: collapsed by default, expandable per message. */
defineProps<{ msg: ChatMessage; index: number }>()

const { set: expandedThinking, toggle: toggleThinking } = useChatView().expandedThinking
</script>
