<template>
  <!-- One panel silhouette for both states: open fills the side area, closed keeps
       only the outline. Everything paints with currentColor, so forced-colors mode
       maps it to the system text colour without a special rule. -->
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="block shrink-0"
    aria-hidden="true"
    :data-state="open ? 'open' : 'closed'"
  >
    <path v-if="open" data-part="side" d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="currentColor" />
    <rect data-part="frame" x="3" y="3" width="18" height="18" rx="2" />
    <path data-part="divider" d="M9 3v18" />
  </svg>
</template>

<script setup lang="ts">
defineProps<{ open: boolean }>()
</script>
