<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    :class="cn('text-sm [&_p]:leading-6', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
