<template>
  <!-- Interactive action message (e.g. an email waiting for approval).
       Buttons post to /api/chat/actions; once decided — here or in any
       other channel — they are replaced by the result line. -->
  <template v-if="msg.chatAction">
    <div class="w-full overflow-hidden rounded-lg border border-border bg-card">
      <div class="whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground">{{ msg.chatAction.text }}</div>
      <div
        v-if="msg.chatAction.resolution"
        class="border-t border-border px-3 py-2 text-xs text-muted-foreground"
      >{{ msg.chatAction.resolution }}</div>
      <div v-else class="flex flex-wrap gap-2 border-t border-border p-2">
        <button
          v-for="action in msg.chatAction.actions"
          :key="action.actionId"
          type="button"
          class="rounded-md border px-2 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-muted-foreground disabled:[&_svg]:text-border"
          :class="action.style === 'danger'
            ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
            : 'border-primary text-primary hover:bg-primary-subtle'"
          :disabled="pendingChatActions.has(msg.chatAction.messageId)"
          @click="handleChatAction(msg.chatAction!.messageId, action.actionId)"
        >{{ action.label }}</button>
      </div>
    </div>
  </template>

  <!-- Slash-command picker (e.g. /model). Renders the title +
       description plus a button group; clicking a button sends the
       option's verbatim slash command back to the server, which
       re-dispatches it through the registry to produce the next
       picker (or final confirmation). -->
  <template v-else-if="msg.picker">
    <div class="w-full overflow-hidden rounded-lg border border-border bg-card">
      <div v-if="msg.picker.title || msg.picker.description" class="border-b border-border px-3 py-2 text-xs">
        <p v-if="msg.picker.title" class="font-medium text-foreground">{{ msg.picker.title }}</p>
        <p v-if="msg.picker.description" class="mt-1 text-muted-foreground">{{ msg.picker.description }}</p>
      </div>
      <div class="flex flex-col gap-1 p-2">
        <button
          v-for="opt in msg.picker.options"
          :key="opt.command"
          type="button"
          class="group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left text-xs transition-colors"
          :class="msg.pickerResolvedCommand
            ? (opt.command === msg.pickerResolvedCommand
                ? 'border-primary bg-primary-subtle text-foreground'
                : 'cursor-not-allowed text-muted-foreground')
            : 'text-foreground hover:border-border hover:bg-muted'"
          :disabled="!!msg.pickerResolvedCommand"
          @click="handlePickerSelect(msg, opt.command)"
        >
          <span class="min-w-0 flex-1 truncate font-medium">{{ opt.label }}</span>
          <span
            v-if="opt.description"
            class="shrink-0 truncate text-2xs text-muted-foreground"
          >{{ opt.description }}</span>
          <span
            v-if="opt.badge"
            class="shrink-0 rounded px-2 py-1 text-2xs font-medium"
            :class="opt.badge === 'active'
              ? 'bg-success/10 text-success'
              : opt.badge === 'error'
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground'"
          >{{ opt.badge }}</span>
          <AppIcon
            v-if="opt.command === msg.pickerResolvedCommand"
            name="check"
            class="h-3 w-3 shrink-0 text-primary"
          />
        </button>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'

/** Interactive system cards: an action waiting for a decision, or a slash-command picker. */
defineProps<{ msg: ChatMessage }>()

const { pendingChatActions, handleChatAction, handlePickerSelect } = useChatView()
</script>
