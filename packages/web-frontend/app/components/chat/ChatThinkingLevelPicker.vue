<template>
  <Popover v-model:open="thinkingLevelPickerOpen">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="mb-[7px] flex h-7 w-7 shrink-0 max-md:mb-0 max-md:h-11 max-md:w-11 items-center justify-center rounded-lg transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
        :class="thinkingBrainColorClass"
        :disabled="thinkingLevelSaving"
        :title="$t('chat.thinkingLevelTooltip')"
        :aria-label="$t('chat.thinkingLevelTooltip')"
      >
        <AppIcon
          :name="thinkingLevelSaving ? 'loader' : 'brain'"
          class="h-4 w-4 transition-colors"
          :class="thinkingLevelSaving ? 'animate-spin' : ''"
        />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-56 p-1">
      <p class="px-2 pb-1 pt-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {{ $t('settings.thinkingLevel') }}
      </p>
      <button
        v-for="lvl in THINKING_LEVELS"
        :key="lvl"
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
        :class="currentThinkingLevel === lvl ? 'bg-accent/60 text-accent-foreground' : 'text-foreground'"
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
        <AppIcon v-if="currentThinkingLevel === lvl" name="check" class="h-4 w-4 text-primary" />
      </button>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { useChatView } from '~/composables/chat/chatViewContext'

/** The brain button in the composer: thinking level quick-switch (admin only, shown by the composer). */
const {
  levels: THINKING_LEVELS, current: currentThinkingLevel, pickerOpen: thinkingLevelPickerOpen,
  saving: thinkingLevelSaving, brainColorClass: thinkingBrainColorClass, change: handleThinkingLevelChange,
} = useChatView().thinking
</script>
