<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from '~/components/ui/Button.vue'
import Skeleton from '~/components/ui/Skeleton.vue'
import { createSpeechCache, formatCacheBytes, useSpeechCacheApi, type SpeechCacheController } from '../speechCache'

/**
 * W7 D2: read-aloud disk cache (`<DATA_DIR>/cache/speech`), admin only.
 * Figures (entries, size, hits/misses since start) and "empty cache" behind
 * a confirmation. `controller` exists for tests; the page creates its own.
 */
const props = defineProps<{ controller?: SpeechCacheController }>()
const { stats, state, clearing, feedback, load, clear } = props.controller ?? createSpeechCache(useSpeechCacheApi())
const { t, locale } = useI18n()
const localeTag = computed(() => (typeof locale === 'object' && locale && 'value' in locale ? String(locale.value) : undefined))
const confirming = ref(false)

onMounted(() => { if (state.value === 'loading') void load() })

const nf = computed(() => new Intl.NumberFormat(localeTag.value))
const hitRate = computed(() => {
  const s = stats.value
  if (!s || s.hits + s.misses === 0) return null
  return Math.round((s.hits / (s.hits + s.misses)) * 100)
})

async function confirmClear(): Promise<void> {
  await clear()
  confirming.value = false
}
</script>

<template>
  <section class="flex flex-col gap-2" aria-labelledby="speech-cache-title" data-testid="settings-speech-cache">
    <h3 id="speech-cache-title" class="text-sm font-semibold text-foreground">{{ $t('settings.speechCache.title') }}</h3>
    <p class="measure text-help text-muted-foreground">{{ $t('settings.speechCache.hint') }}</p>

    <div v-if="state === 'loading'" class="rounded-lg border border-border px-4 py-3" aria-busy="true" data-testid="speech-cache-loading">
      <Skeleton class="mb-2 h-4 w-40" />
      <Skeleton class="h-3 w-64 max-w-full" />
    </div>
    <div v-else-if="state === 'error'" role="alert" class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 px-4 py-3" data-testid="speech-cache-error">
      <span class="text-sm text-foreground">{{ $t('settings.speechCache.loadFailed') }}</span>
      <Button type="button" variant="outline" class="min-h-11" @click="load">
        <AppIcon name="retry" size="sm" />
        {{ $t('settings.retry') }}
      </Button>
    </div>
    <div v-else-if="stats" class="flex flex-col gap-3 rounded-lg border border-border px-4 py-3">
      <p v-if="!stats.enabled" class="measure text-sm text-muted-foreground" data-testid="speech-cache-off">
        {{ $t('settings.speechCache.off') }}
      </p>
      <template v-else>
        <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" data-testid="speech-cache-stats">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('settings.speechCache.entries') }}</dt>
            <dd class="tabular-nums text-foreground">{{ nf.format(stats.entries) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('settings.speechCache.size') }}</dt>
            <dd class="tabular-nums text-foreground">{{ formatCacheBytes(stats.bytes, localeTag) }} / {{ formatCacheBytes(stats.maxBytes, localeTag) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('settings.speechCache.hits') }}</dt>
            <dd class="tabular-nums text-foreground">{{ nf.format(stats.hits) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('settings.speechCache.misses') }}</dt>
            <dd class="tabular-nums text-foreground">{{ nf.format(stats.misses) }}</dd>
          </div>
        </dl>
        <p class="text-xs text-muted-foreground">
          {{ hitRate === null ? $t('settings.speechCache.sinceStartEmpty') : $t('settings.speechCache.sinceStart', { rate: hitRate }) }}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            class="min-h-11"
            :disabled="clearing || stats.entries === 0"
            data-testid="speech-cache-clear"
            @click="confirming = true"
          >
            <AppIcon name="trash" size="sm" />
            {{ $t('settings.speechCache.clear') }}
          </Button>
          <span v-if="stats.entries === 0 && !feedback" class="text-sm text-muted-foreground" data-testid="speech-cache-empty">
            {{ $t('settings.speechCache.empty') }}
          </span>
        </div>
      </template>
    </div>
    <p v-if="feedback?.kind === 'cleared'" role="status" aria-live="polite" class="text-sm text-success" data-testid="speech-cache-cleared">
      {{ t('settings.speechCache.cleared', { count: feedback.entries, size: formatCacheBytes(feedback.bytes, localeTag) }, feedback.entries) }}
    </p>
    <p v-else-if="feedback?.kind === 'failed'" role="alert" class="text-sm text-destructive" data-testid="speech-cache-failed">
      {{ $t('settings.speechCache.clearFailed') }}
    </p>

    <ConfirmDialog
      :open="confirming"
      :title="$t('settings.speechCache.confirmTitle')"
      :description="t('settings.speechCache.confirmText', { count: stats?.entries ?? 0, size: formatCacheBytes(stats?.bytes ?? 0, localeTag) }, stats?.entries ?? 0)"
      :confirm-label="$t('settings.speechCache.clear')"
      destructive
      :loading="clearing"
      @cancel="() => { if (!clearing) confirming = false }"
      @confirm="confirmClear"
    />
  </section>
</template>
