<template>
  <!-- First Tab stop on every page: jump past sidebar and header straight to the page content. -->
  <a
    href="#main-content"
    data-testid="skip-link"
    class="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-[100] focus-visible:inline-flex focus-visible:min-h-11 focus-visible:items-center focus-visible:rounded-md focus-visible:bg-background focus-visible:px-4 focus-visible:text-sm focus-visible:font-medium focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    @click.prevent="skipToContent"
  >{{ $t('aria.skipToContent') }}</a>
  <!-- Mobile sidebar overlay -->
  <Transition
    enter-active-class="transition-opacity duration-200 ease-out"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-150 ease-in"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-scrim"
      aria-hidden="true"
      @click="sidebarOpen = false"
    />
  </Transition>

  <div class="flex h-full overflow-hidden">
    <!-- Keeps the page still while the labelled sidebar floats over the icon rail. -->
    <div v-if="sidebarOpen && effectiveMode === 'rail'" class="w-14 shrink-0" aria-hidden="true" />
    <!-- Sidebar -->
    <Transition
      enter-active-class="transition-transform duration-250 ease-out"
      enter-from-class="-translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="-translate-x-full"
    >
      <!-- Desktop: labelled 256 px, icons 56 px or hidden (remembered per
           device, Ctrl+B / Ctrl+\ hides it and brings back the last mode).
           Mobile: the labelled drawer as before. -->
      <aside
        v-show="sidebarOpen || effectiveMode !== 'hidden'"
        ref="sidebarEl"
        data-testid="shell-sidebar"
        :role="sidebarOpen ? 'dialog' : undefined"
        :aria-modal="sidebarOpen ? 'true' : undefined"
        @keydown.tab="trapDrawerFocus"
        :data-mode="sidebarOpen ? 'drawer' : effectiveMode"
        class="flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar"
        :class="sidebarOpen ? 'fixed inset-y-0 left-0 z-50 w-64 shadow-overlay' : compact ? 'static w-14' : 'static w-64'"
        :aria-label="$t('shell.sidebar')"
      >
        <!-- Sidebar header -->
        <div class="flex items-center gap-3 border-b border-sidebar-border py-4" :class="compact ? 'justify-center px-1' : 'px-5'">
          <AppLogo />
          <div v-if="!compact" class="min-w-0">
            <span class="block truncate text-lg font-bold text-sidebar-foreground">
              {{ $t('app.title') }}
            </span>
            <p class="mt-0.5 text-xs text-muted-foreground">
              v{{ appVersion }}
            </p>
          </div>
        </div>

        <!-- Navigation -->
        <ShellNavigation :path="route.path" :compact="compact" :is-admin="isAdmin" :email-configured="emailConfigured" @navigate="closeSidebarOnMobile" />

        <!-- Sidebar footer — user menu -->
        <div class="border-t border-sidebar-border">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                class="flex w-full cursor-pointer items-center gap-2.5 py-3.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                :class="compact ? 'justify-center px-1' : 'px-4'"
                :aria-label="$t('aria.userMenu')"
              >
                <!-- Avatar -->
                <img
                  v-if="userAvatarUrl && !avatarFailed"
                  :src="userAvatarUrl"
                  :alt="user?.username"
                  class="h-9 w-9 shrink-0 rounded-full object-cover ring-1 ring-primary/25"
                  @error="onAvatarError"
                >
                <span
                  v-else
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-primary ring-1 ring-primary/25"
                >
                  {{ userInitial }}
                </span>
                <!-- Name + role -->
                <div v-if="!compact" class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm font-medium text-sidebar-foreground leading-none">{{ user?.username }}</span>
                  <span class="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">
                    {{ isAdmin ? $t('roles.admin') : $t('roles.user') }}
                  </span>
                </div>
                <!-- Open indicator -->
                <AppIcon v-if="!compact" name="chevronsUpDown" size="sm" class="shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent :align="compact ? 'start' : 'center'" :side="compact ? 'right' : 'top'" class="w-56">
              <DropdownMenuLabel>
                {{ user?.username }}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <AppIcon name="globe" size="sm" />
                  {{ $t('common.language') }}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                <DropdownMenuItem
                  v-for="loc in localeList"
                  :key="loc.code"
                  @click="setLocale(loc.code as 'en' | 'de')"
                >
                  {{ loc.name }}
                  <AppIcon v-if="locale === loc.code" name="check" size="sm" class="ml-auto" />
                </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive @click="handleLogout">
                <AppIcon name="close" size="sm" />
                {{ $t('auth.logout') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </Transition>

    <!-- Main area -->
    <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <!-- Header -->
      <!--
        Mobile left padding is `pl-1` (4px) so the hamburger icon sits
        with equal top and left distance to the header edge (both = 12px
        given h-12 header, h-10 button, xl 24px icon). Desktop keeps the
        normal px-6. Right side stays pr-4 for the teleported action row.
      -->
      <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background/90 pl-1 pr-4 backdrop-blur-md md:px-6">
        <!-- Mobile hamburger -->
        <button
          type="button"
          class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          :aria-label="$t('aria.toggleSidebar')"
          @click="sidebarOpen = !sidebarOpen"
        >
          <AppIcon name="menu" size="xl" />
        </button>

        <!-- Desktop sidebar toggle: labelled <-> icons; brings a hidden sidebar back. -->
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              data-testid="sidebar-toggle"
              class="-ml-3 hidden h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
              :aria-label="sidebarToggleLabel"
              :aria-pressed="labelled"
              @click="toggleSidebarCompact"
            >
              <AppIcon :name="labelled ? 'panelLeftClose' : 'panelLeftOpen'" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ sidebarToggleLabel }} (Ctrl+B)</TooltipContent>
        </Tooltip>

        <!-- Connection status (desktop only) -->
        <div v-if="globalHealthMonitorEnabled" class="hidden items-center gap-2 md:flex">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="statusDotClass"
            aria-hidden="true"
          />
          <span class="hidden text-sm text-muted-foreground sm:block">{{ statusText }}</span>
        </div>

        <!-- Fallback mode indicator (desktop only) -->
        <Tooltip v-if="globalHealthMonitorEnabled && isInFallbackMode">
          <TooltipTrigger as-child>
            <div class="hidden items-center gap-1.5 rounded-md bg-warning/10 px-2.5 py-1 ring-1 ring-warning/30 md:flex">
              <span class="h-2 w-2 shrink-0 rounded-full bg-warning" />
              <span class="text-xs font-medium text-warning">{{ t('status.fallback') }}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {{ globalFallbackProviderName
              ? t('status.fallbackTooltip', { provider: globalFallbackProviderName })
              : t('status.fallbackActive')
            }}
          </TooltipContent>
        </Tooltip>

        <!-- Subscriber quota (desktop, wide viewports only) -->
        <div v-if="quotaTopBarParts.length > 0" class="hidden items-center gap-2 lg:flex">
          <template v-for="(part, idx) in quotaTopBarParts" :key="part.key">
            <span v-if="idx > 0" class="text-muted-foreground/40">·</span>
            <span class="text-xs">
              <span class="font-medium" :class="part.colorClass">{{ part.label }}: {{ part.utilization }}%</span>
              <span v-if="part.reset" class="text-muted-foreground"> ({{ part.reset }})</span>
            </span>
          </template>
        </div>

        <!-- Spacer -->
        <div class="flex-1" />

        <!--
          Mobile teleport target for page-specific actions.
          Pages render their <PageHeader #actions> content here on mobile via <Teleport>.
          Kept md:hidden so the same slot content can appear in its own desktop toolbar without duplication.
        -->
        <div
          id="page-toolbar-actions"
          class="flex min-w-0 items-center gap-1.5 md:hidden"
        />

        <!-- Command palette: the keyboard way in (Ctrl/Cmd+K), also reachable by touch. -->
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              data-testid="palette-trigger"
              class="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:border lg:border-border lg:px-3"
              :aria-label="$t('palette.open')"
              aria-haspopup="dialog"
              :aria-expanded="paletteOpen"
              @click="paletteOpen = true"
            >
              <AppIcon name="search" />
              <span class="hidden text-sm lg:inline">{{ $t('palette.trigger') }}</span>
              <kbd class="hidden rounded-md border border-border bg-muted px-1.5 font-mono text-xs lg:inline">{{ paletteKeys }}</kbd>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ $t('palette.open') }} ({{ paletteKeys }})</TooltipContent>
        </Tooltip>

        <!-- Theme toggle preserves the user preference on every screen size. -->
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
              :aria-label="$t('aria.themeToggle')"
              @click="toggleTheme"
            >
              <AppIcon :name="isDark ? 'sun' : 'moon'" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {{ isDark ? $t('theme.switchToLight') : $t('theme.switchToDark') }}
          </TooltipContent>
        </Tooltip>
      </header>

      <!-- Page content -->
      <main id="main-content" tabindex="-1" class="flex flex-1 flex-col overflow-hidden focus:outline-none">
        <slot />
      </main>
      <ShellNavigation mobile :path="route.path" :is-admin="isAdmin" :email-configured="emailConfigured" />
      <CommandPalette v-model:open="paletteOpen" :is-admin="isAdmin" :email-configured="emailConfigured" @toggle-sidebar="toggleSidebar" @open-help="openHelp" />
      <ShortcutHelp v-model:open="helpOpen" />
    </div>
  </div>
