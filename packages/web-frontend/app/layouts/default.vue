<template>
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
      class="fixed inset-0 z-40 bg-black/55 md:hidden"
      aria-hidden="true"
      @click="sidebarOpen = false"
    />
  </Transition>

  <div class="flex h-full overflow-hidden">
    <!-- Sidebar -->
    <Transition
      enter-active-class="transition-transform duration-250 ease-out"
      enter-from-class="-translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="-translate-x-full"
    >
      <aside
        v-show="sidebarOpen || !isMobile"
        class="fixed inset-y-0 left-0 z-50 flex w-[260px] flex-col border-r border-sidebar-border bg-sidebar md:static md:z-auto"
      >
        <!-- Sidebar header -->
        <div class="flex items-center gap-3 border-b border-sidebar-border/60 px-5 py-[18px]">
          <AppLogo />
          <div class="min-w-0">
            <span class="block truncate text-[18px] font-bold text-sidebar-foreground">
              {{ $t('app.title') }}
            </span>
            <p class="mt-0.5 text-xs text-muted-foreground">
              v{{ appVersion }}
            </p>
          </div>
        </div>

        <!-- Navigation -->
        <ShellNavigation :path="route.path" :is-admin="isAdmin" :email-configured="emailConfigured" @navigate="closeSidebarOnMobile" />

        <!-- Sidebar footer — user menu -->
        <div class="border-t border-sidebar-border/60">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <div
                class="flex w-full cursor-pointer items-center gap-2.5 px-4 py-[15px] hover:bg-sidebar-accent transition-colors"
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
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-sm font-medium text-sidebar-foreground leading-none">{{ user?.username }}</span>
                  <span class="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                    {{ isAdmin ? $t('roles.admin') : $t('roles.user') }}
                  </span>
                </div>
                <!-- Open indicator -->
                <AppIcon name="chevronsUpDown" size="sm" class="shrink-0 text-muted-foreground" />
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" side="top" class="w-[calc(260px-1.5rem)]">
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
          class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          :aria-label="$t('aria.toggleSidebar')"
          @click="sidebarOpen = !sidebarOpen"
        >
          <AppIcon name="menu" size="xl" />
        </button>

        <!-- Connection status (desktop only) -->
        <div v-if="globalHealthMonitorEnabled" class="hidden items-center gap-2 md:flex">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :class="statusDotClass"
            :aria-label="statusText"
          />
          <span class="hidden text-sm text-muted-foreground sm:block">{{ statusText }}</span>
        </div>

        <!-- Fallback mode indicator (desktop only) -->
        <Tooltip v-if="globalHealthMonitorEnabled && isInFallbackMode">
          <TooltipTrigger as-child>
            <div class="hidden items-center gap-1.5 rounded-md bg-warning/10 px-2.5 py-1 ring-1 ring-warning/30 md:flex">
              <span class="h-2 w-2 shrink-0 rounded-full bg-warning shadow-[0_0_6px_hsl(var(--warning))]" />
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
          class="flex items-center gap-1.5 md:hidden"
        />

        <!-- Theme toggle preserves the user preference on every screen size. -->
        <Tooltip>
          <TooltipTrigger as-child>
            <button
              type="button"
              class="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
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
      <main class="flex flex-1 flex-col overflow-hidden">
        <slot />
      </main>
      <ShellNavigation mobile :path="route.path" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { useEmailApi } from '~/api/email'

const route = useRoute()
const runtimeConfig = useRuntimeConfig()
const appVersion = runtimeConfig.public.appVersion as string
const { user, logout } = useAuth()
const { status: globalStatus, providerName: globalProviderName, operatingMode: globalOperatingMode, fallbackProviderName: globalFallbackProviderName, healthMonitorEnabled: globalHealthMonitorEnabled, quota: globalQuota, start: startStatusPolling, stop: stopStatusPolling } = useConnectionStatus()

const isInFallbackMode = computed(() => globalOperatingMode.value === 'fallback')
const { isDark, toggle: toggleTheme } = useTheme()

const sidebarOpen = ref(false)
const isMobile = useMediaQuery('(max-width: 767px)')

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
    case 'healthy': return 'bg-success shadow-[0_0_6px_hsl(var(--success))]'
    case 'degraded': return 'bg-warning shadow-[0_0_6px_hsl(var(--warning))]'
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
  if (isMobile.value) {
    sidebarOpen.value = false
  }
}

function handleLogout() {
  void logout()
}

// Close sidebar when route changes on mobile
watch(route, () => {
  if (isMobile.value) {
    sidebarOpen.value = false
  }
})
</script>
