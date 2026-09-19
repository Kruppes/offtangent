<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.addModelDialogTitle') }}</DialogTitle>
        <DialogDescription v-if="provider">
          {{ $t('providers.addModelDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-3">
        <!-- Search input -->
        <Input
          v-model="search"
          type="text"
          :placeholder="$t('providers.addModelSearch')"
          autofocus
        />

        <!-- Loading -->
        <div v-if="loading" class="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          {{ $t('providers.loadingModels') }}
        </div>

        <!-- Error -->
        <div v-else-if="loadError" class="flex flex-col gap-1">
          <span class="text-xs text-destructive">{{ $t('providers.modelsLoadError') }}</span>
          <button
            type="button"
            class="self-start text-xs text-destructive hover:underline"
            @click="loadCatalog"
          >
            {{ $t('providers.modelsRetry') }}
          </button>
        </div>

        <!-- Model list -->
        <div v-else class="flex flex-col gap-0 divide-y divide-border rounded-md border border-border overflow-hidden max-h-72 overflow-y-auto">
          <template v-if="filteredModels.length > 0">
            <label
              v-for="model in filteredModels"
              :key="model.id"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm transition-colors',
                isAlreadyEnabled(model.id) ? 'opacity-50' : 'cursor-pointer hover:bg-accent/50',
                selected.has(model.id) ? 'bg-accent/30' : '',
              ]"
            >
              <input
                type="checkbox"
                :checked="selected.has(model.id)"
                :disabled="isAlreadyEnabled(model.id)"
                class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                @change="toggleSelected(model.id)"
              >
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="truncate">{{ model.name }}</span>
                <span class="font-mono text-[10px] text-muted-foreground truncate">{{ model.id }}</span>
              </span>
              <span
                v-if="model.contextWindow || model.cost"
                class="flex shrink-0 flex-col items-end text-[10px] text-muted-foreground tabular-nums"
              >
                <span v-if="model.contextWindow">{{ $t('providers.addModelContext', { size: formatContextWindow(model.contextWindow) }) }}</span>
                <span v-if="model.cost">${{ formatModelCost(model.cost.input) }} / ${{ formatModelCost(model.cost.output) }}</span>
              </span>
              <span v-if="isAlreadyEnabled(model.id)" class="text-[10px] text-muted-foreground shrink-0">
                {{ $t('providers.addModelAlreadyEnabled') }}
              </span>
            </label>
          </template>

          <!-- Empty catalog + no custom search → show a hint -->
          <div
            v-else-if="!canAddCustom"
            class="px-3 py-4 text-xs text-muted-foreground"
          >
            {{ $t('providers.addModelEmpty') }}
          </div>

          <!-- Custom model fallback: shown when the search text matches nothing
               in the catalog. Lets users add model ids that are not in pi-ai
               (e.g. a manually published model like glm-5.2). -->
          <button
            v-if="canAddCustom"
            type="button"
            :class="[
              'flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50',
              selected.has(search.trim()) ? 'bg-accent/30' : '',
            ]"
            @click="toggleSelected(search.trim())"
          >
            <span class="flex h-4 w-4 items-center justify-center rounded border border-primary text-primary">
              <AppIcon v-if="selected.has(search.trim())" name="check" class="h-3 w-3" />
              <span v-else class="text-xs leading-none">+</span>
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">
                {{ $t('providers.addModelCustom', { name: search.trim() }) }}
              </span>
              <span class="font-mono text-[10px] text-muted-foreground truncate">{{ search.trim() }}</span>
            </span>
          </button>
        </div>

        <p v-if="selected.size > 0" class="text-xs text-muted-foreground">
          {{ $t('providers.addModelSelected', { count: selected.size }) }}
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="selected.size === 0 || saving" @click="handleAdd">
          <span
            v-if="saving"
            class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
          />
          {{ $t('providers.addModelButton') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, AvailableModel } from '~/features/providers/composables/useProviders'
import type { ProviderUpdatePayloadContract } from '@axiom/core/contracts'
import { formatContextWindow, formatModelCost } from '~/utils/modelFormat'
import { useProvidersApi } from '~/api/providers'
import { buildCatalogModelPatch } from '~/utils/catalogModelPatch'

const props = defineProps<{
  open: boolean
  provider: Provider | null
}>()

const emit = defineEmits<{
  close: []
  added: []
}>()

const { fetchModels, fetchLiveModels, updateProvider, presets } = useProviders()
const providersApi = useProvidersApi()
const { t } = useI18n()

const search = ref('')
const catalog = ref<AvailableModel[]>([])
const loading = ref(false)
const loadError = ref(false)
const selected = ref<Set<string>>(new Set())
const saving = ref(false)

// Multi-term search: every whitespace-separated term must match somewhere in
// the id or name (e.g. "nvidia free" finds "nvidia/…:free" models).
const filteredModels = computed(() => {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return catalog.value
  return catalog.value.filter((model) => {
    const haystack = `${model.id} ${model.name}`.toLowerCase()
    return terms.every(term => haystack.includes(term))
  })
})

// The custom-model fallback row is shown only when the search text does not
// match any catalog entry (and is non-empty). For providers with an empty
// catalog (e.g. Ollama, openai-compatible) every non-empty search qualifies.
const canAddCustom = computed(() => {
  const query = search.value.trim()
  if (!query) return false
  return !filteredModels.value.some(
    model => model.id.toLowerCase() === query.toLowerCase(),
  )
})

function isAlreadyEnabled(modelId: string): boolean {
  const enabled = props.provider?.enabledModels
  return Boolean(enabled && enabled.includes(modelId))
}

function toggleSelected(modelId: string) {
  if (isAlreadyEnabled(modelId)) return
  const next = new Set(selected.value)
  if (next.has(modelId)) next.delete(modelId)
  else next.add(modelId)
  selected.value = next
}

async function loadCatalog() {
  if (!props.provider) return
  loading.value = true
  loadError.value = false
  try {
    // Dynamic-catalog providers (e.g. OpenRouter) serve their model list live
    // from the provider's own /models endpoint; the backend falls back to the
    // curated catalog if that fetch fails.
    catalog.value = presets.value[props.provider.providerType]?.dynamicCatalog
      ? await fetchLiveModels(props.provider.id)
      : await fetchModels(props.provider.providerType)
  } catch {
    loadError.value = true
    catalog.value = []
  } finally {
    loading.value = false
  }
}

// Models from a live catalog (e.g. OpenRouter) are usually absent from the
// bundled pi-ai catalog, so their pricing/context window would otherwise be
// unknown to buildModel(). Persist that metadata as per-model overrides.
async function persistLiveCatalogMetadata(provider: Provider, modelIds: string[]) {
  if (!presets.value[provider.providerType]?.dynamicCatalog) return

  const patches = catalog.value
    .filter(entry => modelIds.includes(entry.id))
    .map(entry => ({ modelId: entry.id, patch: buildCatalogModelPatch(entry) }))

  // Best-effort enrichment: a failed patch must not block enabling the model.
  await Promise.allSettled(
    patches
      .filter(({ patch }) => patch !== null)
      .map(({ modelId, patch }) => providersApi.updateProviderModel(provider.id, modelId, patch!)),
  )
}

async function handleAdd() {
  if (!props.provider || selected.value.size === 0) return
  saving.value = true
  try {
    const current = props.provider.enabledModels ?? []
    const added = Array.from(selected.value).filter(id => !current.includes(id))
    const merged = Array.from(new Set([...current, ...added]))
    const payload: ProviderUpdatePayloadContract = { enabledModels: merged }
    await persistLiveCatalogMetadata(props.provider, added)
    const result = await updateProvider(props.provider.id, payload)
    if (result) {
      emit('added')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

watch(
  () => [props.open, props.provider?.id] as const,
  ([isOpen]) => {
    if (isOpen) {
      search.value = ''
      selected.value = new Set()
      loadError.value = false
      if (props.provider) {
        loadCatalog()
      }
    }
  },
  { immediate: true },
)
</script>
