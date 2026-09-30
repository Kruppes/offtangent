<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v && !oauthInProgress) emit('close') }">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ mode === 'edit' ? $t('providers.editProvider') : $t('providers.addProvider') }}</DialogTitle>
        <DialogDescription>{{ mode === 'edit' ? $t('providers.editProviderDescription') : $t('providers.addProviderDescription') }}</DialogDescription>
      </DialogHeader>

      <form class="flex flex-col gap-4" @submit.prevent="handleSubmit">
        <!-- Name -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-name">{{ $t('providers.name') }}</Label>
          <Input
            id="provider-name"
            v-model="form.name"
            type="text"
            :placeholder="$t('providers.namePlaceholder')"
            :disabled="oauthInProgress"
            required
          />
        </div>

        <!-- Type -->
        <div class="flex flex-col gap-1.5">
          <Label for="provider-type">{{ $t('providers.type') }}</Label>
          <Select
            v-model="form.providerType"
            :disabled="oauthInProgress"
            :required="true"
            @update:model-value="onTypeChange"
          >
            <SelectTrigger id="provider-type">
              <SelectValue :placeholder="$t('providers.selectType')" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{{ $t('providers.groupApiKey') }}</SelectLabel>
                <SelectItem v-for="(preset, key) in apiKeyPresets" :key="key" :value="String(key)">
                  {{ presetLabel(String(key), preset) }}
                </SelectItem>
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>{{ $t('providers.groupSubscription') }}</SelectLabel>
                <SelectItem v-for="(preset, key) in subscriptionPresets" :key="key" :value="String(key)">
                  {{ presetLabel(String(key), preset) }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <!-- Base URL (only for providers with editable URLs) -->
        <div v-if="form.providerType && !isOAuthProvider && selectedPreset?.urlEditable" class="flex flex-col gap-1.5">
          <Label for="provider-url">{{ $t('providers.baseUrl') }}</Label>
          <Input
            id="provider-url"
            v-model="form.baseUrl"
            type="url"
            :placeholder="isOpenAiCompatibleProvider ? openAiCompatibleBaseUrlPlaceholder : 'https://...'"
            :required="isOpenAiCompatibleProvider"
          />
          <p v-if="selectedPreset?.type === 'ollama'" class="text-xs text-muted-foreground">
            {{ $t('providers.ollamaUrlHint') }}
          </p>
          <p v-else-if="isOpenAiCompatibleProvider" class="text-xs text-muted-foreground">
            {{ openAiCompatibleBaseUrlHint }}
          </p>
        </div>

        <!-- API Key (all non-OAuth providers; optional for providers that don't require it) -->
        <div v-if="form.providerType && !isOAuthProvider" class="flex flex-col gap-1.5">
          <Label for="provider-key">
            {{ $t('providers.apiKey') }}
            <span v-if="!selectedPreset?.requiresApiKey" class="text-xs font-normal text-muted-foreground">({{ $t('providers.optional') }})</span>
          </Label>
          <Input
            id="provider-key"
            v-model="form.apiKey"
            type="password"
            :placeholder="mode === 'edit' ? $t('providers.apiKeyHint') : $t('providers.apiKeyPlaceholder')"
          />
          <p v-if="mode === 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyHint') }}</p>
          <p v-if="!selectedPreset?.requiresApiKey && mode !== 'edit'" class="text-xs text-muted-foreground">{{ $t('providers.apiKeyOptionalHint') }}</p>
        </div>

        <!-- Provider-specific extra fields declared by the selected preset -->
        <template v-if="extraFieldDefs.length > 0">
          <div v-for="field in extraFieldDefs" :key="field.key" class="flex flex-col gap-1.5">
            <Label :for="`provider-extra-${field.key}`">
              {{ extraFieldLabel(field) }}
              <span v-if="!field.required" class="text-xs font-normal text-muted-foreground">({{ $t('providers.optional') }})</span>
            </Label>
            <Input
              :id="`provider-extra-${field.key}`"
              v-model="form.extraFields[field.key]"
              :type="field.secret ? 'password' : 'text'"
              :placeholder="extraFieldPlaceholder(field)"
              :disabled="oauthInProgress"
            />
            <p v-if="extraFieldHint(field)" class="text-xs text-muted-foreground">{{ extraFieldHint(field) }}</p>
          </div>
        </template>

        <!-- Ollama: model list from Ollama API + pull. Shown in edit mode only:
             providers are created without models and models are added afterwards
             via the "Add Model" dialog. Ollama additionally supports local pulls
             here, which the catalog-based "Add Model" dialog cannot cover. -->
        <div v-if="mode === 'edit' && form.providerType && isOllamaProvider" class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <Label>{{ $t('providers.ollamaModels') }}</Label>
            <button
              type="button"
              class="text-xs text-primary hover:underline disabled:opacity-50"
              :disabled="ollamaLoading"
              @click="loadOllamaModels"
            >
              {{ ollamaLoading ? $t('providers.ollamaModelsLoading') : (ollamaModels.length > 0 ? $t('providers.ollamaModelsRefresh') : $t('providers.ollamaModelsRefresh')) }}
            </button>
          </div>

          <!-- Not loaded yet -->
          <div v-if="!ollamaLoaded && !ollamaLoading && !ollamaError" class="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {{ $t('providers.ollamaNoModelsHint') }}
          </div>

          <!-- Loading -->
          <div v-else-if="ollamaLoading" class="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
            {{ $t('providers.ollamaModelsLoading') }}
          </div>

          <!-- Error -->
          <div v-else-if="ollamaError" class="flex flex-col gap-1">
            <div class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {{ $t('providers.ollamaModelsError') }}: {{ ollamaError }}
            </div>
            <button
              type="button"
              class="self-start text-xs text-destructive hover:underline"
              @click="loadOllamaModels"
            >
              {{ $t('providers.modelsRetry') }}
            </button>
          </div>

          <!-- Empty -->
          <div v-else-if="ollamaModels.length === 0" class="rounded-md border border-dashed border-border bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
            {{ $t('providers.ollamaModelsEmpty') }}
          </div>

          <!-- Model list -->
          <div v-else class="flex flex-col gap-0 rounded-md border border-border overflow-hidden max-h-52 overflow-y-auto">
            <label
              v-for="model in ollamaModels"
              :key="model.name"
              :class="[
                'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-accent/50',
                form.enabledModels.includes(model.name) ? 'bg-accent/30' : '',
              ]"
            >
              <input
                type="checkbox"
                :checked="form.enabledModels.includes(model.name)"
                class="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                @change="toggleOllamaModel(model.name)"
              >
              <div class="flex-1 min-w-0">
                <span class="font-mono text-xs truncate block">{{ model.name }}</span>
                <span class="text-[10px] text-muted-foreground">
                  {{ model.parameterSize }}
                  <template v-if="model.quantization"> · {{ model.quantization }}</template>
                  · {{ formatSize(model.size) }}
                </span>
              </div>

            </label>
          </div>
          <p v-if="ollamaModels.length > 0" class="text-xs text-muted-foreground">{{ $t('providers.enabledModelsHint') }}</p>

          <!-- Pull model -->
          <div class="flex flex-col gap-1.5 mt-1">
            <Label>{{ $t('providers.ollamaPullModel') }}</Label>
            <div class="flex gap-2">
              <Input
                v-model="ollamaPullName"
                type="text"
                :placeholder="$t('providers.ollamaPullPlaceholder')"
                :disabled="ollamaPulling"
                class="flex-1 font-mono text-xs"
                @keydown.enter.prevent="pullModel"
              />
              <Button
                type="button"
                variant="outline"
                :disabled="!ollamaPullName.trim() || ollamaPulling"
                class="shrink-0"
                @click="pullModel"
              >
                <span
                  v-if="ollamaPulling"
                  class="mr-1.5 h-3 w-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                />
                {{ ollamaPulling ? $t('providers.ollamaPulling') : 'Pull' }}
              </Button>
            </div>

            <!-- Pull progress -->
            <div v-if="ollamaPulling" class="flex flex-col gap-1.5">
              <div class="flex items-center justify-between text-xs text-muted-foreground">
                <span>{{ ollamaPullStatus || $t('providers.ollamaPulling') + '...' }}</span>
                <span v-if="ollamaPullProgress > 0" class="font-medium tabular-nums text-foreground">{{ ollamaPullProgress }}%</span>
              </div>
              <div class="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  class="h-full rounded-full bg-primary transition-all duration-300"
                  :style="{ width: `${ollamaPullProgress}%` }"
                />
              </div>
            </div>

            <!-- Pull result -->
            <div v-if="ollamaPullResult" :class="[
              'rounded-md px-3 py-2 text-xs',
              ollamaPullResult.success
                ? 'border border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400'
                : 'border border-destructive/30 bg-destructive/10 text-destructive',
            ]">
              {{ ollamaPullResult.message }}
            </div>
          </div>
        </div>




        <!-- Degraded Threshold -->
        <div v-if="form.providerType" class="flex flex-col gap-1.5">
          <Label for="provider-degraded-threshold">{{ $t('providers.degradedThreshold') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="provider-degraded-threshold"
              v-model.number="form.degradedThresholdMs"
              type="number"
              min="1"
              step="1"
              :placeholder="$t('providers.degradedThresholdPlaceholder')"
              :disabled="oauthInProgress"
              class="flex-1"
            />
            <span class="text-xs text-muted-foreground">ms</span>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.degradedThresholdHint') }}</p>
        </div>

        <!-- Health Check Timeout -->
        <div v-if="form.providerType" class="flex flex-col gap-1.5">
          <Label for="provider-health-check-timeout">{{ $t('providers.healthCheckTimeout') }}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="provider-health-check-timeout"
              :model-value="form.healthCheckTimeoutMs ?? undefined"
              @update:model-value="form.healthCheckTimeoutMs = $event === '' ? null : Number($event)"
              type="number"
              min="1"
              step="1"
              :placeholder="healthCheckTimeoutPlaceholder"
              :disabled="oauthInProgress"
              class="flex-1"
            />
            <span class="text-xs text-muted-foreground">ms</span>
          </div>
          <p class="text-xs text-muted-foreground">{{ $t('providers.healthCheckTimeoutHint') }}</p>
        </div>

        <!-- Text verbosity (OpenAI Codex Responses) -->
        <div v-if="supportsTextVerbosity" class="flex flex-col gap-1.5">
          <Label>{{ $t('providers.textVerbosity') }}</Label>
          <Select v-model="form.textVerbosity">
            <SelectTrigger>
              <SelectValue :placeholder="$t('providers.textVerbosityDefault')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{{ $t('providers.textVerbosityDefault') }}</SelectItem>
              <SelectItem value="low">{{ $t('providers.textVerbosityLow') }}</SelectItem>
              <SelectItem value="medium">{{ $t('providers.textVerbosityMedium') }}</SelectItem>
              <SelectItem value="high">{{ $t('providers.textVerbosityHigh') }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('providers.textVerbosityHint') }}</p>
        </div>

        <!-- Transport (OpenAI Codex Responses) -->
        <div v-if="supportsTransport" class="flex flex-col gap-1.5">
          <Label>{{ $t('providers.transport') }}</Label>
          <Select v-model="form.transport">
            <SelectTrigger>
              <SelectValue :placeholder="$t('providers.transportDefault')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{{ $t('providers.transportDefault') }}</SelectItem>
              <SelectItem value="sse">{{ $t('providers.transportSse') }}</SelectItem>
              <SelectItem value="websocket">{{ $t('providers.transportWebsocket') }}</SelectItem>
              <SelectItem value="websocket-cached">{{ $t('providers.transportWebsocketCached') }}</SelectItem>
              <SelectItem value="auto">{{ $t('providers.transportAuto') }}</SelectItem>
            </SelectContent>
          </Select>
          <p class="text-xs text-muted-foreground">{{ $t('providers.transportHint') }}</p>
        </div>

        <!-- OAuth Login Section -->
        <div v-if="isOAuthProvider && (mode === 'create' || oauthInProgress || oauthError)" class="flex flex-col gap-3">
          <!-- OAuth status messages -->
          <div v-if="oauthInProgress" class="rounded-md border border-border bg-muted/50 p-4">
            <div class="flex items-center gap-3">
              <span
                class="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                aria-hidden="true"
              />
              <div class="flex-1">
                <p class="text-sm font-medium">{{ $t('providers.oauthWaiting') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">{{ $t('providers.oauthWaitingHint') }}</p>
              </div>
            </div>

            <!-- Manual code input fallback -->
            <div v-if="oauthUsesCallback" class="mt-3 flex flex-col gap-1.5">
              <Label for="oauth-code" class="text-xs">{{ $t('providers.oauthManualCode') }}</Label>
              <div class="flex gap-2">
                <Input
                  id="oauth-code"
                  v-model="manualCode"
                  type="text"
                  :placeholder="$t('providers.oauthManualCodePlaceholder')"
                  class="flex-1 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  :disabled="!manualCode.trim()"
                  @click="submitManualCode"
                >
                  {{ $t('providers.oauthSubmitCode') }}
                </Button>
              </div>
            </div>
          </div>

          <div v-if="oauthError" class="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p class="text-sm text-destructive">{{ oauthError }}</p>
          </div>
        </div>

        <DialogFooter class="!flex-row !justify-start items-center">
          <!-- Renew token button (left-aligned, only for OAuth edit mode) -->
          <template v-if="isOAuthProvider && mode === 'edit'">
            <Button
              v-if="!oauthInProgress"
              type="button"
              variant="outline"
              @click="startOAuthRenew"
            >
              {{ $t('providers.oauthRenewToken') }}
            </Button>
            <Button
              v-else
              type="button"
              variant="outline"
              @click="cancelOAuthRenew"
            >
              <span
                class="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                aria-hidden="true"
              />
              {{ $t('providers.oauthCancelRenew') }}
            </Button>
          </template>
          <div class="flex-1" />
          <div class="flex items-center gap-2">
            <Button type="button" variant="outline" :disabled="oauthInProgress" @click="emit('close')">
              {{ $t('providers.cancel') }}
            </Button>
            <!-- Regular save for API key providers or edit mode -->
            <Button
              v-if="!isOAuthProvider || mode === 'edit'"
              type="submit"
              :disabled="!canSubmit"
            >
              {{ $t('providers.save') }}
            </Button>
            <!-- OAuth login button for create mode -->
            <Button
              v-else-if="mode === 'create'"
              type="button"
              :disabled="!canStartOAuth || oauthInProgress"
              @click="startOAuth"
            >
              <span
                v-if="oauthInProgress"
                class="mr-1.5 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                aria-hidden="true"
              />
              {{ oauthInProgress ? $t('providers.oauthConnecting') : $t('providers.oauthLogin') }}
            </Button>
          </div>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Provider, ProviderTypePreset, OllamaModel, OllamaPullEvent } from '~/features/providers/composables/useProviders'

export interface ProviderFormPayload {
  name: string
  providerType: string
  baseUrl: string
  apiKey: string
  enabledModels: string[]
  degradedThresholdMs: number
  healthCheckTimeoutMs: number | null
  textVerbosity: null | 'low' | 'medium' | 'high'
  transport: null | 'sse' | 'websocket' | 'websocket-cached' | 'auto'
  extraFields: Record<string, string>
}

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  provider?: Provider | null
  presets: Record<string, ProviderTypePreset>
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: ProviderFormPayload]
  oauthComplete: []
}>()

