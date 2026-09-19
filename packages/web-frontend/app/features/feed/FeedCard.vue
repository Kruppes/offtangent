<script setup lang="ts">
import type { FeedItem } from '~/api/feed'
defineProps<{ item: FeedItem; busy: boolean }>()
defineEmits<{ read: []; ask: [] }>()
const { locale } = useI18n()
function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
}
</script>

<template>
  <li class="rounded-lg border bg-card p-4 text-card-foreground [overflow-wrap:anywhere]" :class="!item.readAt ? 'border-primary/40' : 'border-border'">
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span v-if="!item.readAt" class="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">{{ $t('feed.unread') }}</span>
      <span>{{ $t(`feed.kinds.${item.kind}`) }}</span>
      <time :datetime="item.createdAt">{{ date(item.createdAt) }}</time>
    </div>
    <h2 class="mt-2 font-medium">{{ item.title }}</h2>
    <p v-if="item.body" class="mt-2 whitespace-pre-wrap break-words text-sm">{{ item.body }}</p>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <Button v-if="!item.readAt" variant="outline" class="min-h-[44px]" :disabled="busy" @click="$emit('read')">{{ $t('feed.markRead') }}</Button>
      <Button variant="outline" class="min-h-[44px]" :disabled="busy" @click="$emit('ask')">{{ $t('feed.ask') }}</Button>
      <NuxtLink v-if="item.strandId" :to="`/strands/${encodeURIComponent(item.strandId)}`" class="inline-flex min-h-[44px] items-center px-2 text-sm underline">{{ $t('feed.openStrand') }}</NuxtLink>
    </div>
  </li>
</template>
