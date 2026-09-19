<template>
  <span class="inline-flex shrink-0 overflow-hidden rounded-xl" :style="{ width: `${size}px`, height: `${size}px` }" role="img" aria-label="Offtangent">
    <img src="/logos/offtangent-light.svg" alt="" :width="size" :height="size" class="block h-full w-full dark:hidden" />
    <img src="/logos/offtangent-dark.svg" alt="" :width="size" :height="size" class="hidden h-full w-full dark:block" />
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 40 })
</script>