const {
  fetchOllamaModels,
  probeOllamaModels,
  pullOllamaModel,
  probeOllamaPull,
  startOAuthLogin,
  pollOAuthStatus,
  submitOAuthCode,
  fetchProviders,
} = useProviders()
const { t } = useI18n()

const form = reactive({
  name: '',
  providerType: '',
  baseUrl: '',
  apiKey: '',
  enabledModels: [] as string[],
  degradedThresholdMs: 5000,
  healthCheckTimeoutMs: null as number | null,
  textVerbosity: 'default' as 'default' | 'low' | 'medium' | 'high',
  transport: 'default' as 'default' | 'sse' | 'websocket' | 'websocket-cached' | 'auto',
  extraFields: {} as Record<string, string>,
})

const oauthInProgress = ref(false)
const oauthError = ref<string | null>(null)
const oauthLoginId = ref<string | null>(null)
const oauthUsesCallback = ref(false)
const manualCode = ref('')

// Ollama state
const ollamaModels = ref<OllamaModel[]>([])
const ollamaLoading = ref(false)
const ollamaLoaded = ref(false)
const ollamaError = ref<string | null>(null)
const ollamaPullName = ref('')
const ollamaPulling = ref(false)
const ollamaPullStatus = ref('')
const ollamaPullProgress = ref(0)
const ollamaPullResult = ref<{ success: boolean; message: string } | null>(null)

