<template>
  <ChatCollapsibleCard
    icon="zap"
    :expanded="expandedInjections.has(index)"
    @toggle="toggleInjection(index)"
  >
    <template #header>
      <span class="font-medium">{{ msg.taskResultName ?? 'Background Task' }}</span>
      <span v-if="msg.taskResultDuration" class="ml-1 text-2xs text-muted-foreground/60">({{ msg.taskResultDuration }}min)</span>
    </template>
    <template #trailing>
      <span
        class="rounded px-1.5 py-0.5 text-2xs font-medium"
        :class="msg.taskResultStatus === 'failed'
          ? 'bg-destructive/10 text-destructive'
          : msg.taskResultStatus === 'question'
            ? 'bg-warning/10 text-warning'
            : 'bg-success/10 text-success'"
      >
        {{ msg.taskResultStatus === 'failed' ? 'Failed' : msg.taskResultStatus === 'question' ? 'Question' : 'Completed' }}
      </span>
    </template>
    <div class="max-h-60 overflow-y-auto px-3 py-2">
      <div class="prose-chat break-words text-xs text-foreground" v-html="renderMarkdown(taskResultVisibleBody(msg, index))" />
      <!-- The stream shows at most three lines; the full report
           stays in tasks.result_summary and is fetched on demand. -->
      <template v-if="msg.taskResultTruncated && msg.taskResultTaskId">
        <p v-if="taskReportError.get(index)" class="mt-2 text-2xs text-destructive" role="alert">{{ $t('chat.taskResult.loadFailed') }}</p>
        <p v-else-if="msg.taskResultFullLength" class="mt-2 text-2xs text-muted-foreground/70">
          {{ $t('chat.taskResult.truncated', { count: msg.taskResultFullLength }) }}
        </p>
        <button
          type="button"
          class="mt-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-2xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
          :disabled="taskReportLoading.has(index)"
          :aria-expanded="taskReports.has(index)"
          @click="toggleTaskReport(msg, index)"
        >
          <AppIcon v-if="taskReportLoading.has(index)" name="loader" class="h-3 w-3 motion-safe:animate-spin" />
          <AppIcon v-else :name="taskReports.has(index) ? 'chevronDown' : 'chevronRight'" class="h-3 w-3" />
          {{ taskReportLoading.has(index)
            ? $t('chat.taskResult.loading')
            : taskReports.has(index) ? $t('chat.taskResult.hideFull') : $t('chat.taskResult.showFull') }}
        </button>
      </template>
    </div>
  </ChatCollapsibleCard>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'

/** Task result notification: a collapsible card with the report preview, expandable to the full report. */
defineProps<{ msg: ChatMessage; index: number }>()

const { renderMarkdown } = useMarkdown()
const { expandedInjections: injections, taskReports: reports } = useChatView()
const { set: expandedInjections, toggle: toggleInjection } = injections
const { taskReports, taskReportLoading, taskReportError, taskResultVisibleBody, toggleTaskReport } = reports
</script>
