<template>
  <div v-if="edits.length > 0">
    <!-- Header row: file path + stats -->
    <div class="flex flex-wrap items-center gap-2 px-3 py-2">
      <Badge
        v-if="fileName"
        class="border-transparent bg-tertiary/15 font-mono text-2xs text-tertiary"
      >
        {{ fileName }}
      </Badge>
      <Badge
        v-if="stats.added > 0"
        class="border-transparent bg-success/15 font-mono text-2xs text-success"
      >
        +{{ stats.added }}
      </Badge>
      <Badge
        v-if="stats.removed > 0"
        class="border-transparent bg-destructive/15 font-mono text-2xs text-destructive"
      >
        -{{ stats.removed }}
      </Badge>
    </div>

    <!-- Diff blocks -->
    <div v-for="(edit, idx) in edits" :key="idx" :class="idx > 0 ? 'border-t border-border' : ''">
      <!-- Removed lines -->
      <div
        v-for="(line, li) in splitLines(edit.oldText)"
        :key="`r-${li}`"
        class="flex items-start gap-2 border-l-2 border-l-destructive/60 bg-destructive/10 px-3 py-1 font-mono text-2xs leading-4 text-destructive"
      >
        <span class="mt-px w-4 shrink-0 text-center font-semibold leading-4">-</span>
        <span class="min-w-0 whitespace-pre-wrap break-words">{{ line || ' ' }}</span>
      </div>

      <!-- Added lines -->
      <div
        v-for="(line, li) in splitLines(edit.newText)"
        :key="`a-${li}`"
        class="flex items-start gap-2 border-l-2 border-l-success/60 bg-success/10 px-3 py-1 font-mono text-2xs leading-4 text-success"
      >
        <span class="mt-px w-4 shrink-0 text-center font-semibold leading-4">+</span>
        <span class="min-w-0 whitespace-pre-wrap break-words">{{ line || ' ' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  edits: Array<{ oldText: string; newText: string }>
  fileName?: string
}>()

const stats = computed(() => {
  let added = 0
  let removed = 0
  for (const edit of props.edits) {
    removed += splitLines(edit.oldText).length
    added += splitLines(edit.newText).length
  }
  return { added, removed }
})

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '')
  return normalized ? normalized.split('\n') : ['']
}
</script>
