<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFeed } from '~/composables/useFeed'
import { useChat } from '~/composables/useChat'
import { useStorage } from '@vueuse/core'
import { CAPTURE_NAV_ITEMS, PRIMARY_NAV_ITEMS, SYSTEM_NAV_ITEMS, navItemAllowed } from '~/utils/shellNav'
import { useUnsortedCount } from '~/composables/useUnsortedCount'

const props = withDefaults(defineProps<{ mobile?: boolean; compact?: boolean; isAdmin?: boolean; emailConfigured?: boolean; path: string }>(), {
  mobile: false, compact: false, isAdmin: false, emailConfigured: false,
})
const { unreadCount, refreshCount } = useFeed()
const unsorted = useUnsortedCount()
const chat = useChat()
let releaseConnection: (() => void) | undefined
onMounted(() => {
  void refreshCount()
  void unsorted.refresh()
  releaseConnection = chat.retainConnection()
})
onUnmounted(() => {
  releaseConnection?.()
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onSheetKeydown)
})
const emit = defineEmits<{ navigate: [] }>()
const systemOpen = useStorage('offtangent-system-navigation-open', false)
const primary = PRIMARY_NAV_ITEMS
const captureItems = CAPTURE_NAV_ITEMS
const systemItems = computed(() => SYSTEM_NAV_ITEMS.filter(item => navItemAllowed(item, { isAdmin: props.isAdmin, emailConfigured: props.emailConfigured })))
const settingsItem = computed(() => systemItems.value.find(item => item.path === '/settings') ?? null)
function active(current: string, target: string) {
  return current === target || (target !== '/' && current.startsWith(`${target}/`))
}
const inSystem = computed(() => systemItems.value.some(item => active(props.path, item.path)))
const inCapture = computed(() => captureItems.some(item => active(props.path, item.path)))
// Leaving the tray (a decision may have changed it) refreshes the badge.
watch(() => props.path, (_next, previous) => { if (previous === '/unsorted' || previous === '/') void unsorted.refresh() })
/**
 * The block opens by itself while a System page is shown. A click on the
 * header still closes it for that page; the next navigation restores the rule.
 */
const autoClosed = ref(false)
watch(() => props.path, () => { autoClosed.value = false })
const expanded = computed(() => systemOpen.value || (inSystem.value && !autoClosed.value))
function toggleSystem() {
  if (expanded.value) {
    systemOpen.value = false
    if (inSystem.value) autoClosed.value = true
  } else {
    systemOpen.value = true
    autoClosed.value = false
  }
}

/* Mobile: four main areas plus "More", which opens the System list as a sheet. */
/* Modal sheet: focus moves in on open, Tab stays inside, Esc closes and */
/* focus returns to "More" (unless a link inside navigated away).        */
const sheetOpen = ref(false)
const moreButton = ref<HTMLButtonElement | null>(null)
const sheetPanel = ref<HTMLElement | null>(null)
const sheetClose = ref<HTMLButtonElement | null>(null)
function onSheetKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSheet()
    return
  }
  if (event.key !== 'Tab' || !sheetPanel.value) return
  const focusable = [...sheetPanel.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
  if (!focusable.length) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  const current = document.activeElement
  if (event.shiftKey && (current === first || !sheetPanel.value.contains(current))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (current === last || !sheetPanel.value.contains(current))) {
    event.preventDefault()
    first.focus()
  }
}
function openSheet() {
  sheetOpen.value = true
  window.addEventListener('keydown', onSheetKeydown)
  void nextTick(() => sheetClose.value?.focus())
}
function closeSheet(restoreFocus = true) {
  sheetOpen.value = false
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onSheetKeydown)
  if (restoreFocus) void nextTick(() => moreButton.value?.focus())
}
/**
 * Desktop entries. Active = filled surface plus a 3 px marker on the leading
 * edge (shape, not colour alone); icons-only mode keeps a 44 px target and
 * names the entry through `aria-label` and a tooltip.
 */
function entryClass(isActive: boolean) {
  return [
    'relative flex min-h-11 items-center rounded-lg text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    props.compact ? 'w-11 justify-center' : 'gap-3 px-3 py-2',
    isActive
      ? 'bg-primary-container text-on-primary-container before:absolute before:inset-y-2 before:-left-1.5 before:w-[3px] before:rounded-full before:bg-primary'
      : 'text-sidebar-foreground hover:bg-accent',
  ]
}
function navigateFromSheet() {
  closeSheet(false)
  emit('navigate')
}
</script>

