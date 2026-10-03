<template>
  <section class="flex flex-col gap-6" data-secrets-panel>
    <div>
      <h2 class="text-lg font-semibold tracking-tight text-foreground">
        {{ $t('settings.secretHandles.title') }}
      </h2>
      <p class="mt-1 measure text-sm text-muted-foreground">
        {{ $t('settings.secretHandles.subtitle') }}
      </p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-col gap-3" data-secrets-loading>
      <span class="sr-only">{{ $t('settings.secretHandles.loading') }}</span>
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-16 w-full" />
      <Skeleton class="h-16 w-full" />
    </div>

    <template v-else>
      <!-- Error -->
      <Alert v-if="error" variant="destructive" data-secrets-error>
        <AlertTitle>{{ $t('settings.secretHandles.errorTitle') }}</AlertTitle>
        <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
          <span>{{ error }}</span>
          <Button variant="outline" size="sm" @click="load()">{{ $t('settings.secretHandles.retry') }}</Button>
        </AlertDescription>
      </Alert>

      <!-- Success -->
      <Alert v-if="successMessage" variant="success" data-secrets-success>
        <AlertDescription>{{ successMessage }}</AlertDescription>
      </Alert>

      <!-- Empty -->
      <div
        v-if="handles.length === 0"
        class="rounded-xl border border-dashed border-border bg-card px-4 py-6"
        data-secrets-empty
      >
        <div class="flex items-start gap-3">
          <AppIcon name="lock" class="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.secretHandles.emptyTitle') }}</h3>
            <p class="mt-1 measure text-sm text-muted-foreground">
              {{ $t('settings.secretHandles.emptyBody', { example: exampleHandle }) }}
            </p>
            <p class="mt-2 measure text-help text-muted-foreground">
              {{ $t('settings.secretHandles.emptyHint') }}
            </p>
          </div>
        </div>
      </div>

      <!-- List -->
      <div v-else class="flex flex-col gap-3">
        <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.secretHandles.listTitle') }}</h3>
        <ul class="flex flex-col gap-3" data-secrets-list>
          <li
            v-for="entry in handles"
            :key="entry.slug"
            class="rounded-xl border border-border bg-card px-3 py-3 sm:px-4"
          >
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <code class="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">{{ handleOf(entry.slug) }}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    class="min-h-9"
                    :aria-label="`${$t('settings.secretHandles.copyHandle')}: ${handleOf(entry.slug)}`"
                    @click="copyHandle(entry.slug)"
                  >
                    <AppIcon name="copy" size="sm" />
                    <span class="hidden sm:inline">{{ $t('settings.secretHandles.copyHandle') }}</span>
                  </Button>
                </div>
                <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div class="flex gap-1">
                    <dt>{{ $t('settings.secretHandles.columnKind') }}:</dt>
                    <dd class="font-medium text-foreground">{{ entry.kind }}</dd>
                  </div>
                  <div class="flex gap-1">
                    <dt>{{ $t('settings.secretHandles.columnSource') }}:</dt>
                    <dd>{{ entry.source }}</dd>
                  </div>
                  <div class="flex gap-1">
                    <dt>{{ $t('settings.secretHandles.columnLength') }}:</dt>
                    <dd>{{ $t('settings.secretHandles.lengthChars', { count: entry.length }) }}</dd>
                  </div>
                  <div class="flex gap-1">
                    <dt>{{ $t('settings.secretHandles.columnCreated') }}:</dt>
                    <dd>{{ formatDateTime(entry.createdAt) }}</dd>
                  </div>
                </dl>
              </div>

              <div class="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  class="min-h-9"
                  :aria-label="`${$t('settings.secretHandles.rename')}: ${entry.slug}`"
                  @click="startRename(entry.slug)"
                >
                  {{ $t('settings.secretHandles.rename') }}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  class="min-h-9"
                  :aria-label="`${$t('settings.secretHandles.delete')}: ${entry.slug}`"
                  @click="deleteTarget = entry.slug"
                >
                  {{ $t('settings.secretHandles.delete') }}
                </Button>
              </div>
            </div>

            <!-- Inline rename form -->
            <form
              v-if="renameTarget === entry.slug"
              class="mt-3 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end"
              @submit.prevent="submitRename()"
            >
              <div class="flex flex-1 flex-col gap-2">
                <Label :for="`secret-rename-${entry.slug}`" class="text-xs">
                  {{ $t('settings.secretHandles.renameLabel') }}
                </Label>
                <Input
                  :id="`secret-rename-${entry.slug}`"
                  v-model="renameDraft"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="font-mono text-xs"
                  :pattern="slugPattern"
                />
              </div>
              <div class="flex gap-2">
                <Button type="submit" size="sm" class="min-h-9" :disabled="saving">
                  {{ $t('settings.secretHandles.renameSave') }}
                </Button>
                <Button type="button" variant="outline" size="sm" class="min-h-9" @click="cancelRename()">
                  {{ $t('settings.secretHandles.renameCancel') }}
                </Button>
              </div>
            </form>
          </li>
        </ul>
      </div>

      <Separator />

      <!-- Create form -->
      <form class="flex flex-col gap-4" data-secrets-form @submit.prevent="submitCreate()">
        <div>
          <h3 class="text-sm font-semibold text-foreground">{{ $t('settings.secretHandles.addTitle') }}</h3>
          <p class="mt-1 measure text-sm text-muted-foreground">{{ $t('settings.secretHandles.addBody') }}</p>
        </div>

        <div class="flex flex-col gap-2">
          <Label for="secret-new-value" class="text-sm">{{ $t('settings.secretHandles.valueLabel') }}</Label>
          <div class="flex flex-col gap-2 sm:flex-row">
            <Input
              id="secret-new-value"
              v-model="valueDraft"
              :type="showValue ? 'text' : 'password'"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              class="flex-1 font-mono text-xs"
              :placeholder="$t('settings.secretHandles.valuePlaceholder')"
              :maxlength="maxValueLength"
              :aria-describedby="'secret-new-value-hint'"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              class="min-h-11 sm:min-h-10"
              :aria-pressed="showValue"
              @click="showValue = !showValue"
            >
              <AppIcon :name="showValue ? 'eyeOff' : 'eye'" size="sm" />
              {{ showValue ? $t('settings.secretHandles.valueHide') : $t('settings.secretHandles.valueShow') }}
            </Button>
          </div>
          <p id="secret-new-value-hint" class="measure text-help text-muted-foreground">
            {{ $t('settings.secretHandles.valueHint', { max: maxValueLength }) }}
            {{ $t('settings.secretHandles.valueMinHint', { min: minValueLength }) }}
          </p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex flex-col gap-2">
            <Label for="secret-new-kind" class="text-sm">{{ $t('settings.secretHandles.kindLabel') }}</Label>
            <select
              id="secret-new-kind"
              v-model="kindDraft"
              class="h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground
                     focus:outline-none focus:ring-2 focus:ring-ring disabled:bg-muted disabled:text-muted-foreground sm:h-10"
            >
              <option v-for="kind in kinds" :key="kind" :value="kind">{{ kind }}</option>
            </select>
          </div>

          <div class="flex flex-col gap-2">
            <Label for="secret-new-slug" class="text-sm">{{ $t('settings.secretHandles.slugLabel') }}</Label>
            <Input
              id="secret-new-slug"
              v-model="slugDraft"
              type="text"
              autocomplete="off"
              spellcheck="false"
              class="font-mono text-xs"
              :placeholder="$t('settings.secretHandles.slugPlaceholder')"
              :pattern="slugPattern"
              aria-describedby="secret-new-slug-hint"
            />
            <p id="secret-new-slug-hint" class="measure text-help text-muted-foreground">
              {{ $t('settings.secretHandles.slugHint') }}
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" class="min-h-11" :disabled="saving">
            <span
              v-if="saving"
              class="h-4 w-4 animate-spin rounded-full border-2 border-transparent border-t-current"
              aria-hidden="true"
            />
            {{ saving ? $t('settings.secretHandles.submitting') : $t('settings.secretHandles.submit') }}
          </Button>
          <Button type="button" variant="outline" class="min-h-11" :disabled="loading || saving" @click="load()">
            {{ $t('common.reload') }}
          </Button>
        </div>
      </form>
    </template>

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('settings.secretHandles.deleteConfirmTitle')"
      :description="$t('settings.secretHandles.deleteConfirm', { handle: handleOf(deleteTarget ?? '') })"
      :confirm-label="$t('settings.secretHandles.delete')"
      :cancel-label="$t('settings.secretHandles.deleteCancel')"
      destructive
      :loading="saving"
      @confirm="confirmDelete()"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<script setup lang="ts">
