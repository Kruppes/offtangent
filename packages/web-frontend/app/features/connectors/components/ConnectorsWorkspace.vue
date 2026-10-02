<template>
  <div class="flex h-full flex-col overflow-y-auto">
    <PageHeader :title="$t('connectors.title')" :subtitle="$t('connectors.subtitle')" />

    <div class="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-4 md:p-6">
      <!-- Error with recovery -->
      <Alert v-if="error" variant="destructive">
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span class="min-w-0 break-words">{{ error }}</span>
          <Button variant="outline" size="sm" @click="retry">
            {{ $t('common.retry') }}
          </Button>
        </AlertDescription>
      </Alert>

      <!-- Callback outcome, coarse by design: no upstream detail is exposed -->
      <Alert v-if="callbackNotice" :variant="callbackNotice.variant">
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span class="min-w-0 break-words">{{ callbackNotice.text }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="callbackNotice = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="testNotice" :variant="testNotice.variant">
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span class="min-w-0 break-words">{{ testNotice.text }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="testNotice = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- P2: which model the connector sub-agent runs on -->
      <p v-if="localModel" class="text-xs text-muted-foreground" data-testid="connectors-local-model">
        <span>{{ $t('connectors.localModel.label') }}:</span>
        <span class="ml-1 font-medium text-foreground">{{ localModelName }}</span>
        <span class="ml-2">{{ localModelStrict }}</span>
        <span class="ml-2">{{ localModelReachable }}</span>
      </p>

      <!-- Loading -->
      <div
        v-if="loading && connectors.length === 0"
        class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground"
        role="status"
      >
        {{ $t('connectors.loading') }}
      </div>

      <!-- Empty -->
      <div
        v-else-if="connectors.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground"
      >
        <AppIcon name="plug" class="h-12 w-12 opacity-40" />
        <p class="text-sm">{{ $t('connectors.empty') }}</p>
      </div>

      <!-- One card per connector -->
      <section
        v-for="connector in connectors"
        :key="connector.id"
        class="rounded-xl border border-border bg-card p-4"
        :aria-labelledby="`connector-${connector.id}-name`"
      >
        <header class="flex flex-wrap items-start justify-between gap-2">
          <div class="min-w-0">
            <h2 :id="`connector-${connector.id}-name`" class="text-base font-semibold text-foreground">
              {{ connector.name }}
            </h2>
            <p class="mt-1 text-sm text-muted-foreground">{{ connector.description }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge :variant="statusVariant(connector.status)">
              {{ $t(`connectors.status.${connector.status}`) }}
            </Badge>
            <Badge v-if="connector.dataClass === 'local_only'" variant="outline" :title="$t('connectors.localOnlyHint')">
              {{ $t('connectors.localOnly') }}
            </Badge>
          </div>
        </header>

        <p v-if="connector.status === 'reauth_required'" class="mt-3 text-sm text-warning-foreground/90">
          {{ $t('connectors.reauthHint') }}
        </p>
        <p v-else-if="connector.status === 'error' && connector.lastError" class="mt-3 text-sm text-destructive">
          {{ $t(`connectors.errorReason.${connector.lastError}`, connector.lastError) }}
        </p>

        <dl v-if="connector.scopes.length > 0" class="mt-3 text-xs text-muted-foreground">
          <dt class="font-medium">{{ $t('connectors.scopes') }}</dt>
          <dd class="mt-0.5 break-words">{{ connector.scopes.join(', ') }}</dd>
        </dl>

        <!--
          One-time setup of the provider's OAuth client. Only connectors whose
          manifest ships a checklist render this block; a step is an id from the
          contract, its wording comes from the locale files. Open while the
          client is still missing, collapsed afterwards: from then on the
          checklist is reference material, not the next thing to do.
        -->
        <div
          v-if="connector.setupSteps.length > 0"
          class="mt-4 rounded-lg border border-border bg-muted/40 p-3"
          data-testid="setup-guide"
        >
          <button
            type="button"
            class="flex min-h-11 w-full items-center justify-between gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-expanded="isSetupOpen(connector) ? 'true' : 'false'"
            :aria-controls="`setup-steps-${connector.id}`"
            @click="toggleSetup(connector)"
          >
            <span class="min-w-0 text-sm font-medium text-foreground">{{ $t('connectors.setup.heading') }}</span>
            <AppIcon
              :name="isSetupOpen(connector) ? 'chevronDown' : 'chevronRight'"
              class="h-4 w-4 shrink-0 text-muted-foreground"
            />
          </button>
          <ol
            v-show="isSetupOpen(connector)"
            :id="`setup-steps-${connector.id}`"
            class="mt-2 list-decimal space-y-3 pl-5 text-sm"
          >
            <li v-for="step in connector.setupSteps" :key="step.id" class="min-w-0">
              <p class="font-medium text-foreground">{{ $t(`connectors.setup.${connector.id}.${step.id}.title`) }}</p>
              <p class="mt-0.5 break-words text-xs text-muted-foreground">
                {{ $t(`connectors.setup.${connector.id}.${step.id}.body`) }}
              </p>
              <!-- Same reason as in the form below: without PUBLIC_BASE_URL there is no URI to copy. -->
              <p
                v-if="step.copy === 'redirectUri' && !connector.redirectUri"
                class="mt-1.5 text-xs text-destructive"
                data-testid="setup-redirect-uri-missing"
              >
                {{ $t('connectors.form.redirectUriMissing') }}
              </p>
              <div v-if="step.url || stepCopyLabel(connector, step)" class="mt-1.5 flex flex-wrap items-center gap-2">
                <a
                  v-if="step.url"
                  :href="step.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {{ $t('connectors.setup.open') }}
                  <AppIcon name="externalLink" class="h-3.5 w-3.5" />
                </a>
                <Button
                  v-if="stepCopyLabel(connector, step)"
                  type="button"
                  variant="outline"
                  size="sm"
                  class="min-h-11"
                  @click="copyStepValue(connector, step)"
                >
                  {{ copiedKey === `${connector.id}:${step.id}` ? $t('common.copied') : $t(stepCopyLabel(connector, step)) }}
                </Button>
              </div>
            </li>
          </ol>
        </div>

        <!-- Client configuration -->
        <form class="mt-4 space-y-3" @submit.prevent="submitClient(connector)">
          <div class="space-y-1.5">
            <Label :for="`client-id-${connector.id}`">{{ $t('connectors.form.clientId') }}</Label>
            <Input
              :id="`client-id-${connector.id}`"
              v-model="drafts[connector.id]!.clientId"
              autocomplete="off"
              spellcheck="false"
              :placeholder="$t('connectors.form.clientIdPlaceholder')"
            />
          </div>
          <div class="space-y-1.5">
            <Label :for="`client-secret-${connector.id}`">{{ $t('connectors.form.clientSecret') }}</Label>
            <Input
              :id="`client-secret-${connector.id}`"
              v-model="drafts[connector.id]!.clientSecret"
              type="password"
              autocomplete="off"
              spellcheck="false"
              :placeholder="connector.clientSecretSet ? connector.clientSecretMasked : $t('connectors.form.clientSecretPlaceholder')"
              :aria-describedby="`client-secret-help-${connector.id}`"
            />
            <p :id="`client-secret-help-${connector.id}`" class="text-xs text-muted-foreground">
              {{ connector.clientSecretSet ? $t('connectors.form.clientSecretKeep') : $t('connectors.form.clientSecretHelp') }}
            </p>
          </div>

          <div class="space-y-1.5">
            <Label :for="`redirect-uri-${connector.id}`">{{ $t('connectors.form.redirectUri') }}</Label>
            <!--
              Without PUBLIC_BASE_URL the server refuses to start a flow
              (error public_base_url_missing). Showing an empty or guessed URI
              here would send the operator to register a wrong value.
            -->
            <p v-if="!connector.redirectUri" class="text-xs text-destructive" data-testid="redirect-uri-missing">
              {{ $t('connectors.form.redirectUriMissing') }}
            </p>
            <div v-else class="flex flex-wrap items-center gap-2">
              <Input
                :id="`redirect-uri-${connector.id}`"
                :model-value="connector.redirectUri"
                readonly
                class="min-w-0 flex-1 font-mono text-xs"
                @focus="($event.target as HTMLInputElement).select()"
              />
              <Button type="button" variant="outline" size="sm" @click="copyText(`${connector.id}:form`, connector.redirectUri)">
                {{ copiedKey === `${connector.id}:form` ? $t('common.copied') : $t('common.copy') }}
              </Button>
            </div>
            <p v-if="connector.redirectUri" class="text-xs text-muted-foreground">{{ $t('connectors.form.redirectUriHelp') }}</p>
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <Button type="submit" size="sm" :disabled="busyId === connector.id || !drafts[connector.id]!.clientId.trim()">
              {{ $t('connectors.actions.saveClient') }}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              :disabled="busyId === connector.id || !connector.clientSecretSet"
              @click="connect(connector.id)"
            >
              {{ connector.status === 'connected' ? $t('connectors.actions.reconnect') : $t('connectors.actions.connect') }}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="busyId === connector.id || !connector.hasTest || connector.status === 'not_configured'"
              @click="runTest(connector.id)"
            >
              {{ $t('connectors.actions.test') }}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              :disabled="busyId === connector.id || connector.status === 'not_configured' || connector.status === 'disconnected'"
              @click="runDisconnect(connector.id)"
            >
              {{ $t('connectors.actions.disconnect') }}
            </Button>
          </div>
        </form>
      </section>

      <p v-if="connectors.length > 0 && !baseUrl" class="text-xs text-warning-foreground/90">
        {{ $t('connectors.noBaseUrl') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Alert from '~/components/ui/Alert.vue'
import AlertDescription from '~/components/ui/AlertDescription.vue'
import Badge from '~/components/ui/Badge.vue'
import Button from '~/components/ui/Button.vue'
import Input from '~/components/ui/Input.vue'
import Label from '~/components/ui/Label.vue'
import { setupStepCopyLabel, setupStepCopyValue } from '../utils/setupSteps'
import { useConnectors } from '../composables/useConnectors'
import type { Connector } from '../composables/useConnectors'
import type { ConnectorSetupStepContract } from '@axiom/core/contracts'

const { t } = useI18n()
const {
  connectors,
  baseUrl,
  loading,
  error,
  busyId,
  fetchConnectors,
  localModel,
  fetchLocalModel,
  saveClient,
  connect,
  testConnector,
  disconnect,
} = useConnectors()

const localModelName = computed(() => {
  const state = localModel.value
  if (!state?.configured) return t('connectors.localModel.unset')
  return state.providerName ? `${state.modelId} (${state.providerName})` : state.modelId
})

const localModelStrict = computed(() => {
  const state = localModel.value
  if (!state?.configured) return ''
  return t(state.strictlyLocal ? 'connectors.localModel.strictYes' : 'connectors.localModel.strictNo')
})

const localModelReachable = computed(() => {
  const state = localModel.value
  if (!state?.configured || state.reachable === null) return ''
  return t(state.reachable ? 'connectors.localModel.reachableYes' : 'connectors.localModel.reachableNo')
})

type Notice = { variant: 'success' | 'destructive'; text: string }
const callbackNotice = ref<Notice | null>(null)
const testNotice = ref<Notice | null>(null)
/** Which copy button last succeeded, as `<connectorId>:<slot>`. */
const copiedKey = ref<string | null>(null)

/**
 * Explicit open/closed state per card. An id that is absent falls back to the
 * status, so a fresh list opens exactly the checklists that still have work.
 */
const setupOpen = reactive<Record<string, boolean>>({})

/** One draft per card, so typing in one form never touches another. */
const drafts = reactive<Record<string, { clientId: string; clientSecret: string }>>({})

watch(connectors, list => {
  for (const connector of list) {
    if (!drafts[connector.id]) drafts[connector.id] = { clientId: connector.clientId, clientSecret: '' }
    else drafts[connector.id]!.clientId = drafts[connector.id]!.clientId || connector.clientId
  }
}, { immediate: true, deep: false })

function statusVariant(status: Connector['status']): 'success' | 'warning' | 'destructive' | 'muted' {
  if (status === 'connected') return 'success'
  if (status === 'reauth_required') return 'warning'
  if (status === 'error') return 'destructive'
  return 'muted'
}

async function retry(): Promise<void> {
  await fetchConnectors()
}

async function submitClient(connector: Connector): Promise<void> {
  const draft = drafts[connector.id]!
  const payload = draft.clientSecret.trim().length > 0
    ? { clientId: draft.clientId.trim(), clientSecret: draft.clientSecret.trim() }
    : { clientId: draft.clientId.trim() }
  if (await saveClient(connector.id, payload)) {
    draft.clientSecret = ''
    testNotice.value = { variant: 'success', text: t('connectors.clientSaved') }
  }
}

async function runTest(id: string): Promise<void> {
  const result = await testConnector(id)
  if (!result) return
  testNotice.value = result.ok
    ? { variant: 'success', text: t('connectors.testOk') }
    : { variant: 'destructive', text: t(`connectors.testFailed.${result.detail}`, t('connectors.testFailed.unknown')) }
}

async function runDisconnect(id: string): Promise<void> {
  if (await disconnect(id)) {
    testNotice.value = { variant: 'success', text: t('connectors.disconnected') }
  }
}

function isSetupOpen(connector: Connector): boolean {
  return setupOpen[connector.id] ?? connector.status === 'not_configured'
}

function toggleSetup(connector: Connector): void {
  setupOpen[connector.id] = !isSetupOpen(connector)
}

/** The i18n key of a step's copy button; `''` hides the button. */
function stepCopyLabel(connector: Connector, step: ConnectorSetupStepContract): string {
  return setupStepCopyLabel(step, connector)
}

async function copyStepValue(connector: Connector, step: ConnectorSetupStepContract): Promise<void> {
  await copyText(`${connector.id}:${step.id}`, setupStepCopyValue(step, connector))
}

async function copyText(key: string, value: string): Promise<void> {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    copiedKey.value = key
    setTimeout(() => { if (copiedKey.value === key) copiedKey.value = null }, 2000)
  } catch {
    // Clipboard denied: the field is selectable, so manual copying still works.
  }
}

onMounted(async () => {
  // Read on mount only: the page renders server-side without a router context.
  const route = useRoute()
  const router = useRouter()
  const connected = typeof route.query.connected === 'string' ? route.query.connected : ''
  const callbackError = typeof route.query.error === 'string' ? route.query.error : ''
  if (connected) callbackNotice.value = { variant: 'success', text: t('connectors.connectSuccess') }
  else if (callbackError) {
    callbackNotice.value = {
      variant: 'destructive',
      text: t(`connectors.callbackError.${callbackError}`, t('connectors.callbackError.unknown')),
    }
  }
  if (connected || callbackError) await router.replace({ query: {} })
  await fetchConnectors()
  await fetchLocalModel()
})
</script>