const isOllamaProvider = computed(() => {
  return form.providerType === 'ollama'
})

// Mirrors the backend creation defaults (getDefaultHealthCheckTimeoutMs):
// local Ollama providers get a 60 s cold-start-tolerant timeout, everything
// else keeps the regular 15 s. Shown as placeholder when the field is empty.
const healthCheckTimeoutPlaceholder = computed(() => {
  return form.providerType === 'ollama' ? '60000' : '15000'
})

const selectedPreset = computed(() => {
  if (!form.providerType) return null
  return props.presets[form.providerType] ?? null
})

type ExtraFieldDef = NonNullable<ProviderTypePreset['extraFields']>[number]

const extraFieldDefs = computed<ExtraFieldDef[]>(() => selectedPreset.value?.extraFields ?? [])

const isOAuthProvider = computed(() => {
  return selectedPreset.value?.authMethod === 'oauth'
})

const isOpenAiCompatibleProvider = computed(() => {
  return form.providerType === 'openai-compatible' || selectedPreset.value?.type === 'openai-compatible'
})

const supportsTextVerbosity = computed(() => {
  return selectedPreset.value?.apiType === 'openai-codex-responses'
})

/**
 * Wire-level transport is currently only honoured by the OpenAI Codex /
 * Responses apiType — every other provider streams over SSE only and the
 * field is dropped on persist. Mirrors `presetSupportsTransport()` in
 * `@axiom/core/provider-config`.
 */
