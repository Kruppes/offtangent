<script setup lang="ts">
// `/strands` without an open strand. The parent page (`pages/strands.vue`)
// shows the list as the full-width overview then (W4d), so this child renders
// nothing; it exists so that `/strands` stays a route of its own.
</script>
<template>
  <div class="hidden" data-testid="strand-placeholder" />
</template>
