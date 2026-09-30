<template>
  <Logo :size="sizes[size]" />
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), { size: 'md' })

const sizes = { sm: 34, md: 40, lg: 52 }
</script>
