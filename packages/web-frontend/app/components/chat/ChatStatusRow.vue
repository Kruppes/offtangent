<template>
  <!-- Periodic task heartbeat (compact, non-collapsible progress row).
       Rendered as a subtle single line so the user can see a task
       is still making progress without the row looking like a
       completed-task card. -->
  <template v-if="msg.isTaskStatusUpdate">
    <div class="w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
      <div class="flex items-center gap-2">
        <AppIcon name="zap" class="h-3 w-3 shrink-0 opacity-60" />
        <span class="font-medium text-foreground/80">{{ msg.taskStatusUpdateName ?? 'Background Task' }}</span>
        <span class="ml-auto flex shrink-0 items-center gap-2 text-2xs text-muted-foreground/80">
          <span v-if="typeof msg.taskStatusRuntimeMinutes === 'number'">⏱ {{ msg.taskStatusRuntimeMinutes }}min</span>
          <span v-if="typeof msg.taskStatusToolCallCount === 'number'">• {{ msg.taskStatusToolCallCount }} tools</span>
          <span v-if="typeof msg.taskStatusTokensUsed === 'number'">• ~{{ formatTokenCount(msg.taskStatusTokensUsed) }} tok</span>
          <span class="rounded bg-warning/10 px-1.5 py-0.5 font-medium text-warning">Running</span>
        </span>
      </div>
    </div>
  </template>

  <!-- Provider stall notice. Backed by a persisted chat row, so it
       survives a reload; the same bubble flips to the resolved state
       in place when the provider recovers or the turn is aborted. -->
  <template v-else-if="msg.stallInfo">
    <div
      class="w-full overflow-hidden rounded-lg border px-3 py-1.5 text-xs"
      :class="msg.stallInfo.outcome === 'recovered'
        ? 'border-success/30 bg-success/5 text-muted-foreground'
        : msg.stallInfo.outcome === 'aborted'
          ? 'border-destructive/30 bg-destructive/5 text-muted-foreground'
          : 'border-warning/30 bg-warning/5 text-muted-foreground'"
    >
      <div class="flex items-center gap-2">
        <AppIcon
          :name="msg.stallInfo.outcome === 'recovered' ? 'check' : msg.stallInfo.outcome === 'aborted' ? 'warning' : 'clock'"
          class="h-3 w-3 shrink-0 opacity-70"
        />
        <span class="min-w-0 flex-1 break-words text-foreground/80">{{ msg.content }}</span>
        <span class="shrink-0 text-2xs text-muted-foreground/80">
          {{ formatStallDuration(msg.stallInfo.durationMs) }}
        </span>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'

/** One-line system rows: a running task's heartbeat, or a provider stall notice. */
defineProps<{ msg: ChatMessage }>()

// Compact token count for the heartbeat row: 12345 -> "12.3k".
function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
// Stall duration badge: 45000 -> "45s", 125000 -> "2m 5s".
function formatStallDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}
</script>
