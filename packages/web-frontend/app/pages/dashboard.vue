<template>
  <!-- Admin gate -->
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" class="h-10 w-10 opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('dashboard.title')" :subtitle="$t('dashboard.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="loading" class="gap-2" @click="load">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('dashboard.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto p-6">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="mb-6">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="error = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading skeletons -->
      <template v-if="loading">
        <div class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Skeleton v-for="i in 3" :key="i" class="h-24 rounded-xl" />
        </div>
        <div class="mb-6 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Skeleton class="h-56 rounded-xl" />
          <Skeleton class="h-56 rounded-xl" />
        </div>
      </template>

      <template v-else>
        <!-- ─── KPI row (3 cards) ─── -->
        <section class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Card v-for="card in statCards" :key="card.label">
            <CardContent class="p-5">
              <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {{ card.label }}
              </span>
              <div class="mt-2 flex items-baseline gap-2">
                <strong class="text-2xl font-bold tracking-tight text-foreground">{{ card.value }}</strong>
                <span v-if="card.suffix" class="text-sm text-muted-foreground">{{ card.suffix }}</span>
              </div>
              <span class="mt-1 block text-xs text-muted-foreground">{{ card.meta }}</span>
            </CardContent>
          </Card>
        </section>

        <!-- ─── Active Tasks card ─── -->
        <section class="mb-6">
          <NuxtLink to="/tasks" class="block">
            <Card class="transition-colors hover:border-primary/40">
              <CardContent class="flex items-center gap-4 p-5">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <AppIcon name="bot" class="h-5 w-5 text-primary" />
                </div>
                <div class="min-w-0 flex-1">
                  <span class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {{ $t('dashboard.activeTasks.title') }}
                  </span>
                  <div class="mt-1 flex items-baseline gap-3">
                    <strong class="text-2xl font-bold tracking-tight text-foreground">
                      {{ activeTaskCount }}
                    </strong>
                    <span class="text-sm text-muted-foreground">
                      {{ $t('dashboard.activeTasks.running') }}
                    </span>
                  </div>
                  <span class="mt-0.5 block text-xs text-muted-foreground">
                    {{ $t('dashboard.activeTasks.scheduled', { count: scheduledTaskCount }) }}
                  </span>
                </div>
                <AppIcon name="arrowRight" class="h-4 w-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          </NuxtLink>
        </section>

        <!-- ─── Provider health + Health history (2-col) ─── -->
        <section v-if="healthMonitorEnabled" class="grid grid-cols-1 gap-6 md:grid-cols-2">
          <!-- Provider health -->
          <Card>
            <CardHeader class="pb-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <CardTitle class="text-base tracking-tight">
                    {{ $t('dashboard.providerHealth') }}
                  </CardTitle>
                  <CardDescription v-if="providerName" class="mt-0.5 truncate">
                    {{ providerName }}
                  </CardDescription>
                  <CardDescription v-else class="mt-0.5">
                    {{ $t('dashboard.notConfigured') }}
                  </CardDescription>
                </div>
                <Badge :variant="statusBadgeVariant(providerStatus)">
                  {{ statusLabel(providerStatus) }}
                </Badge>
              </div>
            </CardHeader>
            <CardContent class="pt-0">
              <dl class="space-y-2.5">
                <!-- Operating mode -->
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.operatingMode') }}</dt>
                  <dd>
                    <Badge :variant="operatingModeBadgeVariant">
                      {{ operatingModeLabel }}
                    </Badge>
                  </dd>
                </div>

                <!-- Fallback info (only in fallback mode) -->
                <template v-if="isInFallbackMode">
                  <div v-if="fallbackProviderInfo" class="flex items-center justify-between gap-2 text-sm">
                    <dt class="text-muted-foreground">{{ $t('dashboard.fallbackProvider') }}</dt>
                    <dd class="font-semibold text-foreground">
                      {{ fallbackProviderInfo.name }}
                      <span class="text-xs text-muted-foreground">({{ fallbackProviderInfo.model }})</span>
                    </dd>
                  </div>
                  <div v-if="primaryProvider" class="flex items-center justify-between gap-2 text-sm">
                    <dt class="text-muted-foreground">{{ $t('dashboard.primaryProviderStatus') }}</dt>
                    <dd class="flex items-center gap-1.5 font-semibold text-foreground">
                      <Badge v-if="primaryProvider.lastHealthStatus" :variant="statusBadgeVariant(primaryProvider.lastHealthStatus)">
                        {{ statusLabel(primaryProvider.lastHealthStatus) }}
                      </Badge>
                      <span v-else class="text-xs text-muted-foreground">—</span>
                    </dd>
                  </div>
                  <div class="flex items-center justify-between gap-2 text-sm">
                    <dt class="text-muted-foreground">{{ $t('dashboard.recoveryStatus') }}</dt>
                    <dd class="text-xs font-medium text-warning">{{ $t('dashboard.recoveryChecksRunning') }}</dd>
                  </div>
                </template>

                <div v-if="providerTypeLabel" class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.providerType') }}</dt>
                  <dd class="font-semibold text-foreground">{{ providerTypeLabel }}</dd>
                </div>
                <div v-if="providerModel" class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.model') }}</dt>
                  <dd class="font-semibold text-foreground">{{ providerModel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.agentStatus') }}</dt>
                  <dd class="flex items-center gap-1.5 font-semibold text-foreground">
                    <span
                      class="h-2 w-2 rounded-full"
                      :class="agentStatus === 'running' ? 'bg-success' : 'bg-muted-foreground'"
                    />
                    {{ agentStatusLabel }}
                  </dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.lastHealthCheck') }}</dt>
                  <dd class="font-semibold text-foreground">{{ lastCheckLabel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.latency') }}</dt>
                  <dd class="font-semibold tabular-nums text-foreground">{{ latencyLabel }}</dd>
                </div>
                <div class="flex items-center justify-between gap-2 text-sm">
                  <dt class="text-muted-foreground">{{ $t('dashboard.queueDepth') }}</dt>
                  <dd class="font-semibold tabular-nums text-foreground">
                    {{ formatNumber(health.queueDepth) }}
                  </dd>
                </div>
              </dl>

              <Alert v-if="lastCheckError" variant="destructive" class="mt-4">
                <AlertDescription>{{ lastCheckError }}</AlertDescription>
              </Alert>
            </CardContent>
          </Card>

          <!-- Health history -->
          <Card>
            <CardHeader class="pb-3">
              <CardTitle class="text-base tracking-tight">
                {{ $t('dashboard.recentHealthChecks') }}
              </CardTitle>
              <CardDescription>{{ $t('dashboard.recentHealthChecksDescription') }}</CardDescription>
            </CardHeader>
            <CardContent class="pt-0">
              <p
                v-if="healthHistory.length === 0"
                class="py-6 text-center text-sm text-muted-foreground"
              >
                {{ $t('dashboard.noHealthHistory') }}
              </p>
              <ul v-else class="divide-y divide-border">
                <li
                  v-for="entry in healthHistory"
                  :key="entry.id"
                  class="flex items-center justify-between gap-3 py-2.5"
                >
                  <div class="min-w-0">
                    <strong class="block truncate text-sm font-medium text-foreground">
                      {{ entry.provider || $t('dashboard.notConfigured') }}
                    </strong>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      {{ formatDateTime(entry.timestamp) }}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-3">
                    <span
                      v-if="entry.latencyMs"
                      class="text-xs tabular-nums text-muted-foreground"
                    >
                      {{ entry.latencyMs }} ms
                    </span>
                    <Badge :variant="statusBadgeVariant(entry.status)" class="text-[11px]">
                      {{ statusLabel(entry.status) }}
                    </Badge>
                  </div>
                </li>
              </ul>
            </CardContent>
          </Card>
        </section>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ProviderStatus } from '~/composables/useDashboard'

const { t } = useI18n()
const { user } = useAuth()
const { formatNumber, formatCurrency, formatDateTime } = useFormat()
const { presets, fetchProviders } = useProviders()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  loading,
  error,
  health,
  healthHistory,
  providerName,
  providerType,
  providerModel,
  providerStatus,
  agentStatus,
  healthMonitorEnabled,
  operatingMode,
  primaryProvider,
  fallbackProviderInfo,
  lastCheckTime,
  lastCheckLatency,
  lastCheckError,
  usageToday,
  activeTaskCount,
  scheduledTaskCount,
  load,
} = useDashboard()

const isInFallbackMode = computed(() => operatingMode.value === 'fallback')

const operatingModeLabel = computed(() =>
  isInFallbackMode.value ? t('dashboard.operatingModes.fallback') : t('dashboard.operatingModes.normal'),
)

const operatingModeBadgeVariant = computed((): 'success' | 'warning' =>
  isInFallbackMode.value ? 'warning' : 'success',
)

// ── Derived display values ──────────────────────────────────────
const statCards = computed(() => [
  {
    label: t('dashboard.cards.messages'),
    value: formatNumber(health.value.activity.messagesToday),
    suffix: null,
    meta: t('dashboard.cards.messagesMeta'),
  },
  {
    label: t('dashboard.cards.sessions'),
    value: formatNumber(health.value.activity.sessionsToday),
    suffix: null,
    meta: t('dashboard.cards.sessionsMeta'),
  },
  {
    label: t('dashboard.cards.costToday'),
    value: formatCurrency(usageToday.value.estimatedCost),
    suffix: null,
    meta: `${formatNumber(usageToday.value.totalTokens)} ${t('dashboard.cards.tokens')}`,
  },
])

const providerTypeLabel = computed(() => {
  if (!providerType.value) return null
  const preset = presets.value[providerType.value]
  return preset?.label ?? providerType.value
})

const agentStatusLabel = computed(() => t(`dashboard.agentStates.${agentStatus.value}`))

const lastCheckLabel = computed(() => {
  if (!lastCheckTime.value) return t('dashboard.noChecksYet')
  return formatDateTime(lastCheckTime.value)
})

const latencyLabel = computed(() => {
  if (lastCheckLatency.value == null) return '—'
  return `${lastCheckLatency.value} ms`
})

// ── Status helpers ──────────────────────────────────────────────
function statusLabel(status: ProviderStatus): string {
  return t(`dashboard.providerStates.${status}`)
}

function statusBadgeVariant(status: ProviderStatus): 'success' | 'warning' | 'destructive' | 'muted' {
  switch (status) {
    case 'healthy': return 'success'
    case 'degraded': return 'warning'
    case 'down': return 'destructive'
    default: return 'muted'
  }
}

// ── Init ────────────────────────────────────────────────────────
onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([load(), fetchProviders()])
})
</script>
