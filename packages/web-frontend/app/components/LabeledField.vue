<script setup lang="ts">
import { type HTMLAttributes, useId } from 'vue'
import { cn } from '~/lib/utils'

/**
 * A form control with a visible label above it. The label is tied to the
 * control by id (`label[for]`), so it is the accessible name as well: a
 * placeholder or aria-label alone is not a label (it disappears while typing
 * or is invisible).
 */
const props = defineProps<{ label: string, class?: HTMLAttributes['class'] }>()
const id = useId()
</script>

<template>
  <div :class="cn('flex min-w-0 flex-col gap-1', props.class)">
    <Label :for="id" class="text-xs font-medium text-muted-foreground">{{ label }}</Label>
    <slot :id="id" />
  </div>
</template>
