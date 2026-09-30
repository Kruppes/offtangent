<template>
  <section class="flex flex-col gap-6">
    <div>
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.tabs.models') }}
      </h2>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ $t('settings.tabs.modelsDescription') }}
      </p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-col gap-3">
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <template v-else>
      <!-- Error with retry -->
      <Alert v-if="error" variant="destructive">
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span>{{ error }}</span>
          <Button variant="outline" size="sm" @click="load()">{{ $t('common.retry') }}</Button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success">
        <AlertDescription>{{ successMessage }}</AlertDescription>
      </Alert>

      <!-- Read-only default -->
      <div class="rounded-xl border border-border bg-card px-4 py-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.modelPolicy.defaultRole') }}</h3>
            <p class="mt-1 font-mono text-xs break-all text-muted-foreground">
              {{ policy?.default ? `${policy.default.providerName} · ${policy.default.modelId}` : $t('settings.modelPolicy.noActiveProvider') }}
            </p>
          </div>
          <span class="text-xs text-muted-foreground">{{ $t('settings.modelPolicy.changeViaProviders') }}</span>
        </div>
      </div>

      <!-- Data-policy gate (privacy.modelGate) -->
      <div class="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-4">
        <div class="flex flex-col gap-1.5">
          <Label for="model-gate-mode" class="text-sm">{{ $t('settings.modelGate.modeLabel') }}</Label>
          <select
            id="model-gate-mode"
            v-model="gateMode"
            class="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground
                   focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
            :disabled="gateSaving"
            @change="saveGateMode()"
          >
            <option value="off">{{ $t('settings.modelGate.modeOff') }}</option>
            <option value="audit">{{ $t('settings.modelGate.modeAudit') }}</option>
            <option value="enforce">{{ $t('settings.modelGate.modeEnforce') }}</option>
          </select>
          <p class="text-xs text-muted-foreground">{{ $t('settings.modelGate.modeHint') }}</p>
        </div>

        <!-- privacy.blockedModelFamilies -->
        <div class="flex flex-col gap-1.5">
          <Label for="model-gate-families" class="text-sm">{{ $t('settings.modelGate.familiesLabel') }}</Label>
          <div class="flex flex-wrap items-center gap-2">
            <Input
              id="model-gate-families"
              v-model="familiesInput"
              :placeholder="$t('settings.modelGate.familiesPlaceholder')"
              :disabled="gateSaving"
              class="min-w-48 flex-1 font-mono text-sm"
              @keyup.enter="saveBlockedFamilies()"
            />
            <Button variant="outline" size="sm" :disabled="gateSaving || !familiesChanged" @click="saveBlockedFamilies()">
              {{ $t('common.save') }}
            </Button>
          </div>
          <ul v-if="familyChips.length > 0" class="flex flex-wrap gap-1" data-testid="model-gate-families">
            <li
              v-for="family in familyChips"
              :key="family"
              class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >{{ family }}</li>
          </ul>
          <p class="text-xs text-muted-foreground">{{ $t('settings.modelGate.familiesHint') }}</p>
        </div>

        <Separator />

        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.modelGate.auditTitle') }}</h3>
          <Button variant="outline" size="sm" :disabled="auditLoading" @click="loadAudit()">
            {{ $t('common.reload') }}
          </Button>
        </div>

        <!-- Loading -->
        <div v-if="auditLoading" class="flex flex-col gap-2">
          <Skeleton class="h-4 w-56" />
          <Skeleton class="h-4 w-full" />
          <Skeleton class="h-4 w-full" />
        </div>

        <!-- Error with retry -->
        <Alert v-else-if="auditError" variant="destructive">
          <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
            <span>{{ auditError }}</span>
            <Button variant="outline" size="sm" @click="loadAudit()">{{ $t('common.retry') }}</Button>
          </AlertDescription>
        </Alert>

        <!-- Empty -->
        <p v-else-if="auditEntries.length === 0" class="text-xs text-muted-foreground">
          {{ $t('settings.modelGate.auditEmpty') }}
        </p>

        <!-- Success -->
        <ul v-else class="flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid="model-gate-audit">
          <li
            v-for="(entry, index) in auditEntries"
            :key="`${entry.at}-${index}`"
            class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1.5"
          >
            <span
              :class="['rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                       entry.blocked ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground']"
            >
              {{ entry.blocked ? $t('settings.modelGate.blocked') : $t('settings.modelGate.allowed') }}
            </span>
            <span class="font-mono text-xs text-foreground">{{ entry.role }}</span>
            <span class="font-mono text-xs break-all text-muted-foreground">{{ entry.providerId }} · {{ entry.modelId }}</span>
            <span class="font-mono text-[10px] text-muted-foreground">{{ entry.policy.region }}/{{ entry.policy.training }}</span>
            <span class="font-mono text-[10px] text-muted-foreground">{{ entry.reason }}</span>
            <span v-if="entry.count > 1" class="font-mono text-[10px] text-muted-foreground">×{{ entry.count }}</span>
          </li>
        </ul>
      </div>

      <!-- Roles -->
      <div class="flex flex-col gap-5">
        <div v-for="role in roleRows" :key="role.role" class="flex flex-col gap-1.5">
          <Label :for="`model-policy-${role.role}`" class="text-sm">{{ role.role }}</Label>

          <!-- Chain roles: free text, validated on save -->
          <Input
            v-if="role.isChain"
            :id="`model-policy-${role.role}`"
            v-model="draft[role.role]"
            type="text"
            autocomplete="off"
            spellcheck="false"
            class="font-mono text-xs"
            :placeholder="$t('settings.modelPolicy.chainPlaceholder')"
          />

          <!-- Single roles: grouped dropdown over every enabled model -->
          <select
            v-else
            :id="`model-policy-${role.role}`"
            v-model="draft[role.role]"
            class="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground
                   focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            <option value="">{{ inheritLabel(role) }}</option>
            <optgroup v-for="group in modelGroups" :key="group.providerId" :label="group.label">
              <option
                v-for="model in group.models"
                :key="`${group.providerId}:${model}`"
                :value="`${group.providerId}:${model}`"
                :disabled="group.blocked"
              >
                {{ model }}{{ group.blocked ? ` — ${$t('settings.modelPolicy.blocked')}` : '' }}
              </option>
            </optgroup>
          </select>

          <p v-if="role.warning" class="text-xs text-destructive">{{ role.warning }}</p>
          <p v-else class="text-xs text-muted-foreground">{{ hintFor(role) }}</p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button :disabled="saving" @click="save()">
          <span
            v-if="saving"
            class="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('settings.save') }}
        </Button>
        <Button variant="outline" :disabled="loading || saving" @click="load()">{{ $t('common.reload') }}</Button>
      </div>

      <Separator />

      <!-- Resolve tester -->
      <div class="flex flex-col gap-3">
        <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.modelPolicy.resolveTitle') }}</h3>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div class="flex flex-1 flex-col gap-1.5">
            <Label for="model-policy-resolve-role" class="text-xs">{{ $t('settings.modelPolicy.resolveRole') }}</Label>
            <Input id="model-policy-resolve-role" v-model="resolveRoleInput" type="text" class="font-mono text-xs" />
          </div>
          <div class="flex flex-1 flex-col gap-1.5">
            <Label for="model-policy-resolve-kind" class="text-xs">{{ $t('settings.modelPolicy.resolveKind') }}</Label>
            <Input id="model-policy-resolve-kind" v-model="resolveKindInput" type="text" class="font-mono text-xs" />
          </div>
          <Button variant="outline" :disabled="resolving" @click="runResolve()">
            {{ $t('settings.modelPolicy.resolveAction') }}
          </Button>
        </div>
        <Alert v-if="resolveError" variant="destructive">
          <AlertDescription>{{ resolveError }}</AlertDescription>
        </Alert>
        <ol v-if="resolveResult" class="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
          <li
            v-for="(step, index) in resolveResult.steps"
            :key="index"
            :class="['font-mono text-xs break-all', step.taken ? 'text-foreground' : 'text-muted-foreground']"
          >
            {{ step.taken ? '→' : '·' }} {{ step.step }}: {{ step.value ?? '—' }} ({{ step.reason }})
          </li>
        </ol>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Alert from '~/components/ui/Alert.vue'
