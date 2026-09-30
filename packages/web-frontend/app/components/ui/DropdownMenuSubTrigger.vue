<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { DropdownMenuSubTrigger, type DropdownMenuSubTriggerProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends DropdownMenuSubTriggerProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <DropdownMenuSubTrigger
    v-bind="delegatedProps"
    :class="cn(
      'flex w-full cursor-default select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors',
      'focus:bg-accent focus:text-accent-foreground',
      'data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
      props.class
    )"
  >
    <slot />
    <AppIcon name="chevronRight" size="sm" class="ml-auto text-muted-foreground" />
  </DropdownMenuSubTrigger>
</template>
