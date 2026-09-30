<template>
  <section class="flex flex-col gap-4" aria-labelledby="voice-note-heading">
    <div>
      <h3 id="voice-note-heading" class="text-base font-semibold tracking-tight text-foreground">
        {{ $t('settings.voiceNote.title') }}
      </h3>
      <p class="mt-1 text-xs text-muted-foreground">
        {{ $t('settings.voiceNote.subtitle') }}
      </p>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="flex flex-col gap-3">
      <Skeleton class="h-4 w-40" />
      <Skeleton class="h-10 w-full" />
      <Skeleton class="h-10 w-full" />
    </div>

    <!-- Catalog failed: nothing can be chosen without it, so offer a retry -->
    <Alert v-else-if="loadError" variant="destructive">
      <AlertDescription class="flex flex-wrap items-center justify-between gap-2">
        <span>{{ loadError }}</span>
        <Button variant="outline" size="sm" @click="emit('retry')">{{ $t('common.retry') }}</Button>
      </AlertDescription>
    </Alert>

    <template v-else-if="catalog">
      <!-- Backend validation error for this block, inline where it happened -->
      <Alert v-if="saveError" variant="destructive">
        <AlertDescription>
          <span data-testid="voice-note-save-error" role="alert">{{ saveError }}</span>
        </AlertDescription>
      </Alert>
      <p v-else-if="saved" class="text-xs text-success" role="status" data-testid="voice-note-saved">
        {{ $t('settings.voiceNote.saved') }}
      </p>

      <!-- Effective route: what a voice note will actually use -->
      <dl
        data-testid="voice-note-effective"
        class="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-3 py-3 text-xs sm:grid-cols-2"
      >
        <div class="sm:col-span-2 mb-1 font-medium text-foreground">
          {{ $t('settings.voiceNote.effectiveTitle') }}
        </div>
        <div v-for="row in effectiveRows" :key="row.label" class="flex min-w-0 justify-between gap-2">
          <dt class="text-muted-foreground">{{ row.label }}</dt>
          <dd class="min-w-0 truncate font-mono text-foreground" :title="row.value">{{ row.value }}</dd>
        </div>
      </dl>

      <!-- Provider -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-provider">{{ $t('settings.voiceNote.provider') }}</Label>
          <Button
            v-if="!inherits('provider')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-provider"
            @click="reset('provider')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <select
          id="voice-note-provider"
          :value="draft.provider"
          :class="selectClass"
          @change="setField('provider', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ inheritOption(catalog.provider) }}</option>
          <option v-for="provider in catalog.providers" :key="provider" :value="provider">
            {{ provider }}
          </option>
        </select>
        <p class="text-xs text-muted-foreground">
          {{ inherits('provider') ? inheritedHint(catalog.provider) : $t('settings.voiceNote.providerHint') }}
        </p>
      </div>

      <!-- Provider account (credentials; never a key in this UI) -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-provider-id">{{ $t('settings.voiceNote.account') }}</Label>
          <Button
            v-if="!inherits('providerId')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-providerId"
            @click="reset('providerId')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <select
          id="voice-note-provider-id"
          :value="draft.providerId"
          :class="selectClass"
          @change="setField('providerId', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ inheritOption(catalog.providerId || $t('settings.voiceNote.none')) }}</option>
          <option v-for="account in accountOptions" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select>
        <p class="text-xs text-muted-foreground">
          {{ accountOptions.length === 0 ? $t('settings.voiceNote.accountEmpty') : $t('settings.voiceNote.accountHint') }}
        </p>
      </div>

      <!-- Model -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-model">{{ $t('settings.voiceNote.model') }}</Label>
          <Button
            v-if="!inherits('model')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-model"
            @click="reset('model')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <select
          v-if="modelOptions.length > 0"
          id="voice-note-model"
          :value="draft.model"
          :class="selectClass"
          @change="setField('model', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ inheritOption(catalog.model || $t('settings.voiceNote.none')) }}</option>
          <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
        </select>
        <Input
          v-else
          id="voice-note-model"
          :model-value="draft.model"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="inheritOption(catalog.model || $t('settings.voiceNote.none'))"
          @update:model-value="setField('model', String($event))"
        />
        <p class="text-xs text-muted-foreground">
          {{ inherits('model') ? inheritedHint(catalog.model || $t('settings.voiceNote.none')) : $t('settings.voiceNote.modelHint') }}
        </p>
      </div>

      <!-- Voice -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-voice">{{ $t('settings.voiceNote.voice') }}</Label>
          <Button
            v-if="!inherits('voice')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-voice"
            @click="reset('voice')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <select
          v-if="voiceOptions.length > 0"
          id="voice-note-voice"
          :value="draft.voice"
          :class="selectClass"
          @change="setField('voice', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ inheritOption(catalog.voice || $t('settings.voiceNote.none')) }}</option>
          <option v-for="voice in voiceOptions" :key="voice" :value="voice">{{ voice }}</option>
        </select>
        <Input
          v-else
          id="voice-note-voice"
          :model-value="draft.voice"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="inheritOption(catalog.voice || $t('settings.voiceNote.none'))"
          @update:model-value="setField('voice', String($event))"
        />
        <p class="text-xs text-muted-foreground">
          {{ inherits('voice') ? inheritedHint(catalog.voice || $t('settings.voiceNote.none')) : $t('settings.voiceNote.voiceHint') }}
        </p>
      </div>

      <!-- Style / delivery hint -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-style">{{ $t('settings.voiceNote.style') }}</Label>
          <Button
            v-if="!inherits('style')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-style"
            @click="reset('style')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <Input
          id="voice-note-style"
          :model-value="draft.style ?? ''"
          type="text"
          autocomplete="off"
          :placeholder="inheritOption(catalog.style || $t('settings.voiceNote.none'))"
          @update:model-value="setField('style', String($event))"
        />
        <p class="text-xs text-muted-foreground">
          {{ inherits('style') ? inheritedHint(catalog.style || $t('settings.voiceNote.none')) : $t('settings.voiceNote.styleHint') }}
        </p>
      </div>

      <!-- Character cap -->
      <div class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <Label for="voice-note-max-chars">{{ $t('settings.voiceNote.maxChars') }}</Label>
          <Button
            v-if="!inherits('maxChars')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-maxChars"
            @click="reset('maxChars')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
        <Input
          id="voice-note-max-chars"
          :model-value="draft.maxChars"
          type="number"
          inputmode="numeric"
          :min="maxCharsRange.min"
          :max="maxCharsRange.max"
          step="1"
          :placeholder="String(catalog.maxChars)"
          :aria-invalid="maxCharsError ? 'true' : undefined"
          @update:model-value="setField('maxChars', String($event))"
        />
        <p v-if="maxCharsError" class="text-xs text-destructive" role="alert" data-testid="voice-note-max-chars-error">
          {{ $t('settings.voiceNote.maxCharsRange', { min: maxCharsRange.min, max: maxCharsRange.max }) }}
        </p>
        <p v-else class="text-xs text-muted-foreground">
          {{ inherits('maxChars') ? inheritedHint(String(catalog.maxChars)) : $t('settings.voiceNote.maxCharsHint') }}
        </p>
      </div>

      <!-- Rewrite for the ear -->
      <div class="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-3">
        <div class="flex items-center justify-between gap-3">
          <Label for="voice-note-rewrite" class="cursor-pointer">{{ $t('settings.voiceNote.rewrite') }}</Label>
          <Switch
            id="voice-note-rewrite"
            :checked="draft.rewrite ?? catalog.rewrite"
            @update:checked="setField('rewrite', $event)"
          />
        </div>
        <p class="text-xs text-muted-foreground">{{ $t('settings.voiceNote.rewriteHint') }}</p>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            {{ inherits('rewrite')
              ? inheritedHint(catalog.rewrite ? $t('settings.voiceNote.on') : $t('settings.voiceNote.off'))
              : $t('settings.voiceNote.overridden') }}
          </p>
          <Button
            v-if="!inherits('rewrite')"
            variant="ghost"
            size="sm"
            data-testid="voice-note-reset-rewrite"
            @click="reset('rewrite')"
          >
            {{ $t('settings.voiceNote.reset') }}
          </Button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * "Voice messages" — the optional `tts.voiceNote` route.
 *
 * Every control has three states: inherited from the read-aloud settings
 * (nothing is written), overridden, and reset back to inherited (the key is
 * removed, NOT filled with the value that was inherited). The panel is pure
 * presentation over a draft object; the owning workspace saves it with the
 * rest of the settings and hands the backend's validation error back in
 * `saveError`.
 */
