<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    :class="cn('flex flex-col gap-1.5 text-left mb-4', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