import AlertDescription from '~/components/ui/AlertDescription.vue'
import Button from '~/components/ui/Button.vue'
import Input from '~/components/ui/Input.vue'
import Label from '~/components/ui/Label.vue'
import Separator from '~/components/ui/Separator.vue'
import Skeleton from '~/components/ui/Skeleton.vue'
import {
  useModelPolicyApi,
  type ModelGateAuditEntry,
  type ModelPolicyResolveResponse,
  type ModelPolicyResponse,
} from '~/api/modelPolicy'
import { useProvidersApi } from '~/api/providers'
import { useSettingsApi } from '~/api/settings'

/** Provider types that must never be an automatic choice (mirrors the server guardrail). */
const BLOCKED_PROVIDER_TYPES = new Set(['zai', 'zai-coding', 'zai-coding-plan', 'kimi', 'kimi-coding', 'moonshot'])
const CHAIN_ROLES = new Set(['router', 'projectAssignment'])

const { t } = useI18n()
const { getModelPolicy, updateModelPolicy, resolveRole, getModelGateAudit } = useModelPolicyApi()
const { getSettings, updateSettings } = useSettingsApi()
const { getProviders } = useProvidersApi()

const policy = ref<ModelPolicyResponse | null>(null)
const draft = ref<Record<string, string>>({})
const modelGroups = ref<Array<{ providerId: string; label: string; blocked: boolean; models: string[] }>>([])
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')

