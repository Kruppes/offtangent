<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <td
    :class="cn('p-4 align-middle text-sm [&:has([role=checkbox])]:pr-0', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </td>
</template>