</template>

<script setup lang="ts">
/** Skip link target: focus the page content (no scroll jump; `main` scrolls inside). */
function skipToContent() {
  const target = document.getElementById('main-content')
  target?.focus({ preventScroll: true })
}
import { useMediaQuery } from '@vueuse/core'
import { useEmailApi } from '~/api/email'
import { useShellLayout } from '~/composables/useShellLayout'
import { onShortcut } from '~/composables/useShortcuts'
import { isMacPlatform } from '~/utils/shortcuts'

const route = useRoute()
const runtimeConfig = useRuntimeConfig()
const appVersion = runtimeConfig.public.appVersion as string
const { user, logout } = useAuth()
const { status: globalStatus, providerName: globalProviderName, operatingMode: globalOperatingMode, fallbackProviderName: globalFallbackProviderName, healthMonitorEnabled: globalHealthMonitorEnabled, quota: globalQuota, start: startStatusPolling, stop: stopStatusPolling } = useConnectionStatus()

const isInFallbackMode = computed(() => globalOperatingMode.value === 'fallback')
const { isDark, toggle: toggleTheme } = useTheme()

const sidebarOpen = ref(false)
const isMobile = useMediaQuery('(max-width: 767px)')
const shell = useShellLayout()
/** Mode drawn at this width: icons below 1280 px even when "labelled" is stored. */
const effectiveMode = shell.effectiveMode
const compact = computed(() => !sidebarOpen.value && effectiveMode.value === 'rail')
const labelled = computed(() => sidebarOpen.value || effectiveMode.value === 'full')
const sidebarToggleLabel = computed(() => (labelled.value ? t('shell.sidebarCollapse') : t('shell.sidebarExpand')))
/** Header button: labelled <-> icons. Where the window is too narrow for a labelled column it floats over the page. */
function toggleSidebarCompact() {
  if (sidebarOpen.value) sidebarOpen.value = false
  else if (shell.sidebarMode.value === 'full' && effectiveMode.value === 'rail') sidebarOpen.value = true
  else shell.toggleSidebarCompact()
}
/** Ctrl+B / Ctrl+\: desktop hides the sidebar completely and back; mobile opens the drawer. */
function toggleSidebar() {
  if (isMobile.value || sidebarOpen.value) sidebarOpen.value = !sidebarOpen.value
  else shell.toggleSidebarHidden()
}
onShortcut('sidebar.toggle', toggleSidebar)
const paletteOpen = ref(false)
const helpOpen = ref(false)
const paletteKeys = ref('Ctrl K')
onMounted(() => { if (isMacPlatform(navigator)) paletteKeys.value = '⌘ K' })
/** Ctrl/Cmd+K toggles the palette from anywhere, also from fields and over the help. */
onShortcut('palette.toggle', () => {
  helpOpen.value = false
  paletteOpen.value = !paletteOpen.value
})
function openHelp() {
  paletteOpen.value = false
  helpOpen.value = true
}
onShortcut('help.open', openHelp)
onShortcut('dismiss', () => {
  if (!sidebarOpen.value) return false
  sidebarOpen.value = false
})

