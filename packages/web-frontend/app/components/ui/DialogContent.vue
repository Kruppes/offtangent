<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  type DialogContentEmits,
  type DialogContentProps,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends DialogContentProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
    />
    <DialogContent
      v-bind="forwarded"
      :class="cn(
        // Centered via auto margins instead of translate(-50%, -50%): a transformed
        // scroll container makes Firefox's async scrolling paint content outside
        // the dialog while scrolling.
        'fixed inset-0 z-50 m-auto h-fit w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl',
        'focus:outline-none',
        'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out',
        props.class
      )"
    >
      <slot />
    </DialogContent>
  </DialogPortal>
</template>
