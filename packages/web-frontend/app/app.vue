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
// The document language follows the UI locale (screen readers, hyphenation).
const { locale } = useI18n()
useHead({ htmlAttrs: { lang: locale } })
</script>