/**
 * Settings panel for sealed secret handles (plan 2026-09-26, step 1, T4).
 *
 * The panel shows metadata only — the API has no endpoint that returns a value,
 * so there is nothing here that could reveal one. The value field is a password
 * input with an explicit show toggle and `autocomplete="off"`, so a browser
 * neither stores nor offers the value.
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  SECRET_HANDLE_KINDS,
  SECRET_HANDLE_MAX_VALUE_LENGTH,
  SECRET_HANDLE_MIN_VALUE_LENGTH,
  SECRET_HANDLE_SLUG_PATTERN,
  isSecretHandleSlug,
  type SecretHandleMeta,
} from '@axiom/core/contracts'
import Alert from '~/components/ui/Alert.vue'
import AlertDescription from '~/components/ui/AlertDescription.vue'
import AlertTitle from '~/components/ui/AlertTitle.vue'
import Button from '~/components/ui/Button.vue'
import ConfirmDialog from '~/components/ConfirmDialog.vue'
import Input from '~/components/ui/Input.vue'
import Label from '~/components/ui/Label.vue'
import Separator from '~/components/ui/Separator.vue'
import Skeleton from '~/components/ui/Skeleton.vue'
import { useSecretHandlesApi } from '~/api/secretHandles'
import { writeClipboardText } from '~/composables/useMarkdown'

const { t } = useI18n()
const { formatDateTime } = useFormat()
const { listSecretHandles, createSecretHandle, renameSecretHandle, deleteSecretHandle } = useSecretHandlesApi()

const handles = ref<SecretHandleMeta[]>([])
const kinds = ref<readonly string[]>(SECRET_HANDLE_KINDS)
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const successMessage = ref('')

const valueDraft = ref('')
const kindDraft = ref<string>('password')
const slugDraft = ref('')
const showValue = ref(false)

const renameTarget = ref<string | null>(null)
const renameDraft = ref('')
const deleteTarget = ref<string | null>(null)

const maxValueLength = SECRET_HANDLE_MAX_VALUE_LENGTH
// F5 (triage 2026-09-26 19:25): shorter values are not globally redactable.
const minValueLength = SECRET_HANDLE_MIN_VALUE_LENGTH
const slugPattern = SECRET_HANDLE_SLUG_PATTERN
const exampleHandle = '{{secret:router-password}}'

function handleOf(slug: string): string {
  return `{{secret:${slug}}}`
}

function clearMessages(): void {
  error.value = ''
  successMessage.value = ''
}

async function load(): Promise<void> {
  loading.value = true
  clearMessages()
  try {
    const result = await listSecretHandles()
    handles.value = result.handles
    if (result.kinds?.length) kinds.value = result.kinds
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

async function submitCreate(): Promise<void> {
  clearMessages()
  const value = valueDraft.value
  if (!value) {
    error.value = t('settings.secretHandles.valueRequired')
    return
  }
  if (value.length < minValueLength) {
    error.value = t('settings.secretHandles.valueTooShort', { min: minValueLength })
    return
  }
  if (value.length > maxValueLength) {
    error.value = t('settings.secretHandles.valueTooLong', { max: maxValueLength })
    return
  }
  const slug = slugDraft.value.trim()
  if (slug && !isSecretHandleSlug(slug)) {
    error.value = t('settings.secretHandles.slugInvalid')
    return
  }

  saving.value = true
  try {
    const created = await createSecretHandle({ value, kind: kindDraft.value, ...(slug ? { slug } : {}) })
    // The draft is dropped immediately — the value must not linger in memory
    // longer than the request needs it.
    valueDraft.value = ''
    slugDraft.value = ''
    showValue.value = false
    await load()
    // F7: the API no longer reports whether the value was already stored, so
    // the UI cannot (and must not) distinguish the two cases either.
    successMessage.value = t('settings.secretHandles.createdSuccess', { handle: created.handle })
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

async function startRename(slug: string): Promise<void> {
  clearMessages()
  renameTarget.value = slug
  renameDraft.value = slug
  await nextTick()
  document.getElementById(`secret-rename-${slug}`)?.focus()
}

function cancelRename(): void {
  renameTarget.value = null
  renameDraft.value = ''
}

async function submitRename(): Promise<void> {
  const current = renameTarget.value
  if (!current) return
  clearMessages()
  const next = renameDraft.value.trim()
  if (!isSecretHandleSlug(next)) {
    error.value = t('settings.secretHandles.slugInvalid')
    return
  }
  saving.value = true
  try {
    const renamed = await renameSecretHandle(current, next)
    cancelRename()
    await load()
    successMessage.value = t('settings.secretHandles.renamedSuccess', { handle: renamed.handle })
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const slug = deleteTarget.value
  if (!slug) return
  clearMessages()
  saving.value = true
  try {
    await deleteSecretHandle(slug)
    deleteTarget.value = null
    await load()
    successMessage.value = t('settings.secretHandles.deletedSuccess')
  } catch (err) {
    deleteTarget.value = null
    error.value = (err as Error).message
  } finally {
    saving.value = false
  }
}

async function copyHandle(slug: string): Promise<void> {
  clearMessages()
  const ok = await writeClipboardText(handleOf(slug))
  if (ok) successMessage.value = t('settings.secretHandles.copied')
  else error.value = t('settings.secretHandles.copyFailed')
}

onMounted(load)

defineExpose({ load })
</script>
