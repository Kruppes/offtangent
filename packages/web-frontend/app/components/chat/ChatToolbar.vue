<template>
    <!--
      Chat toolbar — uses the shared <PageHeader> (slim variant, no title)
      so on mobile the action buttons teleport into the layout header and
      the second bar disappears entirely.
    -->
    <PageHeader>
      <!--
        Connection status dot (desktop-only): lives in the default slot so
        it renders on the LEFT side of the toolbar. On mobile it's not
        needed — the global status indicator is hidden there too, and the
        Send button's disabled state already communicates offline state.
      -->
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="{
            'bg-success': connectionStatus === 'connected',
            'bg-warning animate-pulse': connectionStatus === 'connecting',
            'bg-muted-foreground': connectionStatus === 'disconnected',
          }"
        />
        <span class="hidden sm:inline">{{ chatStatusText }}</span>
      </div>
      <template #actions>
        <Button variant="outline" size="sm" class="min-h-11 min-w-11 gap-2 hover:border-destructive hover:text-destructive" :aria-label="$t('turnProgress.stopStrand')" :title="$t('turnProgress.stopStrandHint')" :disabled="!isStreaming" @click="$emit('stop')">
          <AppIcon name="square" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('turnProgress.stopStrand') }}</span>
        </Button>
        <!-- /new starts a fresh session in the (user, persona) slot, which is
             meaningless inside a named thread: threads replace that flow. -->
        <Button v-if="!boundToThread" variant="outline" size="sm" class="min-h-11 min-w-11 gap-2" :aria-label="$t('chat.newSession')" :disabled="isStreaming || sessionResetting" @click="$emit('newSession')">
          <AppIcon name="sparkles" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
        </Button>
        <Popover v-model:open="filterOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="min-h-11 min-w-11 gap-2" :aria-label="$t('chat.displayFilters')">
              <AppIcon name="settings" class="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <!-- W6c: the panel grows with its labels up to the viewport minus a
               margin; a long label wraps (also inside one long word) instead
               of pushing its switch out of the box. The switch never shrinks
               and stays flush right; rows are 44 px touch targets below md. -->
          <PopoverContent data-testid="display-filters" :collision-padding="8" class="w-max min-w-64 max-w-[min(24rem,calc(100vw-1rem))]">
            <div class="flex flex-col gap-1 md:gap-2">
              <p class="text-xs font-semibold uppercase tracking-label text-muted-foreground [overflow-wrap:anywhere]">{{ $t('chat.displayFilters') }}</p>
              <div data-filter-row class="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
                <Label class="min-w-0 flex-1 cursor-pointer self-stretch py-1 text-sm leading-5 [overflow-wrap:anywhere] flex items-center" for="filter-thinking">{{ $t('chat.filterThinking') }}</Label>
                <Switch id="filter-thinking" v-model:checked="showThinking" class="shrink-0" />
              </div>
              <div data-filter-row class="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
                <Label class="min-w-0 flex-1 cursor-pointer self-stretch py-1 text-sm leading-5 [overflow-wrap:anywhere] flex items-center" for="filter-tools">{{ $t('chat.filterToolCalls') }}</Label>
                <Switch id="filter-tools" v-model:checked="showToolCalls" class="shrink-0" />
              </div>
              <div data-filter-row class="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
                <Label class="min-w-0 flex-1 cursor-pointer self-stretch py-1 text-sm leading-5 [overflow-wrap:anywhere] flex items-center" for="filter-injections">{{ $t('chat.filterInjections') }}</Label>
                <Switch id="filter-injections" v-model:checked="showInjections" class="shrink-0" />
              </div>
              <div data-filter-row class="flex min-h-11 items-center justify-between gap-3 md:min-h-8">
                <Label class="min-w-0 flex-1 cursor-pointer self-stretch py-1 text-sm leading-5 [overflow-wrap:anywhere] flex items-center" for="filter-summaries">{{ $t('chat.filterSessionSummaries') }}</Label>
                <Switch id="filter-summaries" v-model:checked="showSessionSummaries" class="shrink-0" />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </template>
    </PageHeader>
</template>

<script setup lang="ts">
import { useChatView } from '~/composables/chat/chatViewContext'

/**
 * The chat toolbar: connection dot, the strand-local stop (the global
 * emergency stop is only the `/kill` slash command), new session and the
 * display filters. Rendered through the shared <PageHeader>, so on mobile the
 * actions move into the layout header.
 */
defineProps<{ boundToThread: boolean; sessionResetting: boolean }>()
defineEmits<{ stop: []; newSession: [] }>()

const { t } = useI18n()
const { connectionStatus, isStreaming, filters } = useChatView()
const { showThinking, showToolCalls, showInjections, showSessionSummaries } = filters
const filterOpen = ref(false)
const chatStatusText = computed(() => connectionStatus.value === 'connected' ? t('chat.statusConnected') : connectionStatus.value === 'connecting' ? t('chat.statusConnecting') : t('chat.statusDisconnected'))
</script>
