<template>
  <div v-if="edits.length > 0">
    <!-- Header row: file path + stats -->
    <div class="flex flex-wrap items-center gap-2 px-3 py-2">
      <Badge
        v-if="fileName"
        class="border-transparent bg-violet-500/15 font-mono text-[11px] text-violet-600 dark:text-violet-400"
      >
        {{ fileName }}
      </Badge>
      <Badge
        v-if="stats.added > 0"
        class="border-transparent bg-emerald-500/15 font-mono text-[11px] text-emerald-700 dark:text-emerald-300"
      >
        +{{ stats.added }}
      </Badge>
      <Badge
        v-if="stats.removed > 0"
        class="border-transparent bg-rose-500/15 font-mono text-[11px] text-rose-700 dark:text-rose-300"
      >
        -{{ stats.removed }}
      </Badge>
    </div>

    <!-- Diff blocks -->
    <div v-for="(edit, idx) in edits" :key="idx" :class="idx > 0 ? 'border-t border-border/40' : ''">
      <!-- Removed lines -->
      <div
        v-for="(line, li) in splitLines(edit.oldText)"
        :key="`r-${li}`"
        class="flex items-start gap-2.5 border-l-2 border-l-rose-500/60 bg-rose-500/10 px-3 py-1 font-mono text-[11px] leading-4 text-rose-700 dark:text-rose-300"
      >
        <span class="mt-px w-4 shrink-0 text-center font-semibold leading-4">-</span>
        <span class="min-w-0 whitespace-pre-wrap break-words">{{ line || ' ' }}</span>
      </div>

      <!-- Added lines -->
      <div
        v-for="(line, li) in splitLines(edit.newText)"
        :key="`a-${li}`"
        class="flex items-start gap-2.5 border-l-2 border-l-emerald-500/60 bg-emerald-500/10 px-3 py-1 font-mono text-[11px] leading-4 text-emerald-700 dark:text-emerald-300"
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