const supportsTransport = computed(() => {
  return selectedPreset.value?.apiType === 'openai-codex-responses'
})

const canStartOAuth = computed(() => {
  return Boolean(form.name.trim() && form.providerType)
})

const canSubmit = computed(() => {
  return Boolean(form.name.trim() && form.providerType)
})

function translatedOr(key: string, fallback: string): string {
  const translated = t(key)
  return translated && translated !== key ? translated : fallback
}

const openAiCompatibleBaseUrlPlaceholder = computed(() => translatedOr(
  'providers.openaiCompatibleBaseUrlPlaceholder',
  'https://integrate.api.nvidia.com/v1',
))

const openAiCompatibleBaseUrlHint = computed(() => translatedOr(
  'providers.openaiCompatibleBaseUrlHint',
  'Required. Endpoint root that exposes /v1/chat/completions (e.g. NVIDIA NIM, LM Studio, vLLM).',
))

function extraFieldTranslation(field: ExtraFieldDef, part: 'label' | 'placeholder' | 'hint', fallback: string): string {
  return translatedOr(`providers.providerExtraFields.${form.providerType}.${field.key}.${part}`, fallback)
}

function extraFieldLabel(field: ExtraFieldDef): string {
  return extraFieldTranslation(field, 'label', field.label)
}

