<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import {
  DropdownMenuSubContent,
  DropdownMenuPortal,
  type DropdownMenuSubContentEmits,
  type DropdownMenuSubContentProps,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends DropdownMenuSubContentProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuSubContent
      v-bind="forwarded"
      :class="cn(
        'z-[100] min-w-[160px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg',
        'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        props.class
      )"
    >
      <slot />
    </DropdownMenuSubContent>
  </DropdownMenuPortal>
</template>
