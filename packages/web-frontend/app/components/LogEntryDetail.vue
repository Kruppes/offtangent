<script setup lang="ts">
import type { LogEntry } from '~/composables/useLogs'
import { parseLogData, hasInputData } from '~/utils/logDataParsing'

const props = defineProps<{
  entry: LogEntry | null
  loading: boolean
}>()

const { t } = useI18n()
const { formatDuration } = useFormat()
const { isEntrySkillLoad, extractSkillContent } = useLogDisplay()

const showInput = computed(() => {
  if (!props.entry) return false
  if (!hasInputData(props.entry.input)) return false
  if (isEntrySkillLoad(props.entry)) return false
  // Hide raw input when a memory diff view is available (it's redundant)
  if (memoryEditsInfo.value || memoryFileDiff.value) return false
  return true
})

/** Extract filename from log entry input using shared utility */
function extractFileNameFromInput(input: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(input ?? '{}')
    return extractMemoryFileName(parsed)
  } catch { /* ignore */ }
  return null
}

/** Check if this is an edit_file on a memory file — render edits directly from input */
const memoryEditsInfo = computed<{ edits: Array<{ oldText: string; newText: string }>; fileName: string | null } | null>(() => {
  if (!props.entry) return null
  const toolName = props.entry.toolName
  if (toolName !== 'edit_file' && toolName !== 'Edit') return null

  try {
    const input = JSON.parse(props.entry.input ?? '{}')
    const filePath = input?.path ?? input?.file_path ?? ''
    if (!filePath.includes('/memory/')) return null

    const edits = input?.edits
    if (!Array.isArray(edits) || edits.length === 0) return null
    const valid = edits.every((e: unknown) => e && typeof e === 'object' && typeof (e as Record<string, unknown>).oldText === 'string' && typeof (e as Record<string, unknown>).newText === 'string')
    if (!valid) return null

    return { edits: edits as Array<{ oldText: string; newText: string }>, fileName: extractFileNameFromInput(props.entry.input) }
  } catch {
    return null
  }
})

/**
 * For `write_file` calls on memory files, render the new content as an
 * all-added diff. Surgical edits should use `edit_file`, which produces a
 * real before/after view from its `edits` arg — see `memoryEditsInfo` above.
 */
const memoryFileDiff = computed<{ before: string; after: string; fileName: string | null } | null>(() => {
  if (!props.entry) return null
  const toolName = props.entry.toolName
  if (toolName !== 'write_file' && toolName !== 'Write') return null

  const fileName = extractFileNameFromInput(props.entry.input)
  if (!fileName) return null

  try {
    const input = JSON.parse(props.entry.input ?? '{}')
    if (typeof input.content === 'string') {
      return { before: '', after: input.content, fileName }
    }
  } catch { /* ignore */ }

  return null
})

const showMemoryDiff = computed(() => memoryFileDiff.value !== null || memoryEditsInfo.value !== null)

const isSkillLoad = computed(() => {
  if (!props.entry) return false
  return isEntrySkillLoad(props.entry)
})
</script>

<template>
  <div class="border-t border-border bg-background px-5 pb-4 pt-3" @click.stop>
    <div v-if="loading" class="py-3 text-sm text-muted-foreground">
      {{ t('logs.loading') }}
    </div>

    <template v-else-if="entry">
      <!-- Input (hidden if empty or skill load) -->
      <div v-if="showInput" class="mb-3">
        <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('logs.input') }}
        </h4>
        <div class="oa-scrollbar max-h-[200px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug">
          <ToolDataDisplay :data="parseLogData(entry.input)" />
        </div>
      </div>

      <!-- Output -->
      <div class="mb-3">
        <h4 v-if="!showMemoryDiff" class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {{ t('logs.output') }}
        </h4>
        <!-- Memory diffs: edge-to-edge inside a single border container -->
        <div
          v-if="memoryEditsInfo || memoryFileDiff"
          class="oa-scrollbar max-h-[420px] overflow-y-auto overflow-x-hidden rounded-md border border-border bg-muted/50 text-xs leading-snug"
        >
          <template v-if="memoryEditsInfo">
            <MemoryEditsDiff
              :edits="memoryEditsInfo.edits"
              :file-name="memoryEditsInfo.fileName ?? undefined"
            />
          </template>
          <template v-else-if="memoryFileDiff">
            <MemoryFileDiff
              :before="memoryFileDiff.before"
              :after="memoryFileDiff.after"
              :file-name="memoryFileDiff.fileName ?? undefined"
            />
          </template>
        </div>
        <!-- Standard output -->
        <div
          v-else
          class="oa-scrollbar max-h-[300px] overflow-y-auto rounded-md border border-border bg-muted/50 p-3 text-xs leading-snug"
        >
          <template v-if="isSkillLoad">
            <pre class="whitespace-pre-wrap break-all text-foreground">{{ extractSkillContent(entry.output) ?? '' }}</pre>
          </template>
          <template v-else>
            <ToolDataDisplay :data="parseLogData(entry.output)" :is-error="entry.status === 'error'" />
          </template>
        </div>
      </div>

      <!-- Meta row -->
      <div class="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>{{ t('logs.sessionId') }}: {{ entry.sessionId }}</span>
        <span>{{ t('logs.duration') }}: {{ formatDuration(entry.durationMs) }}</span>
        <span>{{ t('logs.status') }}: {{ entry.status }}</span>
      </div>
    </template>
  </div>
</template>