function extraFieldHint(field: ExtraFieldDef): string {
  return extraFieldTranslation(field, 'hint', field.hint ?? '')
}

function extraFieldPlaceholder(field: ExtraFieldDef): string {
  if (field.secret && props.mode === 'edit' && props.provider?.extraFieldsSet?.[field.key]) {
    return translatedOr('providers.extraFieldSecretKeep', 'Leave blank to keep the stored value')
  }
  return extraFieldTranslation(field, 'placeholder', field.placeholder ?? '')
}

function sortPresetsByLabel(entries: [string, ProviderTypePreset][]): Record<string, ProviderTypePreset> {
  return Object.fromEntries(
    [...entries].sort(([aKey, a], [bKey, b]) =>
      presetLabel(aKey, a).localeCompare(presetLabel(bKey, b))
    )
  )
}

const apiKeyPresets = computed(() => {
  return sortPresetsByLabel(
    Object.entries(props.presets).filter(([, p]) => p.authMethod !== 'oauth' && !p.subscription)
  )
})

/**
 * Resolve the dropdown label for a preset.
 *
 * The backend ships English labels (e.g. "OpenAI-compatible (custom)"); for
 * a select few preset keys we expose a translatable override under
 * `providers.providerTypes.<key>` so non-English UIs can localize them.
 * Falls back to the backend label when no translation exists.
 */
