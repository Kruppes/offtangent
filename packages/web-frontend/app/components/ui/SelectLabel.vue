<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { SelectLabel, type SelectLabelProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends SelectLabelProps {
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()

const delegatedProps = computed(() => {
  const { class: _, ...delegated } = props
  return delegated
})
</script>

<template>
  <SelectLabel
    v-bind="delegatedProps"
    :class="cn('py-1.5 pl-8 pr-2 text-xs font-semibold text-muted-foreground', props.class)"
  >
    <slot />
  </SelectLabel>
</template>
