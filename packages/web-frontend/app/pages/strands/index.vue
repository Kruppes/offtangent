<script setup lang="ts">
// The list lives in the parent page (`pages/strands.vue`). With two or three
// columns this child fills the conversation column until a strand is chosen.
</script>
<template>
  <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground" data-testid="strand-placeholder">
    <AppIcon name="chat" size="lg" />
    <p class="text-sm font-semibold text-foreground">{{ $t('shell.pickStrand') }}</p>
    <p class="max-w-xs text-sm">{{ $t('shell.pickStrandHint') }}</p>
  </div>
</template>
