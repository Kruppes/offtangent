<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import {
  PopoverContent,
  PopoverPortal,
  type PopoverContentEmits,
  type PopoverContentProps,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends PopoverContentProps {
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  sideOffset: 4,
  align: 'end',
})

const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      v-bind="forwarded"
      :class="cn(
        'z-50 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-none',
        'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        props.class
      )"
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
