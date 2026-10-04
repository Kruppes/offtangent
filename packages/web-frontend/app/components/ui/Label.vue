<script setup lang="ts">
import { type HTMLAttributes, computed } from 'vue'
import { Label, type LabelProps } from 'reka-ui'
import { cn } from '~/lib/utils'

interface Props extends LabelProps {
  class?: HTMLAttributes['class']
  required?: boolean
}

const props = defineProps<Props>()

const delegatedProps = computed(() => {
  const { class: _, required: __, ...delegated } = props
  return delegated
})
</script>

<template>
  <Label
    v-bind="delegatedProps"
    :class="cn(
      'text-sm font-medium leading-5 peer-disabled:cursor-not-allowed peer-disabled:text-muted-foreground',
      props.class
    )"
  >
    <slot />
    <span v-if="required" class="ml-1 text-destructive" aria-hidden="true">*</span>
  </Label>
</template>
