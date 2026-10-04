<script setup lang="ts">
/**
 * Command palette (W3, Ctrl/Cmd+K): find a strand through the backend search,
 * jump to any page the sidebar offers, or run an action. A reka-ui dialog
 * traps the focus and gives it back on close; the input is an ARIA combobox
 * that owns the listbox through `aria-activedescendant`, so the cursor moves
 * with the arrow keys while typing continues.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import type { Thread } from '@axiom/core'
import {
  PALETTE_MESSAGE_LIMIT, PALETTE_SEARCH_DEBOUNCE_MS, PALETTE_STRAND_LIMIT, buildPaletteList, createLatestRequest, groupPaletteList,
  keepCursor, moveCursor, paletteSearchTerm, type PaletteEntry, type PaletteKey,
} from '~/utils/commandPalette'
import { CAPTURE_NAV_ITEMS, PRIMARY_NAV_ITEMS, SYSTEM_NAV_ITEMS, navItemAllowed } from '~/utils/shellNav'
import { displayKeys, isMacPlatform } from '~/utils/shortcuts'
import { parseBackendTimestamp } from '~/utils/datetime'
import { useShellCommands } from '~/composables/useShellCommands'
import { useShortcutOverlay } from '~/composables/useShortcuts'
import { messageRoute, messageSearchTerm, snippetParts, useStrandW5bApi, type MessageHit } from '~/api/strandW5b'

const props = defineProps<{ open: boolean; isAdmin: boolean; emailConfigured: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; toggleSidebar: []; openHelp: [] }>()

type Entry = PaletteEntry & { run: () => void | Promise<void> }

const { t, locale } = useI18n()
const router = useRouter()
const { apiFetch } = useApi()
const commands = useShellCommands()
const { toggle: toggleTheme, isDark } = useTheme()
const overlay = useShortcutOverlay()
const mac = typeof navigator !== 'undefined' && isMacPlatform(navigator)
const keys = (combo: string[]) => displayKeys(combo, mac).join(' ')

const query = ref('')
const cursor = ref(0)
const input = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const strands = ref<Thread[]>([])
const strandState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const latest = createLatestRequest()
// W5b: message full text, a second request beside the strand search.
const w5b = useStrandW5bApi()
const messageHits = ref<MessageHit[]>([])
const messageState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const latestMessages = createLatestRequest()
async function loadMessages(term: string) {
  const search = messageSearchTerm(term)
  if (!search) {
    latestMessages.cancel()
    messageHits.value = []
    messageState.value = 'idle'
    return
  }
  const request = latestMessages.start()
  messageState.value = 'loading'
  try {
    const result = await w5b.search(search, PALETTE_MESSAGE_LIMIT, request.signal)
    if (!latestMessages.isCurrent(request.id)) return
    messageHits.value = result.hits
    messageState.value = 'ready'
  } catch {
    if (!latestMessages.isCurrent(request.id)) return
    messageHits.value = []
    messageState.value = 'error'
  }
}
let debounce: ReturnType<typeof setTimeout> | null = null

function date(value: string | undefined) {
  const parsed = value ? parseBackendTimestamp(value) : null
  return parsed ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(parsed) : ''
}

async function loadStrands(term: string) {
  const request = latest.start()
  strandState.value = 'loading'
  const params = new URLSearchParams({ limit: String(PALETTE_STRAND_LIMIT) })
  if (term) params.set('q', term)
  try {
    const result = await apiFetch<{ strands: Thread[] }>(`/api/strands?${params}`, { signal: request.signal })
    if (!latest.isCurrent(request.id)) return
    strands.value = result.strands
    strandState.value = 'ready'
  } catch {
    if (!latest.isCurrent(request.id)) return
    strands.value = []
    strandState.value = 'error'
  }
}
function scheduleSearch(immediate = false) {
  if (debounce) clearTimeout(debounce)
  const term = paletteSearchTerm(query.value)
  if (immediate) { void loadStrands(term); void loadMessages(term) }
  else debounce = setTimeout(() => { void loadStrands(term); void loadMessages(term) }, PALETTE_SEARCH_DEBOUNCE_MS)
}

function go(path: string) {
  void router.push(path)
}
async function newStrand() {
  // New strands start in the home composer: it creates the strand from the first message.
  await router.push('/')
  await nextTick()
  setTimeout(() => document.querySelector<HTMLTextAreaElement>('[data-testid="home-scroll"] textarea')?.focus(), 50)
}

const pages = computed<Entry[]>(() => {
  const nav: Entry[] = [
    ...PRIMARY_NAV_ITEMS.map(item => ({ ...item, section: '' })),
    ...SYSTEM_NAV_ITEMS.filter(item => navItemAllowed(item, { isAdmin: props.isAdmin, emailConfigured: props.emailConfigured })).map(item => ({ ...item, section: t('nav.system') })),
  ].map(item => ({
    id: `page:${item.path}`, group: 'pages' as const, label: t(`nav.${item.label}`), hint: item.section, icon: item.icon,
    keywords: [item.label, item.path], run: () => go(item.path),
  }))
  const capture: Entry[] = CAPTURE_NAV_ITEMS.map(item => ({
    id: `page:${item.path}`, group: 'pages' as const, label: t(item.labelKey), hint: '', icon: item.icon,
    keywords: [item.path.slice(1), item.path], run: () => go(item.path),
  }))
  return [...nav, ...capture]
})

const actions = computed<Entry[]>(() => {
  const list: Entry[] = [
    { id: 'action:new-strand', group: 'actions', label: t('palette.newStrand'), icon: 'edit', keywords: ['new', 'neu', 'create'], run: newStrand },
  ]
  if (commands.available('dictation.start')) list.push({ id: 'action:dictation', group: 'actions', label: t('palette.dictation'), hint: keys(['Ctrl', 'M']), icon: 'mic', keywords: ['dictation', 'diktat', 'voice'], run: async () => { await commands.run('dictation.start') } })
  if (commands.available('speech.readLast')) list.push({ id: 'action:read-last', group: 'actions', label: t('w4b.palette.readLast'), icon: 'volume', keywords: ['read aloud', 'vorlesen', 'speech', 'audio'], run: async () => { await commands.run('speech.readLast') } })
  if (commands.available('speech.summaryLast')) list.push({ id: 'action:summary-last', group: 'actions', label: t('w4b.palette.summaryLast'), icon: 'sparkles', keywords: ['audio summary', 'zusammenfassung', 'summary', 'audio'], run: async () => { await commands.run('speech.summaryLast') } })
  if (commands.available('strand.archive')) list.push({ id: 'action:archive', group: 'actions', label: t('palette.archive'), icon: 'archive', keywords: ['archive', 'archivieren'], run: async () => { await commands.run('strand.archive') } })
  list.push(
    { id: 'action:sidebar', group: 'actions', label: t('palette.sidebar'), hint: keys(['Ctrl', 'B']), icon: 'panelLeft', keywords: ['sidebar', 'leiste', 'navigation'], run: () => emit('toggleSidebar') },
    { id: 'action:theme', group: 'actions', label: isDark.value ? t('theme.switchToLight') : t('theme.switchToDark'), icon: isDark.value ? 'sun' : 'moon', keywords: ['theme', 'dark', 'light', 'hell', 'dunkel'], run: toggleTheme },
    { id: 'action:help', group: 'actions', label: t('palette.shortcuts'), hint: '?', icon: 'keyboard', keywords: ['help', 'hilfe', 'keyboard', 'tastatur'], run: () => emit('openHelp') },
  )
  return list
})

const strandEntries = computed<Entry[]>(() => strands.value.map(strand => ({
  id: `strand:${strand.id}`, group: 'strands' as const, label: strand.title || t('strandsW3.untitled'), hint: date(strand.lastActivity), icon: 'chat',
  run: () => go(`/strands/${encodeURIComponent(strand.id)}`),
})))
const messageEntries = computed<Entry[]>(() => messageHits.value.map(hit => ({
  id: `message:${hit.messageId}`, group: 'messages' as const, label: hit.snippet,
  hint: hit.strandTitle ?? t('strandsW3.untitled'), icon: hit.role === 'assistant' ? 'bot' : 'user',
  parts: snippetParts(hit),
  run: () => go(messageRoute(hit.strandId, hit.messageId)),
})))
const list = computed(() => buildPaletteList({ strands: strandEntries.value, messages: messageEntries.value, pages: pages.value, actions: actions.value, query: query.value }))
const sections = computed(() => groupPaletteList(list.value))
const activeId = computed(() => (cursor.value >= 0 && list.value[cursor.value] ? `palette-option-${cursor.value}` : undefined))
const searching = computed(() => paletteSearchTerm(query.value).length > 0)

let lastQuery = ''
watch(list, (next, previous) => {
  const previousId = previous?.[cursor.value]?.id ?? null
  cursor.value = keepCursor(query.value === lastQuery ? previousId : null, next)
  lastQuery = query.value
})
watch(query, () => scheduleSearch())
watch(cursor, () => nextTick(() => listEl.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })))

watch(() => props.open, (open, wasOpen) => {
  if (open === Boolean(wasOpen)) return
  overlay.setOverlayOpen(open)
  if (open) {
    query.value = ''
    lastQuery = ''
    cursor.value = 0
    scheduleSearch(true)
  } else {
    if (debounce) clearTimeout(debounce)
    latest.cancel()
    latestMessages.cancel()
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (props.open) overlay.setOverlayOpen(false)
  if (debounce) clearTimeout(debounce)
  latest.cancel()
  latestMessages.cancel()
})

function close() {
  emit('update:open', false)
}
async function runEntry(entry: Entry | undefined) {
  if (!entry) return
  close()
  await nextTick()
  await entry.run()
}
const NAV_KEYS: readonly string[] = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp']
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (NAV_KEYS.includes(event.key)) {
    event.preventDefault()
    cursor.value = moveCursor(cursor.value, list.value.length, event.key as PaletteKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void runEntry(list.value[cursor.value] as Entry | undefined)
  }
}
function retry() {
  scheduleSearch(true)
  input.value?.focus()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="value => emit('update:open', value)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-fade-in" />
      <DialogContent
        data-testid="command-palette"
        :aria-describedby="undefined"
        class="fixed inset-x-3 top-3 z-50 mx-auto flex max-h-[min(36rem,calc(100dvh-1.5rem))] max-w-[40rem] flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-overlay focus:outline-none sm:top-[12vh] sm:max-h-[min(36rem,76vh)]"
        @open-auto-focus.prevent="input?.focus()"
      >
        <DialogTitle class="sr-only">{{ t('palette.title') }}</DialogTitle>
        <div class="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4 text-muted-foreground">
          <AppIcon name="search" aria-hidden="true" />
          <input
            ref="input"
            v-model="query"
            data-testid="palette-input"
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="palette-list"
            :aria-activedescendant="activeId"
            :aria-label="t('palette.inputLabel')"
            :placeholder="t('palette.placeholder')"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="200"
            class="min-h-11 min-w-0 flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground focus:outline-none"
            @keydown="onKeydown"
          >
          <button type="button" class="inline-flex h-11 shrink-0 items-center rounded-md px-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('common.close')" @click="close">
            <kbd class="rounded-md border border-border bg-muted px-2 font-mono text-xs">Esc</kbd>
          </button>
        </div>

        <div id="palette-list" ref="listEl" role="listbox" :aria-label="t('palette.results')" class="min-h-0 flex-1 overflow-y-auto p-2" data-testid="palette-list">
          <div v-for="section in sections" :key="section.group" role="group" :aria-labelledby="`palette-group-${section.group}`">
            <div :id="`palette-group-${section.group}`" role="presentation" class="px-3 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{{ section.group === 'messages' ? t('search.inMessages') : t(`palette.group.${section.group}`) }}</div>
            <div
              v-for="{ entry, index } in section.items"
              :id="`palette-option-${index}`"
              :key="entry.id"
              role="option"
              :aria-selected="index === cursor"
              :data-entry="entry.id"
              class="relative flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm"
              :class="index === cursor ? 'bg-selected-container text-on-selected-container selected-marker' : 'text-foreground'"
              @click="runEntry(entry as Entry)"
              @mousemove="cursor = index"
            >
              <AppIcon :name="entry.icon" size="sm" class="shrink-0" :class="index === cursor ? '' : 'text-muted-foreground'" aria-hidden="true" />
              <span v-if="entry.parts" class="min-w-0 flex-1 truncate" data-message-snippet><template v-for="(part, pi) in entry.parts" :key="pi"><mark v-if="part.match" class="rounded-sm bg-primary-subtle-hover px-1 text-foreground">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
              <span v-else class="min-w-0 flex-1 truncate">{{ entry.label }}</span>
              <span v-if="entry.hint" class="shrink-0 text-xs" :class="[index === cursor ? '' : 'text-muted-foreground', entry.parts ? 'max-w-[40%] truncate' : '']">{{ entry.hint }}</span>
            </div>
          </div>

          <!-- Strand search states; pages and actions stay usable meanwhile. -->
          <div v-if="strandState === 'loading' && !strands.length" class="flex min-h-11 items-center gap-2 px-3 text-sm text-muted-foreground" data-testid="palette-loading">
            <AppIcon name="loader" size="sm" class="motion-safe:animate-spin" aria-hidden="true" />{{ t('palette.loading') }}
          </div>
          <div v-else-if="strandState === 'error'" class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="palette-error" role="alert">
            <span class="min-w-0 flex-1 text-destructive">{{ t('palette.error') }}</span>
            <button type="button" class="min-h-11 rounded-md border border-border px-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="retry">{{ t('palette.retry') }}</button>
          </div>
          <p v-else-if="strandState === 'ready' && searching && !strands.length && list.length" class="px-3 py-2 text-sm text-muted-foreground" data-testid="palette-no-strands">{{ t('palette.noStrands') }}</p>
          <!-- W5b message search states (the hits themselves are a group above). -->
          <div v-if="messageState === 'loading' && !messageHits.length" class="flex min-h-11 items-center gap-2 px-3 text-sm text-muted-foreground" data-testid="palette-messages-loading">
            <AppIcon name="loader" size="sm" class="motion-safe:animate-spin" aria-hidden="true" />{{ t('search.loading') }}
          </div>
          <div v-else-if="messageState === 'error'" class="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid="palette-messages-error" role="alert">
            <span class="min-w-0 flex-1 text-destructive">{{ t('search.error') }}</span>
            <button type="button" class="min-h-11 rounded-md border border-border px-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="retry">{{ t('palette.retry') }}</button>
          </div>
          <p v-else-if="messageState === 'ready' && !messageHits.length && list.length" class="px-3 py-2 text-sm text-muted-foreground" data-testid="palette-no-messages">{{ t('search.noMessages') }}</p>
          <div v-if="!list.length && messageState !== 'loading' && strandState !== 'loading' && strandState !== 'error'" class="px-3 py-8 text-center" data-testid="palette-empty">
            <p class="text-sm font-semibold">{{ t('palette.empty') }}</p>
            <p class="mt-1 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{{ t('palette.emptyHint', { q: paletteSearchTerm(query) }) }}</p>
          </div>
        </div>

        <div class="hidden shrink-0 gap-4 border-t border-border px-4 py-2 text-xs text-muted-foreground sm:flex" aria-hidden="true">
          <span><kbd class="rounded-md border border-border bg-muted px-2 font-mono">↑</kbd> <kbd class="rounded-md border border-border bg-muted px-2 font-mono">↓</kbd> {{ t('palette.footMove') }}</span>
          <span><kbd class="rounded-md border border-border bg-muted px-2 font-mono">Enter</kbd> {{ t('palette.footRun') }}</span>
          <span><kbd class="rounded-md border border-border bg-muted px-2 font-mono">Esc</kbd> {{ t('palette.footClose') }}</span>
        </div>
        <p class="sr-only" aria-live="polite">{{ strandState === 'loading' ? t('palette.loading') : t('palette.count', { count: list.length }) }}</p>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