function presetLabel(key: string, preset: ProviderTypePreset): string {
  const translationKey = `providers.providerTypes.${key}`
  const translated = t(translationKey)
  // vue-i18n returns the key itself when no translation is registered
  return translated && translated !== translationKey ? translated : preset.label
}

// Grouped under "Subscription / OAuth" in the dropdown. Includes OAuth
// providers plus API-key providers flagged as subscriptions (e.g. OpenCode
// Go). The flag only affects this visual grouping; `isOAuthProvider` still
// drives the actual auth flow.
const subscriptionPresets = computed(() => {
  return sortPresetsByLabel(
    Object.entries(props.presets).filter(([, p]) => p.authMethod === 'oauth' || p.subscription)
  )
})

// Sync form state when dialog opens or provider changes
watch(() => [props.open, props.provider] as const, ([isOpen, entry]) => {
  if (isOpen && props.mode === 'edit' && entry) {
    form.name = entry.name
    form.providerType = entry.providerType
    form.baseUrl = entry.baseUrl
    form.apiKey = ''
    form.enabledModels = [...(entry.enabledModels ?? [])]
    form.degradedThresholdMs = entry.degradedThresholdMs ?? 5000
    form.healthCheckTimeoutMs = entry.healthCheckTimeoutMs ?? null
    form.textVerbosity = entry.textVerbosity ?? 'default'
    form.transport = entry.transport ?? 'default'
    form.extraFields = { ...(entry.extraFields ?? {}) }
    // Reset Ollama state
    resetOllamaState()
    if (entry.providerType === 'ollama') {
      loadOllamaModels()
    }
    // Models for non-Ollama providers are managed via the "Add Model" dialog
    // after creation, so the form itself shows no catalog UI.
  } else if (isOpen && props.mode === 'create') {
    form.name = ''
    form.providerType = ''
    form.baseUrl = ''
    form.apiKey = ''
    form.enabledModels = []
    form.degradedThresholdMs = 5000
    form.healthCheckTimeoutMs = null
    form.textVerbosity = 'default'
    form.transport = 'default'
    form.extraFields = {}
    resetOllamaState()
    oauthInProgress.value = false
    oauthError.value = null
    oauthLoginId.value = null
    manualCode.value = ''
  }
}, { immediate: true })

function resetOllamaState() {
  ollamaModels.value = []
  ollamaLoading.value = false
  ollamaLoaded.value = false
  ollamaError.value = null
  ollamaPullName.value = ''
  ollamaPulling.value = false
  ollamaPullStatus.value = ''
  ollamaPullProgress.value = 0
  ollamaPullResult.value = null
}

