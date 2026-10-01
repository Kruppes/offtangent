<template>
  <div class="w-full overflow-hidden rounded-lg border border-destructive/40 bg-destructive/5">
    <div class="flex items-center gap-2 border-b border-destructive/20 px-3 py-1.5 text-xs">
      <AppIcon name="warning" class="h-3 w-3 shrink-0 text-destructive" />
      <span class="font-medium text-destructive">{{ $t('chat.turnError') }}</span>
      <span v-if="msg.errorInfo!.attempts > 0" class="ml-auto shrink-0 text-[10px] text-muted-foreground/80">
        {{ $t('chat.turnErrorRetried', { count: msg.errorInfo!.attempts }) }}
      </span>
    </div>
    <div class="whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground/90">{{ msg.content }}</div>
    <!-- Manual retry. Answered by the backend against the persisted
         error row, so it survives a reload and disables itself once
         the conversation moved on. -->
    <template v-if="msg.chatAction">
      <div
        v-if="msg.chatAction.resolution"
        class="border-t border-destructive/20 px-3 py-2 text-xs text-muted-foreground"
      >{{ msg.chatAction.resolution }}</div>
      <div v-else class="flex flex-wrap gap-1.5 border-t border-destructive/20 p-1.5">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-md border border-primary/30 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="pendingChatActions.has(msg.chatAction.messageId)"
          @click="handleChatAction(msg.chatAction!.messageId, 'retry')"
        >
          <AppIcon name="refresh" class="h-3 w-3 shrink-0" />
          {{ $t('chat.turnErrorRetry') }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'

/**
 * Terminal turn error. Backed by a persisted chat row (full provider text
 * included), so the failure is still visible after a reload instead of the
 * turn dying silently.
 */
defineProps<{ msg: ChatMessage }>()

const { pendingChatActions, handleChatAction } = useChatView()
</script>