// Data-policy gate: mode lives in settings (`privacy.modelGate`), the audit
// ring is read from the admin-only `/api/model-policy/audit` endpoint.
const gateMode = ref<'off' | 'audit' | 'enforce'>('audit')
const gateSaving = ref(false)
// `privacy.blockedModelFamilies`: a comma-separated list in the input, the
// normalized list (lower case, no duplicates) as chips underneath.
const familiesInput = ref('')
const savedFamilies = ref<string[]>([])
const auditEntries = ref<ModelGateAuditEntry[]>([])
const auditLoading = ref(true)
const auditError = ref('')

const resolveRoleInput = ref('task:cronjob')
const resolveKindInput = ref('cronjob')
const resolveResult = ref<ModelPolicyResolveResponse | null>(null)
const resolveError = ref('')
const resolving = ref(false)

/** The typed list behind the comma-separated input. */
function parseFamilies(value: string): string[] {
  const out: string[] = []
  for (const part of value.split(/[,\n]/)) {
    const family = part.trim().toLowerCase()
    if (family && !out.includes(family)) out.push(family)
  }
  return out
}

const familyChips = computed(() => parseFamilies(familiesInput.value))
const familiesChanged = computed(() =>
  familyChips.value.join(',') !== savedFamilies.value.join(','),
)

const roleRows = computed(() =>
  (policy.value?.policy ?? []).map(entry => ({ ...entry, isChain: CHAIN_ROLES.has(entry.role) })),
)

function inheritLabel(role: { resolved: { providerName: string; modelId: string } | null; source: string }): string {
  if (role.source !== 'active' && role.resolved) {
    return t('settings.modelPolicy.inherits', { value: `${role.resolved.providerName} · ${role.resolved.modelId}` })
  }
  const fallback = policy.value?.default
  return t('settings.modelPolicy.inherits', {
    value: fallback ? `${fallback.providerName} · ${fallback.modelId}` : t('settings.modelPolicy.noActiveProvider'),
  })
}

