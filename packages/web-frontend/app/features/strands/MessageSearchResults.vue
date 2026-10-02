<template>
  <!-- W5b: "In messages" — full text hits of the current search term, below
       the strand hits. Snippets are plain text with server-given highlight
       ranges, rendered through text interpolation only (no v-html). -->
  <section v-if="term" class="mt-4 min-w-0" aria-labelledby="message-search-title" data-message-search :data-state="state">
    <h2 id="message-search-title" class="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ $t('search.inMessages') }}</h2>
    <p v-if="state === 'loading'" class="flex min-h-11 items-center gap-2 px-3 text-sm text-muted-foreground" role="status" data-message-search-loading>
      <AppIcon name="loader" size="sm" class="motion-safe:animate-spin" aria-hidden="true" />{{ $t('search.loading') }}
    </p>
    <div v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm" data-message-search-error>
      <span class="min-w-0 flex-1">{{ $t(errorKey) }}</span>
      <button type="button" class="min-h-11 rounded-md border border-border px-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="load">{{ $t('search.retry') }}</button>
    </div>
    <p v-else-if="state === 'ready' && !hits.length" class="px-3 py-2 text-sm text-muted-foreground" data-message-search-empty>{{ $t('search.noMessages') }}</p>
    <ul v-else-if="state === 'ready'" class="flex flex-col gap-1" data-message-search-hits>
      <li v-for="hit in hits" :key="hit.messageId" class="min-w-0">
        <NuxtLink :to="messageRoute(hit.strandId, hit.messageId)" class="flex min-h-11 min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :data-message-hit="hit.messageId">
          <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <AppIcon :name="hit.role === 'assistant' ? 'bot' : 'user'" size="sm" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate font-semibold text-foreground">{{ hit.strandTitle || $t('strandsW3.untitled') }}</span>
            <time v-if="hit.timestamp" class="shrink-0 tabular-nums" :datetime="hit.timestamp">{{ when(hit.timestamp) }}</time>
          </span>
          <span class="line-clamp-2 min-w-0 break-words text-sm [overflow-wrap:anywhere]" data-message-snippet><span class="sr-only">{{ hit.role === 'assistant' ? $t('search.roleAssistant') : $t('search.roleUser') }}: </span><template v-for="(part, i) in snippetParts(hit)" :key="i"><mark v-if="part.match" class="rounded-sm bg-primary/25 px-0.5 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
        </NuxtLink>
      </li>
      <li v-if="truncated" class="px-3 py-1 text-xs text-muted-foreground" data-message-search-more>{{ $t('search.more', { count: limit }) }}</li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ApiError } from '~/composables/useApi'
import { createLatestRequest } from '~/utils/commandPalette'
import { parseBackendTimestamp } from '~/utils/datetime'
import { messageRoute, messageSearchTerm, snippetParts, useStrandW5bApi, type MessageHit } from '~/api/strandW5b'

const props = withDefaults(defineProps<{ query: string; limit?: number }>(), { limit: 20 })
const { locale } = useI18n()
const api = useStrandW5bApi()
const term = computed(() => messageSearchTerm(props.query))
const hits = ref<MessageHit[]>([])
const truncated = ref(false)
const state = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const errorKey = ref('search.error')
const latest = createLatestRequest()
let debounce: ReturnType<typeof setTimeout> | null = null

function when(value: string): string {
  const date = parseBackendTimestamp(value)
  return date ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(date) : ''
}

async function load() {
  const search = term.value
  if (!search) { latest.cancel(); state.value = 'idle'; hits.value = []; return }
  const request = latest.start()
  state.value = 'loading'
  try {
    const result = await api.search(search, props.limit, request.signal)
    if (!latest.isCurrent(request.id)) return
    hits.value = result.hits
    truncated.value = result.truncated
    state.value = 'ready'
  } catch (error) {
    if (!latest.isCurrent(request.id)) return
    hits.value = []
    errorKey.value = error instanceof ApiError && error.status === 429 ? 'search.errorRate' : 'search.error'
    state.value = 'error'
  }
}

watch(term, () => {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => void load(), 200)
}, { immediate: true })
onBeforeUnmount(() => { if (debounce) clearTimeout(debounce); latest.cancel() })
</script>
