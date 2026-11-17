<template>
  <!-- Z5: an unknown level (read failed, or a save ended unclear) is shown as
       unknown: a badge on the button (absolute, so the composer does not
       move), a hint with "read again" in the menu and a polite announcement.
       The strand never holds a send. -->
  <span class="sr-only" aria-live="polite" data-testid="thinking-unknown-live">{{ levelUnknown ? $t('chat.thinkingLevelUnknown') : '' }}</span>
  <Popover v-model:open="thinkingLevelPickerOpen">
    <PopoverTrigger as-child>
      <button
        type="button"
        data-composer-control="thinking"
        class="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:[&_svg]:text-border"
        :class="thinkingBrainColorClass"
        :disabled="thinkingLevelSaving"
        :title="levelUnknown ? `${$t('chat.thinkingLevelTooltip')}: ${$t('chat.thinkingLevelUnknown')}` : $t('chat.thinkingLevelTooltip')"
        :aria-label="levelUnknown ? `${$t('chat.thinkingLevelTooltip')}: ${$t('chat.thinkingLevelUnknown')}` : $t('chat.thinkingLevelTooltip')"
      >
        <AppIcon
          :name="thinkingLevelSaving ? 'loader' : 'brain'"
          class="h-4 w-4 transition-colors"
          :class="thinkingLevelSaving ? 'animate-spin' : ''"
        />
        <span
          v-if="levelUnknown"
          data-testid="thinking-unknown-badge"
          aria-hidden="true"
          class="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-warning ring-2 ring-background"
        />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-1">
      <p class="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-label text-muted-foreground">
        {{ $t('settings.thinkingLevel') }}
      </p>
      <div v-if="levelUnknown" data-testid="thinking-unknown-hint" class="mx-1 mb-1 flex flex-col gap-1 rounded-md border border-warning px-2 py-2 text-xs">
        <p class="flex items-start gap-2">
          <AppIcon name="warning" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>{{ $t('chat.thinkingLevelUnknown') }}</span>
        </p>
        <button
          type="button"
          data-testid="thinking-reread"
          class="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border px-2 text-sm hover:bg-accent"
          @click="reread"
        >
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('chat.thinkingLevelReread') }}
        </button>
      </div>
      <button
        v-for="lvl in THINKING_LEVELS"
        :key="lvl"
        type="button"
        class="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        :class="known && currentThinkingLevel === lvl ? 'bg-accent text-accent-foreground' : 'text-foreground'"
        :disabled="thinkingLevelSaving"
        @click="handleThinkingLevelChange(lvl)"
      >
        <div class="flex items-center gap-2">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="{
              'bg-muted-foreground': lvl === 'off',
              'bg-foreground': lvl === 'minimal',
              'bg-primary': lvl === 'low',
              'bg-warning': lvl === 'medium',
              'bg-destructive': lvl === 'high' || lvl === 'xhigh',
            }"
          />
          <span>{{ $t(`chat.thinkingLevelMenu.${lvl}`) }}</span>
        </div>
        <AppIcon v-if="known && currentThinkingLevel === lvl" name="check" class="h-4 w-4 text-primary" />
      </button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useChatView } from '~/composables/chat/chatViewContext'

/** The brain button in the composer: thinking level quick-switch (admin only, shown by the composer). */
const {
  levels: THINKING_LEVELS, current: currentThinkingLevel, pickerOpen: thinkingLevelPickerOpen,
  saving: thinkingLevelSaving, brainColorClass: thinkingBrainColorClass, change: handleThinkingLevelChange,
  known, loadError, saveUnclear, load,
} = useChatView().thinking
/** Z5: shown as unknown once a read failed or a save ended unclear (not while the first read runs). */
const levelUnknown = computed(() => !thinkingLevelSaving.value && !known.value && (loadError.value || saveUnclear.value))
function reread() { void load() }
</script>
