<template>
  <ChatCollapsibleCard
    :icon="toolIconName(toolData)"
    :expanded="expandedTools.set.value.has(toolData.toolCallId)"
    @toggle="expandedTools.toggle(toolData.toolCallId)"
  >
    <template #header>
      <span class="shrink-0 font-medium">{{ toolDisplayName(toolData) }}</span>
      <span
        v-if="toolSummary(toolData)"
        class="min-w-0 truncate font-mono text-muted-foreground"
        :title="toolSummary(toolData)!"
      >
        {{ toolSummary(toolData) }}
      </span>
    </template>
    <div>
      <div v-if="!isToolSkillLoad(toolData) && !hasMemoryView(toolData)" class="border-b border-border px-3 py-2"><p class="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Input</p><ToolDataDisplay :data="toolData.toolArgs" /></div>
      <template v-if="isEditFileTool(toolData) && getToolEdits(toolData) && getToolMemoryInfo(toolData).isMemoryFile">
        <div class="max-h-80 overflow-y-auto">
          <MemoryEditsDiff
            :edits="getToolEdits(toolData)!"
            :file-name="getToolMemoryFileName(toolData)"
          />
        </div>
      </template>
      <template v-else-if="getToolMemoryWriteContent(toolData) !== null">
        <div class="max-h-80 overflow-y-auto">
          <MemoryFileDiff
            before=""
            :after="getToolMemoryWriteContent(toolData)!"
            :file-name="getToolMemoryFileName(toolData)"
          />
        </div>
      </template>
      <div v-else class="max-h-80 overflow-y-auto px-3 py-2">
        <p class="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Output</p><ToolDataDisplay :data="toolData.toolResult" :is-error="toolData.toolIsError" />
      </div>
    </div>
  </ChatCollapsibleCard>
</template>

<script setup lang="ts">
import type { ToolCallData } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'
import { useToolPresentation } from '~/composables/chat/useToolPresentation'

/** One tool call inside a tool activity group: name, summary, input and output. */
defineProps<{ toolData: ToolCallData }>()

const { expandedTools } = useChatView()
const {
  isToolSkillLoad, getToolMemoryInfo, getToolEdits, getToolMemoryFileName, isEditFileTool,
  getToolMemoryWriteContent, hasMemoryView, toolDisplayName, toolSummary, toolIconName,
} = useToolPresentation()
</script>
