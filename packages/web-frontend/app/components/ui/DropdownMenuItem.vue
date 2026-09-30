<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { DropdownMenuItem, type DropdownMenuItemProps, type DropdownMenuItemEmits, useForwardPropsEmits } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends DropdownMenuItemProps {
  class?: HTMLAttributes['class']
  destructive?: boolean
}

const props = defineProps<Props>()
const emits = defineEmits<DropdownMenuItemEmits>()

const delegatedProps = computed(() => {
  const { class: _, destructive: __, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DropdownMenuItem
    v-bind="forwarded"
    :class="cn(
      'flex w-full cursor-default select-none items-center gap-2 rounded-md px-3 py-2 text-sm outline-none transition-colors',
      'focus:bg-accent focus:text-accent-foreground',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      destructive && 'text-destructive focus:bg-destructive/10',
      props.class
    )"
  >
    <slot />
  </DropdownMenuItem>
</template>
