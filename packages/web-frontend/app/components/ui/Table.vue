<script setup lang="ts">
import { type HTMLAttributes } from 'vue'
import { cn } from '~/lib/utils'

const props = defineProps<{
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div class="relative w-full overflow-auto overscroll-x-contain" data-table-scroll>
    <table :class="cn('w-full caption-bottom text-sm', props.class)" v-bind="$attrs">
      <slot />
    </table>
  </div>
</template>
