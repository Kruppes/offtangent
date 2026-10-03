<script setup lang="ts">
import { computed } from 'vue'
import type { FeedItem } from '~/api/feed'
import { renderSafeMarkdown } from '~/composables/useMarkdown'
import { feedBodyVisible, feedExpandable, personaInitials } from './feedSections'
const props = withDefaults(defineProps<{ item: FeedItem; busy: boolean; expanded?: boolean; personaLabel?: string; timeOnly?: boolean }>(), { expanded: false, personaLabel: '', timeOnly: false })
const emit = defineEmits<{ read: []; ask: []; toggle: [] }>()
const { locale } = useI18n()
function date(value: string) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return props.timeOnly ? parsed.toLocaleTimeString(locale.value, { timeStyle: 'short' }) : parsed.toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
}
/** A collapsed card keeps a short preview of its body; expanding shows all (and reads it, like the app). */
const clamped = computed(() => feedExpandable(props.item) && !props.expanded)
const bodyId = computed(() => `feed-body-${props.item.id}`)
function toggle() {
  emit('toggle')
  if (!props.expanded && !props.item.readAt) emit('read')
}
</script>

<template>
  <li class="rounded-lg bg-card p-4 text-card-foreground [overflow-wrap:anywhere]">
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span v-if="personaLabel" class="inline-flex min-w-0 items-center gap-2 font-medium text-foreground" data-testid="feed-persona">
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-2xs font-semibold text-secondary-foreground" aria-hidden="true">{{ personaInitials(personaLabel) }}</span>
        <span class="truncate">{{ personaLabel }}</span>
      </span>
      <span v-if="!item.readAt" class="rounded-full bg-muted px-2 py-1 font-medium text-foreground">{{ $t('feed.unread') }}</span>
      <span>{{ $t(`feed.kinds.${item.kind}`) }}</span>
      <time :datetime="item.createdAt">{{ date(item.createdAt) }}</time>
    </div>
    <!-- Title and body keep the reading measure of 60-72 characters per line (M1 tokens): the body via 68ch at
         text-sm, the 16 px title via 32rem (68ch at 16 px measured 83 characters per line, 32rem measures at most 72). -->
    <h2 class="mt-2 flex max-w-[32rem] items-center gap-2 font-medium" data-testid="feed-title">
      <AppIcon v-if="item.kind === 'board_update'" name="compass" />
      <span>{{ item.title }}</span>
    </h2>
    <!-- eslint-disable-next-line vue/no-v-html -- renderSafeMarkdown escapes raw HTML and drops non-http(s) links. -->
    <div v-if="item.body && (clamped || feedBodyVisible(item, expanded))" :id="bodyId" class="prose-chat measure mt-2 break-words text-sm" :class="clamped ? 'feed-clamp max-h-16 overflow-hidden' : ''" v-html="renderSafeMarkdown(item.body)" />
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <Button v-if="feedExpandable(item)" variant="ghost" class="min-h-[44px]" :aria-expanded="expanded ? 'true' : 'false'" :aria-controls="bodyId" data-testid="feed-toggle" @click="toggle">
        <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" />{{ $t(expanded ? 'feed.showLess' : 'feed.showMore') }}
      </Button>
      <NuxtLink v-if="item.kind === 'board_update' && item.boardKey" :to="`/boards/${encodeURIComponent(item.boardKey)}`"
        class="inline-flex min-h-[44px] items-center rounded-lg border px-3 text-sm font-medium underline-offset-2 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        {{ $t('feed.openBoard') }}
      </NuxtLink>
      <Button v-if="!item.readAt" variant="outline" class="min-h-[44px]" :disabled="busy" @click="$emit('read')">{{ $t('feed.markRead') }}</Button>
      <Button v-if="item.kind !== 'board_update'" variant="outline" class="min-h-[44px]" :disabled="busy" @click="$emit('ask')">{{ $t('feed.ask') }}</Button>
      <NuxtLink v-if="item.strandId" :to="`/strands/${encodeURIComponent(item.strandId)}`" class="inline-flex min-h-[44px] items-center px-2 text-sm underline">{{ $t('feed.openStrand') }}</NuxtLink>
    </div>
  </li>
</template>

<style scoped>
/* Fade the clamped preview instead of cutting a line in half. */
.feed-clamp { mask-image: linear-gradient(to bottom, #000 55%, transparent); }
</style>
