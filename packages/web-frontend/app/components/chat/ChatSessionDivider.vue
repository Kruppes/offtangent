<template>
    <!-- Collapsible summary card -->
    <div v-if="msg.content && showSessionSummaries" class="w-full max-w-none px-2 mb-1">
      <div class="mx-auto max-w-lg">
        <button
          class="group flex w-full items-center gap-2 rounded-t-lg border border-border bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
          :class="{ 'rounded-b-lg': !expandedSummaries.has(String(msg.id ?? index)) }"
          @click="toggleSummary(String(msg.id ?? index))"
        >
          <AppIcon name="file" size="sm" class="h-3 w-3 shrink-0" />
          <span class="font-medium">{{ $t('chat.sessionSummary') }}</span>
          <span class="flex-1" />
          <AppIcon
            :name="expandedSummaries.has(String(msg.id ?? index)) ? 'chevronDown' : 'chevronRight'"
            class="h-3 w-3 shrink-0"
          />
        </button>
        <div
          v-if="expandedSummaries.has(String(msg.id ?? index))"
          class="rounded-b-lg border border-t-0 border-border bg-card px-4 py-3"
        >
          <p class="text-xs leading-5 text-muted-foreground">
            {{ msg.content }}
          </p>
        </div>
      </div>
    </div>
    <!-- New Session divider line (always visible) -->
    <div class="w-full max-w-none px-2">
      <div class="relative flex items-center py-2">
        <div class="grow border-t border-border" />
        <div class="mx-4 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <AppIcon name="sparkles" class="h-3 w-3" />
          <span>{{ $t('chat.newSessionDivider') }}</span>
        </div>
        <div class="grow border-t border-border" />
      </div>
    </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'

/** "New session" divider, with the collapsible session summary above it when summaries are shown. */
defineProps<{ msg: ChatMessage; index: number }>()

const { filters, expandedSummaries: summaries } = useChatView()
const { showSessionSummaries } = filters
const { set: expandedSummaries, toggle: toggleSummary } = summaries
</script>
