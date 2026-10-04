<script setup lang="ts">
import CaptureHome from '~/features/capture/components/CaptureHome.vue'
import HomeActivityStrip from '~/features/tasks/components/HomeActivityStrip.vue'
</script>
<template>
  <div class="min-h-0 flex-1 overflow-y-auto pb-20 md:pb-0" data-testid="home-scroll">
    <CaptureHome />
    <HomeActivityStrip />
  </div>
</template>
