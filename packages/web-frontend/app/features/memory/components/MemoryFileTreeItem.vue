<script setup lang="ts">
import type { MemoryTreeNode } from '~/api/memory'

const props = defineProps<{
  node: MemoryTreeNode
  selectedPath: string | null
  depth?: number
  forceOpen?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', path: string): void
}>()

const depth = computed(() => props.depth ?? 0)
const open = ref(false)
const isOpen = computed(() => props.forceOpen || open.value)
</script>

<template>
  <div>
    <template v-if="node.type === 'dir'">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
        :style="{ paddingLeft: `${10 + depth * 14}px` }"
        @click="open = !open"
      >
        <AppIcon :name="isOpen ? 'chevronDown' : 'chevronRight'" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <AppIcon name="folder" class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ node.name }}</span>
      </button>
      <template v-if="isOpen">
        <MemoryFileTreeItem
          v-for="child in node.children"
          :key="child.path"
          :node="child"
          :selected-path="selectedPath"
          :depth="depth + 1"
          :force-open="forceOpen"
          @select="emit('select', $event)"
        />
      </template>
    </template>

    <button
      v-else
      type="button"
      class="flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
      :class="selectedPath === node.path ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80'"
      :style="{ paddingLeft: `${10 + depth * 14 + 18}px` }"
      @click="emit('select', node.path)"
    >
      <AppIcon name="file" class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="truncate">{{ node.name }}</span>
    </button>
  </div>
</template>
