<script setup lang="ts">
import type { LogEntry } from '~/composables/useLogs'
import { parseInputParams } from '~/utils/logDataParsing'

const props = defineProps<{
  entry: LogEntry
  expanded: boolean
}>()

defineEmits<{
  (e: 'toggle'): void
}>()

const {
  isEntrySkillLoad,
  entryDisplayName,
  isTaskSession,
  getSourceLabel,
  toolBadgeClass,
  toolIcon,
  getSkillName,
} = useLogDisplay()

const { formatTimestamp, formatDuration } = useFormat()

const displayName = computed(() => entryDisplayName(props.entry))
const skillLoad = computed(() => isEntrySkillLoad(props.entry))
</script>

<template>
  <div class="flex items-center gap-3 px-5 py-2.5 text-sm" @click="$emit('toggle')">
    <!-- Timestamp -->
    <span class="w-[150px] shrink-0 whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
      {{ formatTimestamp(entry.timestamp) }}
    </span>

    <!-- Tool badge -->
    <Badge
      :class="toolBadgeClass(displayName)"
      class="h-[22px] shrink-0 gap-1 px-2 py-0 font-mono text-[11px] leading-none"
    >
      <AppIcon :name="toolIcon(displayName)" class="h-3 w-3" />
      {{ displayName }}
    </Badge>

    <!-- Source badge (only for task sessions) -->
    <Badge
      v-if="isTaskSession(entry)"
      class="hidden h-[22px] shrink-0 border-transparent bg-amber-500/15 px-2 py-0 text-[11px] leading-none text-amber-600 sm:inline-flex dark:text-amber-400"
    >
      {{ getSourceLabel(entry) }}
    </Badge>

    <!-- Input preview as badges (hidden on small screens) -->
    <div class="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden sm:flex">
      <template v-if="skillLoad">
        <span class="inline-flex h-[22px] shrink-0 items-center gap-1 rounded bg-violet-500/15 px-1.5 font-mono text-[11px] leading-none text-violet-600 dark:text-violet-400">
          <span class="font-medium">{{ getSkillName(entry.input) }}</span>
        </span>
      </template>
      <template v-else>
        <template v-for="(value, key) in parseInputParams(entry.input)" :key="key">
          <span class="inline-flex h-[22px] shrink-0 items-center gap-1 rounded bg-muted px-1.5 font-mono text-[11px] leading-none text-muted-foreground">
            <span class="font-medium">{{ key }}</span>
            <span class="max-w-[200px] truncate opacity-70">{{ value }}</span>
          </span>
        </template>
      </template>
    </div>

    <!-- Duration -->
    <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
      {{ formatDuration(entry.durationMs) }}
    </span>

    <!-- Status icon -->
    <span class="flex w-5 shrink-0 items-center justify-center">
      <AppIcon
        :name="entry.status === 'success' ? 'success' : 'warning'"
        class="h-4 w-4"
        :class="entry.status === 'success' ? 'text-success' : 'text-destructive'"
      />
    </span>

    <!-- Expand chevron -->
    <span class="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
      <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" class="h-4 w-4" />
    </span>
  </div>
</template>
