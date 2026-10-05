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
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium text-foreground">{{ provider.name }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ modelId }}</span>
        </div>

        <!-- Description -->
        <div class="flex flex-col gap-2">
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

        <!-- Native Ollama only: measured num_ctx baseline + thinking capability. -->
        <div v-if="isNative" class="flex flex-col gap-3" data-testid="native-model-settings">
          <div class="flex flex-col gap-1">
            <Label for="model-ollama-num-ctx">{{ $t('providers.editModelNumCtxLabel') }}</Label>
            <Input
              id="model-ollama-num-ctx"
              v-model="form.ollamaNumCtx"
              type="number"
              :min="NUM_CTX_MIN"
              :max="NUM_CTX_MAX"
              step="1"
              inputmode="numeric"
              :placeholder="$t('providers.editModelNumCtxPlaceholder')"
              :aria-invalid="numCtxError ? 'true' : undefined"
              aria-describedby="model-ollama-num-ctx-hint"
              class="text-sm"
            />
            <p v-if="numCtxError" class="text-xs text-destructive" role="alert" data-testid="num-ctx-error">
              {{ $t('providers.editModelNumCtxInvalid', { min: NUM_CTX_MIN, max: NUM_CTX_MAX }) }}
            </p>
            <p id="model-ollama-num-ctx-hint" class="break-words text-xs text-muted-foreground">
              {{ $t('providers.editModelNumCtxHint') }}
            </p>
          </div>
          <label class="flex items-start gap-2 text-sm">
            <input
              v-model="form.reasoning"
              type="checkbox"
              class="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              data-testid="model-reasoning"
            >
            <span class="min-w-0 break-words">
              {{ $t('providers.editModelReasoningLabel') }}
              <span class="block text-xs text-muted-foreground">{{ $t('providers.editModelReasoningHint') }}</span>
            </span>
          </label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="emit('close')">
          {{ $t('providers.cancel') }}
        </Button>
        <Button :disabled="!canSave || saving" @click="handleSave">
          <span
            v-if="saving"
            class="mr-2 h-3.5 w-3.5 animate-spin rounded-full border-2 border-transparent border-t-current"
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
import { NUM_CTX_MAX, NUM_CTX_MIN, nativeModelPatch, parseNumCtxInput } from '~/features/providers/nativeModelSettings'

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

const form = reactive({
  description: '',
  costInput: '',
  costOutput: '',
  costCacheRead: '',
  costCacheWrite: '',
  ollamaNumCtx: '' as string | number,
  reasoning: false,
})
const saving = ref(false)

const isNative = computed(() => props.provider?.providerType === 'ollama-native')
const numCtxError = computed(() => isNative.value && parseNumCtxInput(form.ollamaNumCtx) === 'invalid')

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
  return Boolean(props.provider && props.modelId) && !numCtxError.value
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
    if (isNative.value) {
      const native = nativeModelPatch(form, existingEntry.value)
      if (native === 'invalid') return
      Object.assign(payload, native)
    }

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
  form.ollamaNumCtx = entry?.ollamaNumCtx != null ? String(entry.ollamaNumCtx) : ''
  form.reasoning = Boolean(entry?.reasoning)
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