async function loadOllamaModels() {
  // For create mode, we need the provider to exist first
  // Use a temporary fetch directly with the base URL
  if (props.mode === 'edit' && props.provider?.id) {
    ollamaLoading.value = true
    ollamaError.value = null
    try {
      const models = await fetchOllamaModels(props.provider.id)
      ollamaModels.value = models
      ollamaLoaded.value = true
      // Filter enabledModels to only include models that exist in Ollama
      const ollamaNames = new Set(models.map(m => m.name))
      form.enabledModels = form.enabledModels.filter(m => ollamaNames.has(m))
    } catch (err) {
      ollamaError.value = (err as Error).message
    } finally {
      ollamaLoading.value = false
    }
  } else if (props.mode === 'create') {
    // For create mode, probe Ollama via backend endpoint (avoids CORS / SSRF issues)
    ollamaLoading.value = true
    ollamaError.value = null
    try {
      const baseUrl = form.baseUrl || 'http://localhost:11434/v1'
      const models = await probeOllamaModels(baseUrl, form.providerType)
      ollamaModels.value = models
      ollamaLoaded.value = true
      // Filter enabledModels to only include models that exist in Ollama
      const ollamaNames = new Set(models.map(m => m.name))
      form.enabledModels = form.enabledModels.filter(m => ollamaNames.has(m))
    } catch (err) {
      ollamaError.value = (err as Error).message
    } finally {
      ollamaLoading.value = false
    }
  }
}

function toggleOllamaModel(modelName: string) {
  const idx = form.enabledModels.indexOf(modelName)
  if (idx >= 0) {
    if (form.enabledModels.length <= 1) return
    form.enabledModels.splice(idx, 1)
  } else {
    form.enabledModels.push(modelName)
  }
}

