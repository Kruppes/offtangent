<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{
  class?: HTMLAttributes['class']
  /** Heading level; pick the one that follows the page outline (h1 page title, h2 sections). */
  as?: 'h2' | 'h3' | 'h4'
}>(), { as: 'h3' })
</script>

<template>
  <component
    :is="props.as"
    :class="cn('text-2xl font-semibold leading-8 tracking-tight', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </component>
</template>
