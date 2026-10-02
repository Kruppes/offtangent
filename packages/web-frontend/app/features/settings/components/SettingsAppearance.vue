<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme, type ColorMode } from '~/composables/useTheme'

/**
 * Theme choice: System / Light / Dark. A browser preference (localStorage via
 * useTheme), so it saves on change and needs no server data.
 */
const { mode, resolvedMode, setMode } = useTheme()
const { t } = useI18n()

const options: ReadonlyArray<{ value: ColorMode, icon: string }> = [
  { value: 'auto', icon: 'settings' },
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
]

const current = computed<ColorMode>(() => (mode.value === 'light' || mode.value === 'dark' ? mode.value : 'auto'))
const shownLabel = computed(() => t(`settings.appearance.modes.${resolvedMode.value}`))
</script>

<template>
  <div data-testid="settings-appearance">
    <div class="mb-8">
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.sections.appearance') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.sections.appearanceDescription') }}
      </p>
    </div>

    <fieldset class="flex flex-col gap-3">
      <legend class="mb-2 text-sm font-medium text-foreground">{{ $t('settings.appearance.theme') }}</legend>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label
          v-for="option in options"
          :key="option.value"
          :class="[
            'flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
            current === option.value ? 'border-primary bg-accent font-medium text-accent-foreground' : 'border-border text-foreground hover:bg-accent/50',
          ]"
        >
          <input
            type="radio"
            name="theme-mode"
            :value="option.value"
            :checked="current === option.value"
            :data-theme-option="option.value"
            class="h-4 w-4 accent-[hsl(var(--primary))]"
            @change="setMode(option.value)"
          >
          <AppIcon :name="option.icon" size="sm" class="text-muted-foreground" />
          <span>{{ $t(`settings.appearance.modes.${option.value}`) }}</span>
        </label>
      </div>
      <p class="text-xs text-muted-foreground">{{ $t('settings.appearance.themeHint') }}</p>
      <p class="text-xs text-muted-foreground" aria-live="polite">{{ $t('settings.appearance.current', { mode: shownLabel }) }}</p>
    </fieldset>
  </div>
</template>
