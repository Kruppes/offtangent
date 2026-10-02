<script setup lang="ts">
import UnsortedPage from '~/features/unsorted/UnsortedPage.vue'
</script>
<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="$t('unsorted.title')" :subtitle="$t('unsorted.subtitle')" />
    <div class="min-h-0 flex-1 overflow-y-auto pb-20 md:pb-0" data-testid="unsorted-scroll"><UnsortedPage /></div>
  </div>
</template>
