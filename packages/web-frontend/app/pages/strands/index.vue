<script setup lang="ts">
import StrandList from '~/features/strands/StrandList.vue'
</script>
<template>
  <div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
    <h1 class="px-3 pt-3 text-xl font-bold md:px-6">{{ $t('strandsW3.title') }}</h1>
    <StrandList />
  </div>
</template>
