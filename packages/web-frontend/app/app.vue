<template>
  <TooltipProvider>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
// Migration and the initial class are applied synchronously before rendering.
useTheme()
</script>