// The floating drawer is modal: focus moves into it, Tab stays inside, and on
// close focus goes back to whatever opened it (hamburger, header button, Ctrl+B).
const sidebarEl = ref<HTMLElement | null>(null)
let drawerOpener: HTMLElement | null = null
const drawerFocusables = () => Array.from(sidebarEl.value?.querySelectorAll<HTMLElement>(
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
) ?? []).filter(el => el.offsetParent !== null || el === document.activeElement)
watch(sidebarOpen, async (open) => {
  if (!import.meta.client) return
  if (open) {
    drawerOpener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    await nextTick()
    drawerFocusables()[0]?.focus({ preventScroll: true })
    return
  }
  const opener = drawerOpener
  drawerOpener = null
  // Only restore when focus is still in the drawer (or lost): a route change already moved on.
  const active = document.activeElement
  if (opener?.isConnected && (!active || active === document.body || sidebarEl.value?.contains(active))) {
    await nextTick()
    opener.focus({ preventScroll: true })
  }
})
function trapDrawerFocus(event: KeyboardEvent) {
  if (!sidebarOpen.value) return
  const items = drawerFocusables()
  if (items.length === 0) return
  const first = items[0]!, last = items[items.length - 1]!
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}

const isAdmin = computed(() => user.value?.role === 'admin')

