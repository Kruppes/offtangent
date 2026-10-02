<template>
  <SettingsWorkspace :section="section" />
</template>

<script setup lang="ts">
import SettingsWorkspace from '~/features/settings/components/SettingsWorkspace.vue'
import { legacyTabRedirect } from '~/features/settings/settingsSections'

definePageMeta({
  // One page instance for the overview and every area: switching areas keeps
  // the shared settings form (and its unsaved edits) instead of remounting.
  key: 'settings',
  // `/settings?tab=<id>` was the old deep link; keep it working.
  middleware: [(to) => {
    const target = legacyTabRedirect(to.query)
    if (target && to.path !== target) return navigateTo(target, { replace: true })
  }],
})

const route = useRoute()
const section = computed(() => {
  const raw = route.params.section
  const value = Array.isArray(raw) ? raw[0] : raw
  return value || null
})
</script>
