<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { TooltipContent, TooltipPortal, type TooltipContentProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends TooltipContentProps {
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  sideOffset: 6,
  side: 'top',
})

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      v-bind="delegatedProps"
      :class="cn(
        'z-[9999] w-max max-w-[200px] rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md pointer-events-none',
        'data-[state=delayed-open]:animate-fade-in data-[state=closed]:animate-fade-out',
        props.class
      )"
    >
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
