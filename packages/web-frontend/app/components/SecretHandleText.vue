<template>
  <span class="whitespace-pre-wrap break-words">
    <template v-for="(part, index) in parts" :key="index">
      <span v-if="part.type === 'text'">{{ part.text }}</span>
      <span
        v-else
        class="secret-chip"
        :data-secret-chip="part.slug"
        role="note"
        tabindex="0"
        :title="chipTitle(part.slug)"
        :aria-label="chipTitle(part.slug)"
      >
        <AppIcon name="lock" class="secret-chip-icon" />
        <span class="secret-chip-slug">{{ part.slug }}</span>
      </span>
    </template>
  </span>
</template>

<script setup lang="ts">
/**
 * Plain-text message body with sealed secret handles rendered as lock chips
 * (plan 2026-09-26, step 1). Used for user/system bubbles, which are NOT run
 * through markdown.
 *
 * No `v-html` anywhere: the text is interpolated by Vue, the chip is real
 * markup, and the slug comes from the shared contract regex.
 */
import { computed } from 'vue'
import { secretChipTooltip, splitSecretHandles } from '~/utils/secretHandles'

const props = defineProps<{ text: string }>()

const parts = computed(() => splitSecretHandles(props.text ?? ''))

/**
 * The tooltip comes from the module-level label the chat installs from i18n
 * (`setSecretChipTooltip`), not from `useI18n()` here: this component is also
 * rendered by the SSR test harness, which has no i18n plugin.
 */
function chipTitle(slug: string): string {
  return `${secretChipTooltip()} ({{secret:${slug}}})`
}
</script>
