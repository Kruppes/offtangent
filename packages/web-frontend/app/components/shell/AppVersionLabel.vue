<template>
  <!-- W6b: version plus build commit, so the deployed state is visible. -->
  <p class="mt-0.5 text-xs text-muted-foreground" data-testid="app-version" :data-build-sha="sha || undefined">
    {{ label }}
  </p>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatVersionLabel, normalizeBuildSha } from '~/utils/buildSha'

const props = defineProps<{ version: string; buildSha?: string }>()
const sha = computed(() => normalizeBuildSha(props.buildSha))
const label = computed(() => formatVersionLabel(props.version, props.buildSha))
</script>
