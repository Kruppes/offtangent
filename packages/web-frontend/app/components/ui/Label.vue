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
      'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      props.class
    )"
  >
    <slot />
    <span v-if="required" class="ml-0.5 text-destructive" aria-hidden="true">*</span>
  </Label>
</template>