async function pullModel() {
  if (!ollamaPullName.value.trim()) return
  ollamaPulling.value = true
  ollamaPullStatus.value = ''
  ollamaPullProgress.value = 0
  ollamaPullResult.value = null

  try {
    if (props.mode === 'edit' && props.provider?.id) {
      // Use backend SSE endpoint
      await pullOllamaModel(props.provider.id, ollamaPullName.value.trim(), (event) => {
        if (event.error) {
          ollamaPullResult.value = { success: false, message: event.error }
        } else if (event.status) {
          ollamaPullStatus.value = event.status
          if (event.total && event.total > 0) {
            ollamaPullProgress.value = Math.round(((event.completed ?? 0) / event.total) * 100)
          }
        }
      })
    } else {
      // Create mode: pull via backend probe endpoint
      const baseUrl = form.baseUrl || 'http://localhost:11434/v1'
      await probeOllamaPull(baseUrl, form.providerType, ollamaPullName.value.trim(), (event: OllamaPullEvent) => {
        if (event.error) {
          ollamaPullResult.value = { success: false, message: event.error }
        } else if (event.status) {
          ollamaPullStatus.value = event.status
          if (event.total && event.total > 0) {
            ollamaPullProgress.value = Math.round(((event.completed ?? 0) / event.total) * 100)
          }
        }
      })
    }

    // vue-tsc's CFA narrows `ollamaPullResult.value` to `null` after the
    // `= null` assignment above and can't see the reassignments inside the
    // progress callback. We cast back to the ref's declared type so the
    // runtime check (which *does* observe the callback writes) compiles.
    type PullResult = { success: boolean; message: string } | null
    const pullResult = ollamaPullResult.value as PullResult
    if (pullResult?.success !== false) {
      ollamaPullResult.value = { success: true, message: t('providers.ollamaPullSuccess') }
      ollamaPullName.value = ''
      // Refresh model list
      await loadOllamaModels()
    }
  } catch (err) {
    ollamaPullResult.value = { success: false, message: `${t('providers.ollamaPullError')}: ${(err as Error).message}` }
  } finally {
    ollamaPulling.value = false
    ollamaPullStatus.value = ''
    ollamaPullProgress.value = 0
  }
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`
}

function normalizeTextVerbosityPayload(): null | 'low' | 'medium' | 'high' {
  return form.textVerbosity === 'default' ? null : form.textVerbosity
}

function normalizeTransportPayload(): null | 'sse' | 'websocket' | 'websocket-cached' | 'auto' {
  return form.transport === 'default' ? null : form.transport
}

function onTypeChange() {
  const preset = props.presets[form.providerType]
  if (preset && props.mode !== 'edit') {
    form.baseUrl = preset.baseUrl
    form.enabledModels = []
    form.extraFields = {}
  }
  oauthError.value = null
  resetOllamaState()
}

function normalizeExtraFieldsPayload(): Record<string, string> {
  return Object.fromEntries(
    extraFieldDefs.value.map(field => [field.key, form.extraFields[field.key]?.trim() ?? '']),
  )
}

function handleSubmit() {
  emit('submit', {
    ...form,
    healthCheckTimeoutMs: typeof form.healthCheckTimeoutMs === 'number' && Number.isFinite(form.healthCheckTimeoutMs)
      ? form.healthCheckTimeoutMs
      : null,
    textVerbosity: normalizeTextVerbosityPayload(),
    transport: normalizeTransportPayload(),
    enabledModels: [...form.enabledModels],
    extraFields: normalizeExtraFieldsPayload(),
  })
}

function cancelOAuthRenew() {
  // Stop the polling loop (it bails out on the next tick when this is false)
  // and reset local OAuth state so the user can trigger a fresh renewal.
  oauthInProgress.value = false
  oauthLoginId.value = null
  manualCode.value = ''
  oauthError.value = null
}

async function startOAuthRenew() {
  if (!props.provider?.id || oauthInProgress.value) return

  oauthInProgress.value = true
  oauthError.value = null
  manualCode.value = ''

  try {
    const response = await startOAuthLogin({
      providerType: form.providerType,
      name: form.name.trim(),
      enabledModels: [...form.enabledModels],
      providerId: props.provider.id,
      textVerbosity: normalizeTextVerbosityPayload(),
      transport: normalizeTransportPayload(),
    })

    oauthLoginId.value = response.loginId
    oauthUsesCallback.value = response.usesCallbackServer

    if (response.authUrl) {
      window.open(response.authUrl, '_blank')
    }

    pollForCompletion(response.loginId)
  } catch (err) {
    oauthError.value = (err as Error).message
    oauthInProgress.value = false
  }
}

async function startOAuth() {
  if (!canStartOAuth.value) return

  oauthInProgress.value = true
  oauthError.value = null
  manualCode.value = ''

  try {
    const response = await startOAuthLogin({
      providerType: form.providerType,
      name: form.name.trim(),
      enabledModels: [...form.enabledModels],
      textVerbosity: normalizeTextVerbosityPayload(),
      transport: normalizeTransportPayload(),
    })

    oauthLoginId.value = response.loginId
    oauthUsesCallback.value = response.usesCallbackServer

    // Open auth URL in new tab
    if (response.authUrl) {
      window.open(response.authUrl, '_blank')
    }

    // Start polling for completion
    pollForCompletion(response.loginId)
  } catch (err) {
    oauthError.value = (err as Error).message
    oauthInProgress.value = false
  }
}

async function pollForCompletion(loginId: string) {
  const maxAttempts = 120 // 2 minutes at 1s intervals
  for (let i = 0; i < maxAttempts; i++) {
    if (!oauthInProgress.value) return // cancelled

    await new Promise(resolve => setTimeout(resolve, 1000))

    try {
      const status = await pollOAuthStatus(loginId)

      if (status.status === 'completed') {
        oauthInProgress.value = false
        oauthLoginId.value = null
        await fetchProviders()
        emit('oauthComplete')
        emit('close')
        return
      }

      if (status.status === 'error') {
        oauthError.value = status.error ?? 'OAuth login failed'
        oauthInProgress.value = false
        oauthLoginId.value = null
        return
      }
    } catch (err) {
      oauthError.value = (err as Error).message
      oauthInProgress.value = false
      oauthLoginId.value = null
      return
    }
  }

  // Timeout
  oauthError.value = 'Login timed out. Please try again.'
  oauthInProgress.value = false
  oauthLoginId.value = null
}

async function submitManualCode() {
  if (!oauthLoginId.value || !manualCode.value.trim()) return

  try {
    await submitOAuthCode(oauthLoginId.value, manualCode.value.trim())
    manualCode.value = ''
  } catch (err) {
    oauthError.value = (err as Error).message
  }
}
</script>
