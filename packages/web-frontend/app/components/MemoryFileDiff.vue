<template>
  <div v-if="hasDiff">
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

    <!-- Diff lines -->
    <template v-for="(line, index) in diffLines" :key="`${line.type}-${index}-${line.content}`">
      <div
        v-if="line.type === 'separator'"
        class="border-y border-border/60 bg-muted/40 px-3 py-1 text-center font-mono text-[10px] text-muted-foreground"
      >
        … {{ t('logs.unchangedLines', { count: line.count ?? 0 }) }} …
      </div>

      <div
        v-else
        class="flex items-start gap-2.5 px-3 py-1 font-mono text-[11px] leading-4"
        :class="lineClass(line.type)"
      >
        <span class="mt-px w-4 shrink-0 text-center font-semibold leading-4">
          {{ linePrefix(line.type) }}
        </span>
        <span class="min-w-0 whitespace-pre-wrap break-words">{{ line.content || ' ' }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
type DiffLineType = 'context' | 'added' | 'removed' | 'separator'

interface DiffLine {
  type: DiffLineType
  content: string
  count?: number
}

const props = defineProps<{
  before: string
  after: string
  fileName?: string
}>()

const { t } = useI18n()

const diffLines = computed<DiffLine[]>(() => {
  const beforeLines = splitLines(props.before)
  const afterLines = splitLines(props.after)
  return collapseContext(buildLineDiff(beforeLines, afterLines))
})

const hasDiff = computed(() => diffLines.value.length > 0)

const stats = computed(() => ({
  added: diffLines.value.filter(line => line.type === 'added').length,
  removed: diffLines.value.filter(line => line.type === 'removed').length,
}))

function splitLines(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n+$/g, '')

  return normalized ? normalized.split('\n') : []
}

function buildLineDiff(beforeLines: string[], afterLines: string[]): DiffLine[] {
  const beforeCount = beforeLines.length
  const afterCount = afterLines.length
  const lcs = Array.from({ length: beforeCount + 1 }, () => Array<number>(afterCount + 1).fill(0))

  for (let beforeIndex = beforeCount - 1; beforeIndex >= 0; beforeIndex--) {
    for (let afterIndex = afterCount - 1; afterIndex >= 0; afterIndex--) {
      lcs[beforeIndex]![afterIndex] = beforeLines[beforeIndex] === afterLines[afterIndex]
        ? lcs[beforeIndex + 1]![afterIndex + 1]! + 1
        : Math.max(lcs[beforeIndex + 1]![afterIndex]!, lcs[beforeIndex]![afterIndex + 1]!)
    }
  }

  const diff: DiffLine[] = []
  let beforeIndex = 0
  let afterIndex = 0

  while (beforeIndex < beforeCount && afterIndex < afterCount) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      diff.push({ type: 'context', content: beforeLines[beforeIndex]! })
      beforeIndex++
      afterIndex++
      continue
    }

    if (lcs[beforeIndex + 1]![afterIndex]! >= lcs[beforeIndex]![afterIndex + 1]!) {
      diff.push({ type: 'removed', content: beforeLines[beforeIndex]! })
      beforeIndex++
      continue
    }

    diff.push({ type: 'added', content: afterLines[afterIndex]! })
    afterIndex++
  }

  while (beforeIndex < beforeCount) {
    diff.push({ type: 'removed', content: beforeLines[beforeIndex]! })
    beforeIndex++
  }

  while (afterIndex < afterCount) {
    diff.push({ type: 'added', content: afterLines[afterIndex]! })
    afterIndex++
  }

  return diff
}

function collapseContext(lines: DiffLine[]): DiffLine[] {
  const collapsed: DiffLine[] = []
  let index = 0

  while (index < lines.length) {
    const current = lines[index]!
    if (current.type !== 'context') {
      collapsed.push(current)
      index++
      continue
    }

    let end = index
    while (end < lines.length && lines[end]!.type === 'context') {
      end++
    }

    const contextBlock = lines.slice(index, end)
    if (contextBlock.length <= 4) {
      collapsed.push(...contextBlock)
    } else {
      collapsed.push(...contextBlock.slice(0, 2))
      collapsed.push({
        type: 'separator',
        content: '',
        count: contextBlock.length - 4,
      })
      collapsed.push(...contextBlock.slice(-2))
    }

    index = end
  }

  return collapsed
}

function linePrefix(type: DiffLineType): string {
  if (type === 'added') return '+'
  if (type === 'removed') return '-'
  return ' '
}

function lineClass(type: DiffLineType): string {
  if (type === 'added') {
    return 'border-l-2 border-l-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (type === 'removed') {
    return 'border-l-2 border-l-rose-500/60 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  }
  return 'text-muted-foreground'
}
</script>
