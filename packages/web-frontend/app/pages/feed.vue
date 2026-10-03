<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useFeed } from '~/composables/useFeed'
import { useCapturesApi, type ClientPersona } from '~/api/captures'
import { FEED_FILTER_KINDS, type FeedItem, type FeedItemKind } from '~/api/feed'
import FeedCard from '~/features/feed/FeedCard.vue'
import { feedDays, feedPersonas, filterFeed, personaKey, type FeedDayLabel } from '~/features/feed/feedSections'

const { items, unreadCount, loading, busy, error, load, markRead, ask } = useFeed()
const { t, locale } = useI18n()
const unreadOnly = ref(false)
const kind = ref<FeedItemKind | ''>('')
/** null = every persona, '' = the default persona (items without an agent). */
const persona = ref<string | null>(null)
const expanded = ref<Set<string>>(new Set())
const personas = ref<ClientPersona[]>([])
const kinds = FEED_FILTER_KINDS
const visibleItems = computed(() => filterFeed(items.value, { unreadOnly: unreadOnly.value, kind: kind.value, persona: persona.value }))
const days = computed(() => feedDays(visibleItems.value, Date.now()))
/** Persona chips only help when the feed mixes at least two personas. */
const personaChips = computed(() => {
  const keys = feedPersonas(items.value)
  return keys.length > 1 ? keys : []
})
function personaLabel(key: string) {
  if (!key) return personas.value.find(p => p.isDefault)?.displayName || t('feed.personaDefault')
  return personas.value.find(p => p.id === key)?.displayName || key
}
function dayLabel(label: FeedDayLabel) {
  if (label.kind !== 'date') return t(`feed.day.${label.kind}`)
  return new Date(`${label.day}T12:00:00Z`).toLocaleDateString(locale.value, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}
function toggle(item: FeedItem) {
  const next = new Set(expanded.value)
  if (next.has(item.id)) next.delete(item.id)
  else next.add(item.id)
  expanded.value = next
}
async function askAbout(item: FeedItem) {
  const destination = await ask(item)
  if (destination) await navigateTo(destination)
}
async function loadPersonas() {
  // Labels only, from the client catalog every logged-in role may read
  // (`/api/personas` is admin-only). Without it a chip shows the persona id.
  try { personas.value = await useCapturesApi().personas() } catch { personas.value = [] }
}
onMounted(() => { void load(); void loadPersonas() })
const chipClass = (selected: boolean) => [
  'inline-flex min-h-[44px] max-w-full items-center gap-2 rounded-full border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  selected ? 'border-primary bg-selected-container font-medium text-on-selected-container' : 'border-border hover:bg-accent',
]
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="$t('feed.title')" :subtitle="$t('feed.subtitle')" own-mobile-heading />
    <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-24 pt-3 md:px-6 md:pb-8" data-testid="feed-scroll">
      <div class="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-3">
        <h1 class="px-1 text-xl font-bold tracking-tight md:hidden">{{ $t('feed.title') }}</h1>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex min-h-[44px] items-center gap-2 rounded-lg border px-3 text-sm">
            <input v-model="unreadOnly" type="checkbox" class="h-5 w-5 accent-primary">{{ $t('feed.unreadOnly') }}
          </label>
          <label class="flex min-w-0 max-w-full items-center gap-2 text-sm" for="feed-kind">
            <span class="shrink-0 text-xs font-medium text-muted-foreground">{{ $t('feed.kindFilter') }}</span>
          <select id="feed-kind" v-model="kind" class="min-h-[44px] min-w-0 max-w-full rounded-lg border border-input bg-background px-3 text-sm">
            <option value="">{{ $t('feed.allKinds') }}</option>
            <option v-for="entry in kinds" :key="entry" :value="entry">{{ $t(`feed.kinds.${entry}`) }}</option>
          </select>
          </label>
          <Button variant="outline" class="min-h-[44px]" :disabled="busy || loading || unreadCount === 0" @click="markRead()">{{ $t('feed.markAllRead') }}</Button>
          <Button variant="ghost" class="min-h-[44px]" :disabled="busy || loading" @click="load">{{ $t('feed.refresh') }}</Button>
        </div>
        <div v-if="personaChips.length" role="group" :aria-label="$t('feed.personaFilter')" class="flex flex-wrap gap-2" data-testid="feed-personas">
          <button type="button" :class="chipClass(persona === null)" :aria-pressed="persona === null ? 'true' : 'false'" @click="persona = null">{{ $t('feed.allPersonas') }}</button>
          <button v-for="key in personaChips" :key="key || 'default'" type="button" :class="chipClass(persona === key)" :aria-pressed="persona === key ? 'true' : 'false'" @click="persona = persona === key ? null : key">
            <span class="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-secondary text-2xs font-semibold text-secondary-foreground" aria-hidden="true">{{ personaLabel(key).slice(0, 1).toUpperCase() }}</span>
            <span class="truncate">{{ personaLabel(key) }}</span>
          </button>
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
        <div v-else class="space-y-4" :aria-busy="loading">
          <section v-for="day in days" :key="day.key" :aria-labelledby="`feed-day-${day.key}`" data-testid="feed-day">
            <h2 :id="`feed-day-${day.key}`" class="mb-2 px-1 text-sm font-medium text-muted-foreground">{{ dayLabel(day.label) }}</h2>
            <ul class="space-y-3">
              <FeedCard v-for="item in day.items" :key="item.id" :item="item" :busy="busy" :expanded="expanded.has(item.id)" :persona-label="personaLabel(personaKey(item))" time-only
                @read="markRead(item.id)" @ask="askAbout(item)" @toggle="toggle(item)" />
            </ul>
          </section>
        </div>
        <p v-if="items.length >= 200" class="text-sm text-muted-foreground">{{ $t('feed.recentLimit') }}</p>
      </div>
    </div>
  </div>
</template>
