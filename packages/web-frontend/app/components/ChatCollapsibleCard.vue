<template>
  <div class="w-full overflow-hidden rounded-lg border border-border">
    <button
      class="group flex w-full items-center gap-2 bg-card px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
      :class="{ 'border-b border-border': expanded }"
      @click="$emit('toggle')"
    >
      <AppIcon :name="icon" class="h-3 w-3 shrink-0" :class="iconClass ?? ''" />
      <slot name="header" />
      <span class="flex-1" />
      <slot name="trailing" />
      <AppIcon
        :name="expanded ? 'chevronDown' : 'chevronRight'"
        class="h-3 w-3 shrink-0"
      />
    </button>
    <div v-if="expanded" class="bg-background text-xs">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon: string
  iconClass?: string
  expanded: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>
