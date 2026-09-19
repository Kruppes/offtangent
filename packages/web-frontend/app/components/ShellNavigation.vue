<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useFeed } from '~/composables/useFeed'
import { useChat } from '~/composables/useChat'
import { useStorage } from '@vueuse/core'

withDefaults(defineProps<{ mobile?: boolean; isAdmin?: boolean; emailConfigured?: boolean; path: string }>(), {
  mobile: false, isAdmin: false, emailConfigured: false,
})
const { unreadCount, refreshCount } = useFeed()
const chat = useChat()
let releaseConnection: (() => void) | undefined
onMounted(() => {
  void refreshCount()
  releaseConnection = chat.retainConnection()
})
onUnmounted(() => releaseConnection?.())
const emit = defineEmits<{ navigate: [] }>()
const systemOpen = useStorage('offtangent-system-navigation-open', false)
const primary = [
  { path: '/', label: 'home', icon: 'inbox' },
  { path: '/strands', label: 'strands', icon: 'chat' },
  { path: '/feed', label: 'feed', icon: 'activity' },
  { path: '/projects', label: 'projects', icon: 'folder' },
  { path: '/memory', label: 'memory', icon: 'brain' },
] as const
const system = [
  { path: '/dashboard', label: 'dashboard', icon: 'dashboard' },
  { path: '/tasks', label: 'tasks', icon: 'tasks' },
  { path: '/cronjobs', label: 'cronjobs', icon: 'calendar' },
  { path: '/logs', label: 'logs', icon: 'logs' },
  { path: '/usage', label: 'usage', icon: 'trendDown' },
  { path: '/email', label: 'email', icon: 'mail' },
  { path: '/users', label: 'users', icon: 'users' },
  { path: '/providers', label: 'providers', icon: 'plug' },
  { path: '/skills', label: 'skills', icon: 'puzzle' },
  { path: '/personas', label: 'personas', icon: 'bot' },
  { path: '/instructions', label: 'instructions', icon: 'file' },
  { path: '/settings', label: 'settings', icon: 'settings' },
] as const
function active(current: string, target: string) {
  return current === target || (target !== '/' && current.startsWith(`${target}/`))
}
</script>

<template>
  <nav v-if="mobile" :aria-label="$t('nav.primary')" class="grid shrink-0 grid-cols-5 border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
    <NuxtLink v-for="item in primary" :key="item.path" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
      class="flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-medium"
      :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-muted-foreground'" @click="emit('navigate')">
      <AppIcon :name="item.icon" />
      <span>{{ $t(`nav.${item.label}`) }}</span>
      <span v-if="item.path === '/feed' && unreadCount > 0" class="h-2 w-2 shrink-0 rounded-full bg-primary" role="status"><span class="sr-only">{{ $t('feed.unreadCount', { count: unreadCount }) }}</span></span>
    </NuxtLink>
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
    <template v-if="isAdmin || emailConfigured">
      <button class="mt-2 flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium hover:bg-sidebar-accent" :aria-expanded="systemOpen" aria-controls="system-navigation" @click="systemOpen = !systemOpen">
        <AppIcon :name="systemOpen ? 'chevronDown' : 'chevronRight'" /><span>{{ $t('nav.system') }}</span>
      </button>
      <div v-show="systemOpen" id="system-navigation" class="space-y-1">
        <template v-for="item in system" :key="item.path">
          <NuxtLink v-if="item.label === 'email' ? (isAdmin || emailConfigured) : isAdmin" :to="item.path" :aria-current="active(path, item.path) ? 'page' : undefined"
            class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium"
            :class="active(path, item.path) ? 'bg-primary/10 text-primary' : 'text-sidebar-foreground hover:bg-sidebar-accent'" @click="emit('navigate')">
            <AppIcon :name="item.icon" /><span>{{ $t(`nav.${item.label}`) }}</span>
          </NuxtLink>
        </template>
      </div>
    </template>
  </nav>
</template>
