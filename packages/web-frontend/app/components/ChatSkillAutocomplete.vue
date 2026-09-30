<template>
  <div
    class="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
    role="listbox"
    :aria-label="$t('chat.skillAutocomplete.label')"
  >
    <p class="border-b border-border/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {{ $t('chat.skillAutocomplete.label') }}
    </p>
    <ul class="max-h-64 overflow-y-auto py-1">
      <li
        v-for="(skill, index) in suggestions"
        :key="skill.id"
        :ref="(el) => setItemRef(el, index)"
        role="option"
        :aria-selected="index === selectedIndex"
        class="flex cursor-pointer items-start gap-3 px-3 py-2 text-sm transition-colors"
        :class="index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'"
        @mousedown.prevent="$emit('select', skill)"
        @mousemove="$emit('hover', index)"
      >
        <AppIcon name="sparkles" class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate font-medium">{{ skill.name }}</span>
            <code class="truncate text-xs text-muted-foreground">/skill:{{ skill.id }}</code>
            <span
              v-if="skill.kind === 'installed'"
              class="shrink-0 rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {{ $t('chat.skillAutocomplete.installed') }}
            </span>
          </div>
          <p v-if="skill.description" class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{{ skill.description }}</p>
        </div>
      </li>
    </ul>
    <p class="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
      {{ $t('chat.skillAutocomplete.hint') }}
    </p>
  </div>
</template>

<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { LoadableSkill } from '~/composables/useSkillAutocomplete'

const props = defineProps<{
  suggestions: LoadableSkill[]
  selectedIndex: number
}>()

defineEmits<{
  select: [skill: LoadableSkill]
  hover: [index: number]
}>()

const itemRefs = new Map<number, HTMLElement>()

function setItemRef(el: Element | ComponentPublicInstance | null, index: number) {
  if (el instanceof HTMLElement) itemRefs.set(index, el)
  else itemRefs.delete(index)
}

watch(() => props.selectedIndex, (index) => {
  itemRefs.get(index)?.scrollIntoView({ block: 'nearest' })
})
</script>
