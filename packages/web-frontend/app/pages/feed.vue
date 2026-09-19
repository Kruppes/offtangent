<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useFeed } from '~/composables/useFeed'
import type { FeedItem, FeedItemKind } from '~/api/feed'
import FeedCard from '~/features/feed/FeedCard.vue'

const { items, unreadCount, loading, busy, error, load, markRead, ask } = useFeed()
const unreadOnly = ref(false)
const kind = ref<FeedItemKind | ''>('')
const kinds: FeedItemKind[] = ['task_result', 'task_question', 'cron_report', 'heartbeat', 'reminder', 'system']
const visibleItems = computed(() => items.value.filter(item => (!unreadOnly.value || !item.readAt) && (!kind.value || item.kind === kind.value)))
async function askAbout(item: FeedItem) {
  const destination = await ask(item)
  if (destination) await navigateTo(destination)
}
onMounted(load)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="$t('feed.title')" :subtitle="$t('feed.subtitle')" />
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 md:px-6 md:pb-8">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <h1 class="px-1 text-xl font-bold tracking-tight md:hidden">{{ $t('feed.title') }}</h1>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm">
            <input v-model="unreadOnly" type="checkbox" class="accent-primary">{{ $t('feed.unreadOnly') }}
          </label>
          <label class="sr-only" for="feed-kind">{{ $t('feed.kindFilter') }}</label>
          <select id="feed-kind" v-model="kind" class="min-h-[44px] max-w-full rounded-lg border border-input bg-background px-3 text-sm">
            <option value="">{{ $t('feed.allKinds') }}</option>
            <option v-for="entry in kinds" :key="entry" :value="entry">{{ $t(`feed.kinds.${entry}`) }}</option>
          </select>
          <Button variant="outline" class="min-h-[44px]" :disabled="busy || loading || unreadCount === 0" @click="markRead()">{{ $t('feed.markAllRead') }}</Button>
          <Button variant="ghost" class="min-h-[44px]" :disabled="busy || loading" @click="load">{{ $t('feed.refresh') }}</Button>
        </div>
        <p class="text-sm text-muted-foreground" role="status">{{ $t('feed.unreadCount', { count: unreadCount }) }}</p>
        <Alert v-if="error" variant="destructive" role="alert" class="flex flex-wrap items-center gap-3">
          <AlertDescription class="flex-1">{{ $t(error) }}</AlertDescription>
          <Button variant="outline" class="min-h-[44px]" :disabled="busy || loading" @click="load">{{ $t('common.retry') }}</Button>
          <Button variant="ghost" class="min-h-[44px] min-w-[44px]" :aria-label="$t('feed.dismissError')" @click="error = null"><AppIcon name="close" /></Button>
        </Alert>
        <div v-if="loading && !items.length" role="status" :aria-label="$t('common.loading')" aria-busy="true" class="space-y-3">
          <div v-for="n in 3" :key="n" aria-hidden="true" class="h-24 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        </div>
        <p v-else-if="!visibleItems.length && !error" role="status" class="rounded-lg border p-6 text-center text-muted-foreground">{{ $t(items.length ? 'feed.emptyFiltered' : 'feed.empty') }}</p>
        <ul v-else class="space-y-3" :aria-busy="loading">
          <FeedCard v-for="item in visibleItems" :key="item.id" :item="item" :busy="busy" @read="markRead(item.id)" @ask="askAbout(item)" />
        </ul>
        <p v-if="items.length >= 200" class="text-sm text-muted-foreground">{{ $t('feed.recentLimit') }}</p>
      </div>
    </div>
  </div>
</template>
