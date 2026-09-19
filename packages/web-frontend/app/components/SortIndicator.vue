<template>
  <span class="inline-flex text-muted-foreground/50" :class="{ 'text-foreground': field === sortField }">
    <AppIcon
      v-if="field === sortField"
      :name="sortDirection === 'asc' ? 'chevronRight' : 'chevronDown'"
      size="sm"
      class="rotate-icon"
      :class="sortDirection === 'asc' ? '-rotate-90' : 'rotate-0'"
    />
    <AppIcon v-else name="chevronDown" size="sm" class="opacity-0 group-hover:opacity-40" />
  </span>
</template>

<script setup lang="ts">
defineProps<{
  field: string
  sortField: string
  sortDirection: 'asc' | 'desc'
}>()
</script>