const emailApi = useEmailApi()
const emailConfigured = ref(false)
watch(() => route.path, async () => {
  try {
    emailConfigured.value = (await emailApi.isConfigured()).configured
  } catch {
    emailConfigured.value = false
  }
}, { immediate: true })
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = useUserAvatar()

const statusDotClass = computed(() => {
  switch (globalStatus.value) {
    case 'healthy': return 'bg-success'
    case 'degraded': return 'bg-warning'
    default: return 'bg-muted-foreground'
  }
})

const { t, locale, locales, setLocale } = useI18n()

const localeList = computed(() => (locales.value as Array<{ code: string; name: string }>))
const statusText = computed(() => {
  switch (globalStatus.value) {
    case 'healthy': {
      const name = globalProviderName.value
      return name ? t('status.healthy', { provider: name }) : t('status.online')
    }
    case 'degraded': {
      const name = globalProviderName.value
      return name ? t('status.degraded', { provider: name }) : t('status.degraded', { provider: '' })
    }
    default:
      return t('status.offline')
  }
})

const { quotaWindowParts } = useQuotaFormat()

const quotaTopBarParts = computed(() => {
  const q = globalQuota.value
  if (!q || q.error) return []
  return quotaWindowParts(q)
})

onMounted(() => {
  startStatusPolling()
})

onUnmounted(() => {
  stopStatusPolling()
})

function closeSidebarOnMobile() {
  sidebarOpen.value = false
}

function handleLogout() {
  void logout()
}

// Close the floating sidebar (drawer / overlay) when the route changes
watch(route, () => {
  sidebarOpen.value = false
})
</script>