function hintFor(role: { source: string; legacyField?: string; resolved: { providerName: string; modelId: string } | null }): string {
  if (role.source === 'legacy' && role.legacyField) {
    return t('settings.modelPolicy.fromLegacy', { field: role.legacyField })
  }
  if (role.source === 'active') return inheritLabel(role)
  return role.resolved ? `${role.resolved.providerName} · ${role.resolved.modelId}` : ''
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const [policyResponse, providersResponse] = await Promise.all([getModelPolicy(), getProviders()])
    policy.value = policyResponse
    const next: Record<string, string> = {}
    for (const entry of policyResponse.policy) next[entry.role] = policyResponse.roles[entry.role] ?? ''
    draft.value = next
    modelGroups.value = (providersResponse.providers ?? [])
      .map(provider => ({
        providerId: provider.id,
        label: `${provider.name} (${provider.providerType})`,
        blocked: BLOCKED_PROVIDER_TYPES.has(String(provider.providerType)),
        models: [...(provider.enabledModels ?? [])],
      }))
      .filter(group => group.models.length > 0)
  } catch (err) {
    error.value = (err as Error).message || t('settings.modelPolicy.loadFailed')
  } finally {
    loading.value = false
  }
}

async function loadAudit(): Promise<void> {
  auditLoading.value = true
  auditError.value = ''
  try {
    const response = await getModelGateAudit()
    gateMode.value = response.mode
    auditEntries.value = response.entries
  } catch (err) {
    auditError.value = (err as Error).message || t('settings.modelGate.auditFailed')
  } finally {
    auditLoading.value = false
  }
}

async function loadBlockedFamilies(): Promise<void> {
  try {
    const settings = await getSettings()
    savedFamilies.value = [...(settings.privacy?.blockedModelFamilies ?? [])]
    familiesInput.value = savedFamilies.value.join(', ')
  } catch {
    // The gate mode and the audit list are the important part of this card;
    // a failed settings read leaves the field empty instead of the whole card.
  }
}

async function saveBlockedFamilies(): Promise<void> {
  gateSaving.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const families = familyChips.value
    await updateSettings({ privacy: { blockedModelFamilies: families } })
    savedFamilies.value = families
    familiesInput.value = families.join(', ')
    successMessage.value = t('settings.saveSuccess')
    await loadAudit()
  } catch (err) {
    error.value = (err as Error).message || t('settings.modelPolicy.saveFailed')
  } finally {
    gateSaving.value = false
  }
}

async function saveGateMode(): Promise<void> {
  gateSaving.value = true
  error.value = ''
  successMessage.value = ''
  try {
    await updateSettings({ privacy: { modelGate: gateMode.value } })
    successMessage.value = t('settings.saveSuccess')
    await loadAudit()
  } catch (err) {
    error.value = (err as Error).message || t('settings.modelPolicy.saveFailed')
  } finally {
    gateSaving.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  successMessage.value = ''
  try {
    const roles: Record<string, string> = {}
    for (const [role, value] of Object.entries(draft.value)) {
      const trimmed = (value ?? '').trim()
      if (trimmed) roles[role] = trimmed
    }
    policy.value = await updateModelPolicy(roles)
    successMessage.value = t('settings.saveSuccess')
  } catch (err) {
    error.value = (err as Error).message || t('settings.modelPolicy.saveFailed')
  } finally {
    saving.value = false
  }
}

async function runResolve(): Promise<void> {
  resolving.value = true
  resolveError.value = ''
  resolveResult.value = null
  try {
    resolveResult.value = await resolveRole({
      role: resolveRoleInput.value.trim(),
      kind: resolveKindInput.value.trim() || undefined,
    })
  } catch (err) {
    resolveError.value = (err as Error).message || t('settings.modelPolicy.resolveFailed')
  } finally {
    resolving.value = false
  }
}

onMounted(() => {
  void load()
  void loadAudit()
  void loadBlockedFamilies()
})
</script>
