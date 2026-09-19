<script setup lang="ts">
definePageMeta({
  middleware: (to) => navigateTo({
    path: `/strands/${encodeURIComponent(String(to.params.id))}`,
    query: to.query,
    hash: to.hash,
  }, { redirectCode: 301, replace: true }),
})
</script>

<template>
  <div />
</template>
