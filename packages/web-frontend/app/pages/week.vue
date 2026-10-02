<script setup lang="ts">
import WeekPage from '~/features/week/WeekPage.vue'
</script>
<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="$t('week.title')" :subtitle="$t('week.subtitle')" own-mobile-heading />
    <div class="min-h-0 flex-1 overflow-y-auto pb-20 md:pb-0" data-testid="week-scroll"><WeekPage /></div>
  </div>
</template>