import { computed } from 'vue'
import { VOICE_NOTE_MAX_CHARS_RANGE } from '@axiom/core/contracts'
import Alert from '~/components/ui/Alert.vue'
import AlertDescription from '~/components/ui/AlertDescription.vue'
import Button from '~/components/ui/Button.vue'
import Input from '~/components/ui/Input.vue'
import Label from '~/components/ui/Label.vue'
import Skeleton from '~/components/ui/Skeleton.vue'
import Switch from '~/components/ui/Switch.vue'
import {
  resetVoiceNoteField,
  voiceNoteInheritsField,
  voiceNoteMaxCharsError,
  type TtsCatalogAccount,
  type VoiceNoteCatalogView,
  type VoiceNoteDraft,
  type VoiceNoteDraftField,
} from '../voiceNoteForm'

const props = defineProps<{
  /** Effective route + catalogs, from `GET /api/tts/catalog`. */
  catalog: (VoiceNoteCatalogView & { providers: readonly string[] }) | null
  /** Provider accounts that can back a TTS provider (id/name/type only). */
  accounts: readonly TtsCatalogAccount[]
  /** The sparse override the user is editing. */
  draft: VoiceNoteDraft
  loading?: boolean
  /** Catalog load failure — the panel offers a retry. */
  loadError?: string
  /** Validation/save error from the backend for this block. */
  saveError?: string
  /** Last save succeeded. */
  saved?: boolean
}>()

