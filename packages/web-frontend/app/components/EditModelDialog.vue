<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('close') }">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ $t('providers.editModelDialogTitle') }}</DialogTitle>
        <DialogDescription>
          {{ $t('providers.editModelDialogDescription') }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="provider && modelId" class="flex flex-col gap-4">
        <!-- Model identity -->
        <div class="flex flex-col gap-0.5">
          <span class="text-sm font-medium text-foreground">{{ provider.name }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ modelId }}</span>
        </div>

        <!-- Description -->
        <div class="flex flex-col gap-1.5">
          <Label for="model-description">{{ $t('providers.editModelDescriptionLabel') }}</Label>
          <textarea
            id="model-description"
            v-model="form.description"
            rows="3"
            class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            :placeholder="$t('providers.editModelDescriptionPlaceholder')"
          />
        </div>

        <!-- Cost -->
        <div class="flex flex-col gap-2">
          <Label>{{ $t('providers.editModelCostSection') }}</Label>
          <div class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1">
              <Label for="model-cost-input" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostInput') }}
              </Label>
              <Input
                id="model-cost-input"
                v-model="form.costInput"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('input')"
                class="text-sm"
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="model-cost-output" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostOutput') }}
              </Label>
              <Input
                id="model-cost-output"
                v-model="form.costOutput"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('output')"
                class="text-sm"
              />
            </div>
          </div>

          <!-- Cache costs: only shown for providers whose resolved model cost
               already carries cache values, or for Anthropic providers which
               always support prompt caching. -->
          <div v-if="showCacheFields" class="grid grid-cols-2 gap-2">
            <div class="flex flex-col gap-1">
              <Label for="model-cost-cache-read" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostCacheRead') }}
              </Label>
              <Input
                id="model-cost-cache-read"
                v-model="form.costCacheRead"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('cacheRead')"
                class="text-sm"
              />
            </div>
            <div class="flex flex-col gap-1">
              <Label for="model-cost-cache-write" class="text-xs text-muted-foreground">
                {{ $t('providers.editModelCostCacheWrite') }}
              </Label>
              <Input
                id="model-cost-cache-write"
                v-model="form.costCacheWrite"
                type="number"
                min="0"
                step="0.01"
                inputmode="decimal"
                :placeholder="costPlaceholder('cacheWrite')"
                class="text-sm"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.editModelCostHint') }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="!canSave || saving" @click="handleSave">
          <span
            v-if="saving"
            class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
          />
          {{ $t('providers.editModelSave') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider } from '~/features/providers/composables/useProviders'
import type { ProviderModelUpdatePayloadContract } from '@axiom/core/contracts'

const props = defineProps<{
  open: boolean
  provider: Provider | null
  modelId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { updateProviderModel } = useProviders()
const { t } = useI18n()

const form = reactive({
  description: '',
  costInput: '',
  costOutput: '',
  costCacheRead: '',
  costCacheWrite: '',
})
const saving = ref(false)

const existingEntry = computed(() =>
  props.provider?.models?.find(m => m.id === props.modelId),
)

const resolvedCost = computed(() => {
  const fromEntry = existingEntry.value?.cost
  if (fromEntry) return fromEntry
  const fromModelCosts = props.provider && props.modelId
    ? props.provider.modelCosts?.[props.modelId]
    : undefined
  return fromModelCosts
})

const isAnthropicProvider = computed(() => {
  const pt = props.provider?.providerType
  return pt === 'anthropic' || pt === 'anthropic-oauth'
})

const showCacheFields = computed(() => {
  const cost = resolvedCost.value
  if (cost && (cost.cacheRead != null || cost.cacheWrite != null)) return true
  return isAnthropicProvider.value
})

function costPlaceholder(field: 'input' | 'output' | 'cacheRead' | 'cacheWrite'): string {
  const cost = resolvedCost.value
  if (!cost) return '0.00'
  const value = cost[field]
  return value != null ? String(value) : '0.00'
}

function parseCostField(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  if (!Number.isFinite(num) || num < 0) return undefined
  return num
}

const canSave = computed(() => {
  // Gates on the dialog having a target provider and model. The server
  // enforces non-empty patches (at least a description or cost field).
  return Boolean(props.provider && props.modelId)
})

async function handleSave() {
  if (!props.provider || !props.modelId) return
  saving.value = true
  try {
    const payload: ProviderModelUpdatePayloadContract = {
      description: form.description,
    }
    const input = parseCostField(form.costInput)
    const output = parseCostField(form.costOutput)
    const cacheRead = parseCostField(form.costCacheRead)
    const cacheWrite = parseCostField(form.costCacheWrite)
    const cost: NonNullable<ProviderModelUpdatePayloadContract['cost']> = {}
    if (input !== undefined) cost.input = input
    if (output !== undefined) cost.output = output
    if (cacheRead !== undefined) cost.cacheRead = cacheRead
    if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite
    if (Object.keys(cost).length > 0) payload.cost = cost

    const result = await updateProviderModel(props.provider.id, props.modelId, payload)
    if (result) {
      emit('saved')
      emit('close')
    }
  } finally {
    saving.value = false
  }
}

function loadFromEntry() {
  const entry = existingEntry.value
  form.description = entry?.description ?? ''
  form.costInput = entry?.cost?.input != null ? String(entry.cost.input) : ''
  form.costOutput = entry?.cost?.output != null ? String(entry.cost.output) : ''
  form.costCacheRead = entry?.cost?.cacheRead != null ? String(entry.cost.cacheRead) : ''
  form.costCacheWrite = entry?.cost?.cacheWrite != null ? String(entry.cost.cacheWrite) : ''
}

watch(
  () => [props.open, props.provider?.id, props.modelId] as const,
  ([isOpen]) => {
    if (isOpen) {
      loadFromEntry()
    }
  },
  { immediate: true },
)
</script>