<template>
  <nav v-if="mobile" :aria-label="$t('nav.primary')" class="grid shrink-0 grid-cols-5 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
    <NuxtLink v-for="item in primary" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
      class="relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-2xs font-medium"
      :class="active(path, item.path) ? 'bg-primary-container text-on-primary-container before:absolute before:inset-x-4 before:top-0 before:h-[3px] before:rounded-full before:bg-primary' : 'text-muted-foreground'" @click="emit('navigate')">
      <AppIcon :name="item.icon" />
      <span class="w-full truncate px-0.5 text-center">{{ $t(`nav.${item.label}`) }}</span>
      <span v-if="item.path === '/feed' && unreadCount > 0" class="h-2 w-2 shrink-0 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
    </NuxtLink>
    <button ref="moreButton" type="button" data-testid="nav-more" class="relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-2xs font-medium"
      :class="inSystem || inCapture || sheetOpen ? 'bg-primary/10 text-primary' : 'text-muted-foreground'"
      :aria-expanded="sheetOpen" aria-controls="system-sheet" aria-haspopup="dialog" @click="sheetOpen ? closeSheet() : openSheet()">
      <AppIcon name="more" />
      <span class="w-full truncate px-0.5 text-center">{{ $t('nav.more') }}</span>
      <span v-if="unsorted.label.value" class="absolute right-3 top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <div v-if="sheetOpen" class="fixed inset-0 z-50 md:hidden">
        <div class="absolute inset-0 bg-scrim" aria-hidden="true" @click="closeSheet()" />
        <div id="system-sheet" ref="sheetPanel" role="dialog" aria-modal="true" :aria-label="$t('nav.system')"
          class="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-background p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-overlay">
          <div class="mb-1 flex items-center justify-between gap-2 px-2">
            <h2 class="text-sm font-semibold text-muted-foreground">{{ $t('nav.system') }}</h2>
            <button ref="sheetClose" type="button" data-testid="nav-sheet-close" class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="$t('common.close')" @click="closeSheet()">
              <AppIcon name="close" />
            </button>
          </div>
          <div class="mb-2 grid grid-cols-1 gap-1 border-b border-border pb-2 min-[360px]:grid-cols-2" data-testid="nav-sheet-capture">
            <NuxtLink v-for="item in captureItems" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
              class="flex min-h-12 min-w-0 items-center gap-3 rounded-lg px-3 text-sm font-medium"
              :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'" @click="navigateFromSheet">
              <AppIcon :name="item.icon" /><span class="min-w-0 flex-1 truncate">{{ $t(item.labelKey) }}</span>
              <span v-if="item.counter && unsorted.label.value" class="shrink-0 rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">{{ unsorted.label.value }}<span class="sr-only"> {{ $t('unsorted.navCount', { count: unsorted.label.value }) }}</span></span>
            </NuxtLink>
          </div>
          <div class="grid grid-cols-1 gap-1 min-[360px]:grid-cols-2">
            <NuxtLink v-for="item in systemItems" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
              class="flex min-h-12 min-w-0 items-center gap-3 rounded-lg px-3 text-sm font-medium"
              :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'" @click="navigateFromSheet">
              <AppIcon :name="item.icon" /><span class="truncate">{{ $t(`nav.${item.label}`) }}</span>
            </NuxtLink>
          </div>
        </div>
      </div>
    </Teleport>
  </nav>
  <nav v-else :aria-label="$t('nav.primary')" data-testid="nav-desktop" :data-compact="compact ? 'true' : undefined"
    class="flex flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden py-3.5" :class="compact ? 'items-center px-1.5' : 'p-2.5'">
    <div class="hidden space-y-1 md:block">
      <template v-for="item in primary" :key="item.path">
        <Tooltip v-if="compact">
          <TooltipTrigger as-child>
            <NuxtLink :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined" :aria-label="$t(`nav.${item.label}`)"
              :class="entryClass(active(path, item.path))" @click="emit('navigate')">
              <AppIcon :name="item.icon" />
              <span v-if="item.path === '/feed' && unreadCount > 0" class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
            </NuxtLink>
          </TooltipTrigger>
          <TooltipContent side="right">{{ $t(`nav.${item.label}`) }}</TooltipContent>
        </Tooltip>
        <NuxtLink v-else :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
          :class="entryClass(active(path, item.path))" @click="emit('navigate')">
          <AppIcon :name="item.icon" /><span>{{ $t(`nav.${item.label}`) }}</span>
          <span v-if="item.path === '/feed' && unreadCount > 0" class="h-2 w-2 shrink-0 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
        </NuxtLink>
      </template>
      <template v-for="item in captureItems" :key="item.path">
        <Tooltip v-if="compact">
          <TooltipTrigger as-child>
            <NuxtLink :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined" :aria-label="$t(item.labelKey)" :data-testid="`nav-capture-${item.path.slice(1)}`"
              :class="entryClass(active(path, item.path))" @click="emit('navigate')">
              <AppIcon :name="item.icon" />
              <span v-if="item.counter && unsorted.label.value" class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('unsorted.navCount', { count: unsorted.label.value }) }}</span></span>
            </NuxtLink>
          </TooltipTrigger>
          <TooltipContent side="right">{{ $t(item.labelKey) }}</TooltipContent>
        </Tooltip>
        <NuxtLink v-else :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined" :data-testid="`nav-capture-${item.path.slice(1)}`"
          :class="entryClass(active(path, item.path))" @click="emit('navigate')">
          <AppIcon :name="item.icon" /><span class="min-w-0 flex-1 truncate">{{ $t(item.labelKey) }}</span>
          <span v-if="item.counter && unsorted.label.value" class="shrink-0 rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground">{{ unsorted.label.value }}<span class="sr-only"> {{ $t('unsorted.navCount', { count: unsorted.label.value }) }}</span></span>
        </NuxtLink>
      </template>
    </div>
    <template v-if="systemItems.length">
      <Tooltip v-if="compact">
        <TooltipTrigger as-child>
          <button type="button" data-testid="nav-system-toggle" class="mt-2 flex min-h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-expanded="expanded" aria-controls="system-navigation" :aria-label="$t('nav.system')" @click="toggleSystem">
            <AppIcon :name="expanded ? 'chevronDown' : 'more'" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{{ $t('nav.system') }}</TooltipContent>
      </Tooltip>
      <button v-else type="button" data-testid="nav-system-toggle" class="mt-2 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-expanded="expanded" aria-controls="system-navigation" @click="toggleSystem">
        <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" /><span>{{ $t('nav.system') }}</span>
      </button>
      <div v-show="expanded" id="system-navigation" class="space-y-1">
        <template v-for="item in systemItems" :key="item.path">
          <Tooltip v-if="compact">
            <TooltipTrigger as-child>
              <NuxtLink :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined" :aria-label="$t(`nav.${item.label}`)"
                :class="entryClass(active(path, item.path))" @click="emit('navigate')">
                <AppIcon :name="item.icon" />
              </NuxtLink>
            </TooltipTrigger>
            <TooltipContent side="right">{{ $t(`nav.${item.label}`) }}</TooltipContent>
          </Tooltip>
          <NuxtLink v-else :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
            :class="entryClass(active(path, item.path))" @click="emit('navigate')">
            <AppIcon :name="item.icon" /><span>{{ $t(`nav.${item.label}`) }}</span>
          </NuxtLink>
        </template>
      </div>
    </template>
    <!-- Settings stays one click away, whatever the System block does. -->
    <div v-if="settingsItem" class="mt-auto border-t border-sidebar-border pt-2" :class="compact ? 'flex justify-center' : ''">
      <Tooltip v-if="compact">
        <TooltipTrigger as-child>
          <NuxtLink :to="settingsItem.path" data-testid="nav-settings-pinned" :aria-current="!expanded && active(path, settingsItem.path) ? 'page' : undefined" :aria-label="$t(`nav.${settingsItem.label}`)"
            :class="entryClass(active(path, settingsItem.path))" @click="emit('navigate')">
            <AppIcon :name="settingsItem.icon" />
          </NuxtLink>
        </TooltipTrigger>
        <TooltipContent side="right">{{ $t(`nav.${settingsItem.label}`) }}</TooltipContent>
      </Tooltip>
      <NuxtLink v-else :to="settingsItem.path" data-testid="nav-settings-pinned" :aria-current="!expanded && active(path, settingsItem.path) ? 'page' : undefined"
        :class="entryClass(active(path, settingsItem.path))" @click="emit('navigate')">
        <AppIcon :name="settingsItem.icon" /><span>{{ $t(`nav.${settingsItem.label}`) }}</span>
      </NuxtLink>
    </div>
  </nav>
</template>