const emit = defineEmits<{
  'update:draft': [value: VoiceNoteDraft]
  retry: []
}>()

const { t } = useI18n()

const maxCharsRange = VOICE_NOTE_MAX_CHARS_RANGE

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground '
  + 'focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50'

function inherits(field: VoiceNoteDraftField): boolean {
  return voiceNoteInheritsField(props.draft, field)
}

function inheritOption(value: string): string {
  return t('settings.voiceNote.inheritOption', { value })
}

function inheritedHint(value: string): string {
  return t('settings.voiceNote.inherited', { value })
}

function setField(field: VoiceNoteDraftField, value: string | boolean): void {
  const next: VoiceNoteDraft = { ...props.draft }
  if (field === 'rewrite') next.rewrite = Boolean(value)
  else if (field === 'style') next.style = String(value)
  else if (field === 'maxChars') next.maxChars = String(value)
  else if (field === 'provider') {
    next.provider = String(value)
    // An account of the old provider would be rejected by the backend.
    const account = props.accounts.find(a => a.id === next.providerId)
    if (next.provider && account && account.ttsProvider !== next.provider) next.providerId = ''
  }
  else next[field] = String(value)
  emit('update:draft', next)
}

function reset(field: VoiceNoteDraftField): void {
  emit('update:draft', resetVoiceNoteField(props.draft, field))
}

const maxCharsError = computed(() => voiceNoteMaxCharsError(props.draft) !== null)

/** Accounts whose key can serve the effective provider. */
const accountOptions = computed(() => {
  const provider = props.draft.provider || props.catalog?.provider
  return props.accounts.filter(account => account.ttsProvider === provider)
})

const modelOptions = computed(() => {
  const list = [...(props.catalog?.models ?? [])]
  const current = props.draft.model
  if (current && !list.includes(current)) list.unshift(current)
  return list
})

const voiceOptions = computed(() => {
  const list = [...(props.catalog?.voices ?? [])]
  const current = props.draft.voice
  if (current && !list.includes(current)) list.unshift(current)
  return list
})

/** The resolved route, so the user reads what will really be spoken. */
const effectiveRows = computed(() => {
  const catalog = props.catalog
  if (!catalog) return []
  const mark = (field: VoiceNoteDraftField, value: string) =>
    catalog.inherited.includes(field) ? t('settings.voiceNote.effectiveInherited', { value }) : value
  return [
    { label: t('settings.voiceNote.provider'), value: mark('provider', catalog.provider) },
    { label: t('settings.voiceNote.account'), value: mark('providerId', catalog.providerId || t('settings.voiceNote.none')) },
    { label: t('settings.voiceNote.model'), value: mark('model', catalog.model || t('settings.voiceNote.none')) },
    { label: t('settings.voiceNote.voice'), value: mark('voice', catalog.voice || t('settings.voiceNote.none')) },
    { label: t('settings.voiceNote.style'), value: mark('style', catalog.style || t('settings.voiceNote.none')) },
    { label: t('settings.voiceNote.maxChars'), value: mark('maxChars', String(catalog.maxChars)) },
    {
      label: t('settings.voiceNote.rewrite'),
      value: mark('rewrite', catalog.rewrite ? t('settings.voiceNote.on') : t('settings.voiceNote.off')),
    },
    { label: t('settings.voiceNote.format'), value: catalog.format },
  ]
})
</script>
