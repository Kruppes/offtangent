<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFeed } from '~/composables/useFeed'
import { useChat } from '~/composables/useChat'
import { useStorage } from '@vueuse/core'

const props = withDefaults(defineProps<{ mobile?: boolean; isAdmin?: boolean; emailConfigured?: boolean; path: string }>(), {
  mobile: false, isAdmin: false, emailConfigured: false,
})
const { unreadCount, refreshCount } = useFeed()
const chat = useChat()
let releaseConnection: (() => void) | undefined
onMounted(() => {
  void refreshCount()
  releaseConnection = chat.retainConnection()
})
onUnmounted(() => {
  releaseConnection?.()
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onSheetKeydown)
})
const emit = defineEmits<{ navigate: [] }>()
const systemOpen = useStorage('offtangent-system-navigation-open', false)
/** The four main areas: the same as the app's tabs. */
const primary = [
  { path: '/', label: 'home', icon: 'inbox' },
  { path: '/strands', label: 'strands', icon: 'chat' },
  { path: '/feed', label: 'feed', icon: 'activity' },
  { path: '/boards', label: 'boards', icon: 'compass' },
] as const
/**
 * Everything else lives in the collapsible System block. `access` keeps the
 * rights exactly as before: projects and memory for everyone, email for
 * admins or when an email account is configured, the rest admin only.
 */
const system = [
  { path: '/projects', label: 'projects', icon: 'folder', access: 'all' },
  { path: '/memory', label: 'memory', icon: 'brain', access: 'all' },
  { path: '/dashboard', label: 'dashboard', icon: 'dashboard', access: 'admin' },
  { path: '/tasks', label: 'tasks', icon: 'tasks', access: 'admin' },
  { path: '/cronjobs', label: 'cronjobs', icon: 'calendar', access: 'admin' },
  { path: '/logs', label: 'logs', icon: 'logs', access: 'admin' },
  { path: '/usage', label: 'usage', icon: 'trendDown', access: 'admin' },
  { path: '/email', label: 'email', icon: 'mail', access: 'email' },
  { path: '/users', label: 'users', icon: 'users', access: 'admin' },
  { path: '/providers', label: 'providers', icon: 'plug', access: 'admin' },
  { path: '/connectors', label: 'connectors', icon: 'link', access: 'admin' },
  { path: '/skills', label: 'skills', icon: 'puzzle', access: 'admin' },
  { path: '/personas', label: 'personas', icon: 'bot', access: 'admin' },
  { path: '/instructions', label: 'instructions', icon: 'file', access: 'admin' },
  { path: '/settings', label: 'settings', icon: 'settings', access: 'admin' },
] as const
type SystemItem = typeof system[number]
function allowed(item: SystemItem): boolean {
  if (item.access === 'all') return true
  if (item.access === 'email') return props.isAdmin || props.emailConfigured
  return props.isAdmin
}
const systemItems = computed(() => system.filter(allowed))
const settingsItem = computed(() => systemItems.value.find(item => item.path === '/settings') ?? null)
function active(current: string, target: string) {
  return current === target || (target !== '/' && current.startsWith(`${target}/`))
}
const inSystem = computed(() => systemItems.value.some(item => active(props.path, item.path)))
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
function navigateFromSheet() {
  closeSheet(false)
  emit('navigate')
}
</script>

<template>
  <nav v-if="mobile" :aria-label="$t('nav.primary')" class="grid shrink-0 grid-cols-5 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
    <NuxtLink v-for="item in primary" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
      class="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-medium"
      :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-muted-foreground'" @click="emit('navigate')">
      <AppIcon :name="item.icon" />
      <span class="w-full truncate px-0.5 text-center">{{ $t(`nav.${item.label}`) }}</span>
      <span v-if="item.path === '/feed' && unreadCount > 0" class="h-2 w-2 shrink-0 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
    </NuxtLink>
    <button ref="moreButton" type="button" data-testid="nav-more" class="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-medium"
      :class="inSystem || sheetOpen ? 'bg-primary/10 text-primary' : 'text-muted-foreground'"
      :aria-expanded="sheetOpen" aria-controls="system-sheet" aria-haspopup="dialog" @click="sheetOpen ? closeSheet() : openSheet()">
      <AppIcon name="more" />
      <span class="w-full truncate px-0.5 text-center">{{ $t('nav.more') }}</span>
    </button>
    <Teleport to="body">
      <div v-if="sheetOpen" class="fixed inset-0 z-50 md:hidden">
        <div class="absolute inset-0 bg-black/55" aria-hidden="true" @click="closeSheet()" />
        <div id="system-sheet" ref="sheetPanel" role="dialog" aria-modal="true" :aria-label="$t('nav.system')"
          class="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl border-t border-border bg-background p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-xl">
          <div class="mb-1 flex items-center justify-between gap-2 px-2">
            <h2 class="text-sm font-semibold text-muted-foreground">{{ $t('nav.system') }}</h2>
            <button ref="sheetClose" type="button" data-testid="nav-sheet-close" class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="$t('common.close')" @click="closeSheet()">
              <AppIcon name="close" />
            </button>
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
  <nav v-else :aria-label="$t('nav.primary')" class="flex flex-1 flex-col gap-1 overflow-y-auto p-2.5 py-3.5">
    <div class="hidden space-y-1 md:block">
      <NuxtLink v-for="item in primary" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
        class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
        :class="active(path, item.path) ? 'bg-primary/10 text-primary ring-1 ring-primary/20' : 'text-sidebar-foreground hover:bg-sidebar-accent'" @click="emit('navigate')">
        <AppIcon :name="item.icon" /><span>{{ $t(`nav.${item.label}`) }}</span>
      <span v-if="item.path === '/feed' && unreadCount > 0" class="h-2 w-2 shrink-0 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
      </NuxtLink>
    </div>
    <template v-if="systemItems.length">
      <button type="button" data-testid="nav-system-toggle" class="mt-2 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-expanded="expanded" aria-controls="system-navigation" @click="toggleSystem">
        <AppIcon :name="expanded ? 'chevronDown' : 'chevronRight'" /><span>{{ $t('nav.system') }}</span>
      </button>
      <div v-show="expanded" id="system-navigation" class="space-y-1">
        <NuxtLink v-for="item in systemItems" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
          class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
          :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent'" @click="emit('navigate')">
          <AppIcon :name="item.icon" /><span>{{ $t(`nav.${item.label}`) }}</span>
        </NuxtLink>
      </div>
    </template>
    <!-- Settings stays one click away, whatever the System block does. -->
    <div v-if="settingsItem" class="mt-auto border-t border-sidebar-border/60 pt-2">
      <NuxtLink :to="settingsItem.path" data-testid="nav-settings-pinned" :aria-current="!expanded && active(path, settingsItem.path) ? 'page' : undefined"
        class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
        :class="active(path, settingsItem.path) ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent'" @click="emit('navigate')">
        <AppIcon :name="settingsItem.icon" /><span>{{ $t(`nav.${settingsItem.label}`) }}</span>
      </NuxtLink>
    </div>
  </nav>
</template>
