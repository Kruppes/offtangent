<template>
  <!-- Periodic task heartbeat (compact, non-collapsible progress row).
       Rendered as a subtle single line so the user can see a task
       is still making progress without the row looking like a
       completed-task card. -->
  <template v-if="msg.isTaskStatusUpdate">
    <div class="w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
      <div class="flex items-center gap-2">
        <AppIcon name="zap" class="h-3 w-3 shrink-0" />
        <span class="font-medium text-foreground">{{ msg.taskStatusUpdateName ?? 'Background Task' }}</span>
        <span class="ml-auto flex shrink-0 items-center gap-2 text-2xs text-muted-foreground">
          <span v-if="typeof msg.taskStatusRuntimeMinutes === 'number'">⏱ {{ msg.taskStatusRuntimeMinutes }}min</span>
          <span v-if="typeof msg.taskStatusToolCallCount === 'number'">• {{ msg.taskStatusToolCallCount }} tools</span>
          <span v-if="typeof msg.taskStatusTokensUsed === 'number'">• ~{{ formatTokenCount(msg.taskStatusTokensUsed) }} tok</span>
          <span class="rounded bg-warning/10 px-2 py-1 font-medium text-warning">Running</span>
        </span>
      </div>
    </div>
  </template>

  <!-- Stall notice (no visible output for a while). Backed by a persisted
       chat row, so it survives a reload; the same bubble flips to the
       resolved state in place. Wording and tone come from stallInfo (see
       utils/stallNotice.ts): a pause is neutral, only an explicit abort or
       request error is styled as a failure. -->
  <template v-else-if="msg.stallInfo && stallView">
    <div
      class="w-full overflow-hidden rounded-lg border px-3 py-2 text-xs"
      :class="stallView.tone === 'failure'
        ? 'border-destructive/30 bg-destructive/5 text-muted-foreground'
        : stallView.tone === 'pending'
          ? 'border-warning/30 bg-warning/5 text-muted-foreground'
          : 'border-border bg-muted text-muted-foreground'"
    >
      <div class="flex items-center gap-2">
        <AppIcon
          :name="stallView.icon"
          class="h-3 w-3 shrink-0"
        />
        <span
          class="min-w-0 flex-1 break-words"
          :class="stallView.tone === 'neutral' ? 'text-muted-foreground' : 'text-foreground'"
        >{{ stallView.key ? $t(stallView.key) : msg.content }}</span>
        <span class="shrink-0 text-2xs text-muted-foreground">
          {{ formatStallDuration(msg.stallInfo.durationMs) }}
        </span>
      </div>
    </div>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessage } from '~/composables/useChat'
import { stallNoticePresentation } from '~/utils/stallNotice'

/** One-line system rows: a running task's heartbeat, or a stall notice. */
const props = defineProps<{ msg: ChatMessage }>()

const stallView = computed(() => props.msg.stallInfo ? stallNoticePresentation(props.msg.stallInfo) : null)

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
