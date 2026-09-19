<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <PageHeader :title="$t('providers.title')" :subtitle="$t('providers.subtitle')">
      <template #actions>
        <Button class="h-8 px-3 text-xs md:h-10 md:px-4 md:py-2 md:text-sm" @click="openCreate">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('providers.addProvider') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col p-6">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="mb-4">
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

      <!-- Success banner (test result) -->
      <Alert v-if="successMessage" variant="success" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="successMessage = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading state -->
      <div
        v-if="loading && providers.length === 0"
        class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
      >
        {{ $t('logs.loading') }}
      </div>

      <!-- Empty state -->
      <div
        v-else-if="providers.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground"
      >
        <AppIcon name="plug" size="xl" class="h-12 w-12 opacity-40" />
        <p class="text-sm">{{ $t('providers.noProviders') }}</p>
        <Button @click="openCreate">
          {{ $t('providers.addProvider') }}
        </Button>
      </div>

      <!-- Providers table -->
      <div v-if="providers.length > 0" class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('providers.columns.name') }}</TableHead>
                <TableHead>{{ $t('providers.columns.cost') }}</TableHead>
                <TableHead>{{ $t('providers.columns.status') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="provider in sortedProviders" :key="provider.id">
                <!-- Provider header row -->
                <TableRow
                  class="cursor-pointer"
                  @click="openEdit(provider)"
                >
                  <TableCell>
                    <div class="min-w-0">
                      <span class="font-semibold text-foreground">{{ provider.name }}</span>
                      <div class="text-xs text-muted-foreground">
                        {{ getTypeLabel(provider.providerType) }}
                        <template v-if="provider.authMethod === 'oauth' && provider.oauthCredentials">
                          <span class="opacity-40">·</span>
                          OAuth
                        </template>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell />
                  <TableCell>
                    <div v-if="isRefreshingQuota(provider.id)" class="flex items-center gap-1.5">
                      <span
                        class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                        aria-hidden="true"
                      />
                      <span class="text-xs text-muted-foreground">{{ $t('providers.quota.refreshing') }}</span>
                    </div>
                    <div v-else-if="getQuota(provider)" class="flex flex-col gap-0.5 text-xs">
                      <span
                        v-if="getQuota(provider)!.error"
                        class="text-muted-foreground"
                        :title="getQuota(provider)!.error ?? undefined"
                      >
                        {{ quotaErrorLabel(getQuota(provider)!.error) }}
                      </span>
                      <template v-else>
                        <div
                          v-for="part in quotaWindowParts(getQuota(provider)!)"
                          :key="part.key"
                          class="flex items-center gap-1 whitespace-nowrap"
                        >
                          <span class="font-medium" :class="part.colorClass">
                            {{ part.label }}: {{ part.utilization }}%
                          </span>
                          <span v-if="part.reset" class="text-muted-foreground">({{ part.reset }})</span>
                        </div>
                      </template>
                    </div>
                  </TableCell>
                  <TableCell class="text-right" @click.stop>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('providers.columns.actions')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem @click="openEdit(provider)">
                          <AppIcon name="edit" class="h-4 w-4" />
                          {{ $t('users.edit') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="openAddModel(provider)">
                          <AppIcon name="add" class="h-4 w-4" />
                          {{ $t('providers.addModelMenu') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            v-if="providerSupportsQuota(provider)"
                            :disabled="isRefreshingQuota(provider.id)"
                            @click="handleRefreshQuota(provider.id)"
                        >
                          <AppIcon name="refresh" class="h-4 w-4" />
                          {{ $t('providers.quota.refresh') }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          :disabled="provider.id === activeProviderId"
                          @click="openDelete(provider)"
                        >
                          <AppIcon name="trash" class="h-4 w-4" />
                          {{ $t('providers.delete') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>

                <!-- Model sub-rows (always shown for every provider) -->
                <TableRow
                  v-for="modelId in getDisplayModels(provider)"
                  :key="`${provider.id}-${modelId}`"
                  class="bg-muted/30 hover:bg-muted/50"
                >
                  <!-- Model name (indented, compact) -->
                  <TableCell class="py-1.5">
                    <div class="flex items-center gap-2">
                      <span class="text-xs text-muted-foreground">└</span>
                      <span class="text-sm text-foreground">{{ modelId }}</span>
                      <Badge v-if="isActiveModel(provider.id, modelId)" variant="default" class="px-1.5 py-0 text-[10px]">
                        {{ $t('providers.active') }}
                      </Badge>
                      <Badge v-if="isFallbackModel(provider.id, modelId)" variant="outline" class="px-1.5 py-0 text-[10px]">
                        {{ $t('providers.fallback') }}
                      </Badge>

                    </div>
                  </TableCell>

                  <!-- Cost (single line, no $/M tokens label) -->
                  <TableCell class="py-1.5">
                    <template v-if="getModelCost(provider, modelId)">
                      <div class="flex items-center gap-1 text-xs">
                        <span class="text-foreground font-medium">${{ formatCost(getModelCost(provider, modelId)!.input) }}</span>
                        <span class="opacity-40">/</span>
                        <span class="text-foreground font-medium">${{ formatCost(getModelCost(provider, modelId)!.output) }}</span>
                      </div>
                    </template>
                    <span v-else class="text-xs text-muted-foreground">{{ $t('providers.costNA') }}</span>
                  </TableCell>

                  <!-- Status per model -->
                  <TableCell class="py-1.5">
                    <div v-if="isTestingModel(provider.id, modelId)" class="flex items-center gap-1.5">
                      <span
                        class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                        aria-hidden="true"
                      />
                      <span class="text-xs text-muted-foreground">{{ $t('providers.testing') }}</span>
                    </div>
                    <Badge v-else :variant="getStatusVariant(getModelStatus(provider, modelId))">
                      {{ getStatusLabel(getModelStatus(provider, modelId)) }}
                    </Badge>
                  </TableCell>

                  <!-- Model actions -->
                  <TableCell class="py-1.5 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="ghost" size="icon-sm" :aria-label="$t('providers.columns.actions')">
                          <AppIcon name="moreVertical" class="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem @click="handleTestModel(provider.id, modelId)">
                          <AppIcon name="refresh" class="h-4 w-4" />
                          {{ $t('providers.testConnection') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="!isActiveModel(provider.id, modelId)"
                          @click="handleActivateModel(provider.id, modelId)"
                        >
                          <AppIcon name="check" class="h-4 w-4" />
                          {{ $t('providers.setActive') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="!isFallbackModel(provider.id, modelId) && !isActiveModel(provider.id, modelId)"
                          @click="handleSetFallbackModel(provider.id, modelId)"
                        >
                          <AppIcon name="shield" class="h-4 w-4" />
                          {{ $t('providers.setFallback') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          v-if="isFallbackModel(provider.id, modelId)"
                          @click="handleSetFallback(null)"
                        >
                          <AppIcon name="close" class="h-4 w-4" />
                          {{ $t('providers.removeFallback') }}
                        </DropdownMenuItem>
                        <DropdownMenuItem @click="openEditModel(provider, modelId)">
                          <AppIcon name="edit" class="h-4 w-4" />
                          {{ $t('providers.editModelMenu') }}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          destructive
                          :disabled="!canRemoveModel(provider, modelId)"
                          @click="openRemoveModel(provider, modelId)"
                        >
                          <AppIcon name="trash" class="h-4 w-4" />
                          {{ $t('providers.removeModel') }}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              </template>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <ProviderFormDialog
    :open="showForm"
    :mode="formMode"
    :provider="editingProvider"
    :presets="presets"
    @close="closeForm"
    @submit="handleSubmit"
    @oauth-complete="closeForm"
  />

  <!-- Add Model dialog -->
  <AddModelDialog
    :open="showAddModel"
    :provider="addModelTarget"
    @close="closeAddModel"
    @added="handleModelsAdded"
  />

  <!-- Edit Model dialog -->
  <EditModelDialog
    :open="showEditModel"
    :provider="editModelTarget?.provider ?? null"
    :model-id="editModelTarget?.modelId ?? null"
    @close="closeEditModel"
    @saved="handleModelSaved"
  />

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('providers.delete')"
    :description="$t('providers.deleteConfirm', { name: deleteTarget?.name ?? '' })"
    :confirm-label="$t('providers.deleteConfirmButton')"
    :cancel-label="$t('providers.deleteCancel')"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />

  <!-- Remove model confirmation dialog -->
  <ConfirmDialog
    :open="!!removeModelTarget"
    :title="$t('providers.removeModel')"
    :description="$t('providers.removeModelConfirm', { model: removeModelTarget?.modelId ?? '', provider: removeModelTarget?.provider.name ?? '' })"
    :confirm-label="$t('providers.removeModelConfirmButton')"
    :cancel-label="$t('providers.deleteCancel')"
    destructive
    @confirm="handleRemoveModel"
    @cancel="removeModelTarget = null"
  />
</template>

<script setup lang="ts">
import type { ProviderUpdatePayloadContract } from '@axiom/core/contracts'
import type { Provider } from '~/features/providers/composables/useProviders'
import type { ProviderFormPayload } from '~/components/ProviderFormDialog.vue'
import { useProviders } from '~/features/providers/composables/useProviders'
import { formatModelCost as formatCost } from '~/utils/modelFormat'

const { t } = useI18n()
const { quotaWindowParts } = useQuotaFormat()

const {
  providers,
  activeProviderId,
  activeModelId,
  fallbackProviderId,
  fallbackModelId,
  presets,
  loading,
  error,
  testingId,
  fetchProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  testProvider,
  activateProvider,
  refreshQuota,
  setFallbackProvider,
} = useProviders()

const refreshingQuotaIds = ref<Set<string>>(new Set())

/* ── State ── */
const showForm = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingProvider = ref<Provider | null>(null)
const deleteTarget = ref<Provider | null>(null)
const removeModelTarget = ref<{ provider: Provider; modelId: string } | null>(null)
const successMessage = ref<string | null>(null)

const showAddModel = ref(false)
const addModelTarget = ref<Provider | null>(null)

const showEditModel = ref(false)
const editModelTarget = ref<{ provider: Provider; modelId: string } | null>(null)

const sortedProviders = computed(() =>
  [...providers.value].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
)

const QUOTA_REFRESH_MS = 60_000
let quotaRefreshTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  fetchProviders()
  quotaRefreshTimer = setInterval(() => {
    fetchProviders()
  }, QUOTA_REFRESH_MS)
})

onUnmounted(() => {
  if (quotaRefreshTimer) {
    clearInterval(quotaRefreshTimer)
    quotaRefreshTimer = null
  }
})

/* ── Helpers ── */
function getTypeLabel(providerType: string): string {
  const preset = presets.value[providerType]
  return preset?.label ?? providerType
}

type ProviderQuota = NonNullable<Provider['quota']>

function providerSupportsQuota(provider: Provider): boolean {
  return provider.supportsQuota === true
}

function getQuota(provider: Provider): ProviderQuota | null {
  if (!providerSupportsQuota(provider)) {
    return null
  }
  return provider.quota ?? null
}

function isRefreshingQuota(providerId: string): boolean {
  return refreshingQuotaIds.value.has(providerId)
}

function quotaErrorLabel(rawError?: string): string {
  if (rawError && /\b429\b/.test(rawError)) {
    return t('providers.quota.rateLimited')
  }
  return t('providers.quota.unavailable')
}

async function handleRefreshQuota(providerId: string) {
  if (refreshingQuotaIds.value.has(providerId)) return
  refreshingQuotaIds.value = new Set(refreshingQuotaIds.value).add(providerId)
  try {
    const ok = await refreshQuota(providerId)
    if (ok) {
      const refreshed = providers.value.find(p => p.id === providerId)
      const quotaError = refreshed?.quota?.error
      if (quotaError) {
        error.value = quotaErrorLabel(quotaError)
      } else {
        successMessage.value = t('providers.quota.refreshSuccess')
        autoHideSuccess()
      }
    }
  } finally {
    const next = new Set(refreshingQuotaIds.value)
    next.delete(providerId)
    refreshingQuotaIds.value = next
  }
}

function getStatusVariant(status?: string): 'success' | 'destructive' | 'muted' {
  switch (status) {
    case 'connected': return 'success'
    case 'error': return 'destructive'
    default: return 'muted'
  }
}

function getDisplayModels(provider: Provider): string[] {
  return provider.enabledModels ?? []
}

function getModelCost(provider: Provider, modelId: string): { input: number; output: number } | null {
  if (provider.modelCosts?.[modelId]) {
    return provider.modelCosts[modelId]
  }
  if (provider.cost && modelId === provider.enabledModels?.[0]) {
    return provider.cost
  }
  return null
}

function getModelStatus(provider: Provider, modelId: string): string | undefined {
  if (provider.modelStatuses?.[modelId]) {
    return provider.modelStatuses[modelId]
  }
  // Single-model providers store status on the provider itself
  if ((provider.enabledModels?.length ?? 0) <= 1) {
    return provider.status
  }
  return undefined
}

function isTestingModel(providerId: string, modelId: string): boolean {
  return testingId.value === `${providerId}:${modelId}` || testingId.value === providerId
}

function isActiveModel(providerId: string, modelId: string): boolean {
  if (providerId !== activeProviderId.value) return false
  const aModel = activeModelId.value
  if (!aModel) {
    const provider = providers.value.find(p => p.id === providerId)
    return modelId === provider?.enabledModels?.[0]
  }
  return aModel === modelId
}

function isFallbackModel(providerId: string, modelId: string): boolean {
  if (providerId !== fallbackProviderId.value) return false
  const fbModel = fallbackModelId.value
  if (!fbModel) {
    const provider = providers.value.find(p => p.id === providerId)
    return modelId === provider?.enabledModels?.[0]
  }
  return fbModel === modelId
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case 'connected': return t('providers.statusConnected')
    case 'error': return t('providers.statusError')
    default: return t('providers.statusUntested')
  }
}

function autoHideSuccess() {
  setTimeout(() => { successMessage.value = null }, 4000)
}

/* ── Create / Edit ── */
function openCreate() {
  formMode.value = 'create'
  editingProvider.value = null
  showForm.value = true
}

function openEdit(provider: Provider) {
  formMode.value = 'edit'
  editingProvider.value = provider
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editingProvider.value = null
}

function openAddModel(provider: Provider) {
  addModelTarget.value = provider
  showAddModel.value = true
}

function closeAddModel() {
  showAddModel.value = false
  addModelTarget.value = null
}

function handleModelsAdded() {
  successMessage.value = t('providers.addModelSuccess')
  autoHideSuccess()
}

function openEditModel(provider: Provider, modelId: string) {
  editModelTarget.value = { provider, modelId }
  showEditModel.value = true
}

function closeEditModel() {
  showEditModel.value = false
  editModelTarget.value = null
}

function handleModelSaved() {
  successMessage.value = t('providers.editModelSuccess')
  autoHideSuccess()
}

async function handleSubmit(payload: ProviderFormPayload) {
  if (formMode.value === 'edit' && editingProvider.value) {
    const input: ProviderUpdatePayloadContract = {
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl,
      enabledModels: payload.enabledModels,
      degradedThresholdMs: payload.degradedThresholdMs,
      healthCheckTimeoutMs: payload.healthCheckTimeoutMs ?? undefined,
      textVerbosity: payload.textVerbosity,
      transport: payload.transport,
      extraFields: payload.extraFields,
    }
    if (payload.apiKey) {
      input.apiKey = payload.apiKey
    }
    const result = await updateProvider(editingProvider.value.id, input)
    if (result) closeForm()
  } else {
    const result = await addProvider({
      name: payload.name,
      providerType: payload.providerType,
      baseUrl: payload.baseUrl || undefined,
      apiKey: payload.apiKey || undefined,
      enabledModels: payload.enabledModels,
      degradedThresholdMs: payload.degradedThresholdMs,
      healthCheckTimeoutMs: payload.healthCheckTimeoutMs ?? undefined,
      textVerbosity: payload.textVerbosity,
      transport: payload.transport,
      extraFields: payload.extraFields,
    })
    if (result) closeForm()
  }
}

/* ── Delete ── */
function openDelete(provider: Provider) {
  deleteTarget.value = provider
}

async function handleDelete() {
  if (!deleteTarget.value) return
  const success = await deleteProvider(deleteTarget.value.id)
  if (success) {
    deleteTarget.value = null
  }
}

/* ── Test / Activate ── */
async function handleTestModel(providerId: string, modelId: string) {
  const result = await testProvider(providerId, modelId)
  if (result.success) {
    successMessage.value = result.message ?? t('providers.testSuccess')
  } else {
    error.value = result.error ?? t('providers.testFailed')
  }
  autoHideSuccess()
}

async function handleActivateModel(providerId: string, modelId: string) {
  await activateProvider(providerId, modelId)
  await fetchProviders()
}

async function handleSetFallback(id: string | null) {
  await setFallbackProvider(id)
  await fetchProviders()
}

async function handleSetFallbackModel(providerId: string, modelId: string) {
  await setFallbackProvider(providerId, modelId)
  await fetchProviders()
}

/* ── Remove model from provider ── */
function canRemoveModel(provider: Provider, modelId: string): boolean {
  // Cannot remove the currently active model (would break the running agent)
  if (isActiveModel(provider.id, modelId)) return false
  // Cannot remove the last remaining model; delete the provider instead
  const enabled = getDisplayModels(provider)
  if (enabled.length <= 1) return false
  return true
}

function openRemoveModel(provider: Provider, modelId: string) {
  if (!canRemoveModel(provider, modelId)) return
  removeModelTarget.value = { provider, modelId }
}

async function handleRemoveModel() {
  const target = removeModelTarget.value
  if (!target) return
  const { provider, modelId } = target

  // If the model to remove is the fallback, clear the fallback first.
  if (isFallbackModel(provider.id, modelId)) {
    await setFallbackProvider(null)
  }

  const nextEnabled = getDisplayModels(provider).filter(m => m !== modelId)

  const payload: { enabledModels: string[] } = {
    enabledModels: nextEnabled,
  }

  const result = await updateProvider(provider.id, payload)
  if (result) {
    removeModelTarget.value = null
  }
}
</script>
