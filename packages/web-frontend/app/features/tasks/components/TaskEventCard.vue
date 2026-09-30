<template>
  <div class="rounded-lg border border-border bg-card">
    <component
      :is="collapsible ? 'button' : 'div'"
      class="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm"
      :class="collapsible && 'transition-colors hover:bg-muted/50'"
      @click="collapsible && $emit('toggle')"
    >
      <AppIcon :name="icon" size="sm" class="shrink-0" :class="iconClass ?? 'text-muted-foreground'" />
      <slot name="header" />
      <span class="flex-1" />
      <span v-if="meta || timestamp" class="shrink-0 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
        <template v-if="meta">{{ meta }}</template>
        <span v-if="meta && timestamp" class="mx-1.5 opacity-50">·</span>
        <template v-if="timestamp">{{ timestamp }}</template>
      </span>
      <AppIcon
        v-if="collapsible"
        :name="expanded ? 'chevronDown' : 'chevronRight'"
        size="sm"
        class="shrink-0 text-muted-foreground"
      />
      <!-- Keeps the timestamp column aligned with collapsible cards -->
      <span v-else class="w-3.5 shrink-0" aria-hidden="true" />
    </component>

    <div v-if="showBody" class="px-4 pb-3 sm:pl-10.5">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  icon: string
  iconClass?: string
  timestamp?: string
  meta?: string
  collapsible?: boolean
  expanded?: boolean
}>()

defineEmits<{
  toggle: []
}>()

const slots = useSlots()
const showBody = computed(() => Boolean(slots.default) && (!props.collapsible || props.expanded))
</script>
