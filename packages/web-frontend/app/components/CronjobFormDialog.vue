<template>
  <Dialog :open="open" @update:open="$emit('close')">
    <DialogContent
      class="flex max-h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg flex-col overflow-hidden p-0 md:max-h-[85vh]"
    >
      <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="onSubmit">
        <DialogHeader class="oa-scrollbar mb-0 shrink-0 overflow-y-auto px-6 pb-4 pt-6 [scrollbar-gutter:stable]">
          <DialogTitle>{{ mode === 'create' ? $t('cronjobs.createTitle') : $t('cronjobs.editTitle') }}</DialogTitle>
          <DialogDescription>{{ mode === 'create' ? $t('cronjobs.createDescription') : $t('cronjobs.editDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="oa-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6 [scrollbar-gutter:stable]">
          <!-- Name -->
          <div class="space-y-2">
            <Label for="cronjob-name">{{ $t('cronjobs.form.name') }}</Label>
            <Input
              id="cronjob-name"
              v-model="form.name"
              :placeholder="$t('cronjobs.form.namePlaceholder')"
              required
            />
          </div>

          <!-- Prompt -->
          <div class="space-y-2">
            <Label for="cronjob-prompt">{{ $t('cronjobs.form.prompt') }}</Label>
            <textarea
              id="cronjob-prompt"
              v-model="form.prompt"
              rows="4"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              :placeholder="$t('cronjobs.form.promptPlaceholder')"
              required
            />
          </div>

          <!-- Schedule -->
          <div class="space-y-2">
            <Label for="cronjob-schedule">{{ $t('cronjobs.form.schedule') }}</Label>
            <Input
              id="cronjob-schedule"
              v-model="form.schedule"
              placeholder="0 9 * * *"
              required
            />
            <p class="text-xs text-muted-foreground">
              {{ $t('cronjobs.form.scheduleHelp') }}
            </p>
          </div>

          <!-- Action Type -->
          <div class="space-y-2">
            <Label for="cronjob-action-type">{{ $t('cronjobs.form.actionType') }}</Label>
            <Select v-model="form.actionType">
              <SelectTrigger id="cronjob-action-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="task">{{ $t('cronjobs.form.actionTypeTask') }}</SelectItem>
                <SelectItem value="injection">{{ $t('cronjobs.form.actionTypeInjection') }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              {{ form.actionType === 'injection' ? $t('cronjobs.form.actionTypeInjectionHelp') : $t('cronjobs.form.actionTypeTaskHelp') }}
            </p>
          </div>

          <!-- Provider & Model (only for task type) -->
          <div v-if="form.actionType !== 'injection'" class="space-y-2">
            <Label for="cronjob-provider">{{ $t('cronjobs.form.provider') }}</Label>
            <Select v-model="form.provider">
              <SelectTrigger id="cronjob-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{{ $t('cronjobs.form.defaultProvider') }}</SelectItem>
                <SelectItem
                  v-for="opt in providerModelOptions"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- Advanced Section (Collapsible) — only for task type -->
          <div v-if="form.actionType !== 'injection'" class="border border-border rounded-md">
            <button
              type="button"
              class="flex w-full items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors"
              @click="advancedOpen = !advancedOpen"
            >
              <span class="flex items-center gap-2">
                {{ $t('cronjobs.form.advanced') }}
                <Badge v-if="hasOverrides" variant="outline" class="text-xs">
                  {{ $t('cronjobs.form.customized') }}
                </Badge>
              </span>
              <AppIcon
                name="chevronDown"
                size="sm"
                class="text-muted-foreground transition-transform"
                :class="{ 'rotate-180': advancedOpen }"
              />
            </button>

            <div v-if="advancedOpen" class="border-t border-border px-4 py-4 space-y-5">
              <!-- Tool Overrides -->
              <div class="space-y-3">
                <Label>{{ $t('cronjobs.form.toolOverrides') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('cronjobs.form.toolOverridesHelp') }}
                </p>
                <div v-if="metaLoading" class="text-xs text-muted-foreground italic">
                  {{ $t('common.loading') }}
                </div>
                <div v-else-if="availableTools.length > 0" class="space-y-2">
                  <div
                    v-for="tool in availableTools"
                    :key="tool"
                    class="flex items-center justify-between py-1"
                  >
                    <span class="text-sm font-mono">{{ tool }}</span>
                    <Switch
                      :checked="!disabledTools.includes(tool)"
                      @update:checked="(val: boolean) => toggleTool(tool, val)"
                    />
                  </div>
                  <!--
                    Stale disabled entries: tools that were disabled when this cronjob was
                    saved but no longer exist. Keep them visible so the user can clean them
                    up instead of silently carrying dead overrides forward.
                  -->
                  <div
                    v-for="tool in staleDisabledTools"
                    :key="`stale-${tool}`"
                    class="flex items-center justify-between py-1 opacity-60"
                  >
                    <span class="text-sm font-mono line-through">{{ tool }}</span>
                    <Switch
                      :checked="false"
                      @update:checked="(val: boolean) => toggleTool(tool, val)"
                    />
                  </div>
                </div>
                <p v-else class="text-xs text-muted-foreground italic">
                  {{ $t('cronjobs.form.noTools') }}
                </p>
              </div>

              <Separator />

              <!-- Skill Overrides -->
              <div class="space-y-3">
                <Label>{{ $t('cronjobs.form.skillOverrides') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('cronjobs.form.skillOverridesHelp') }}
                </p>
                <div v-if="metaLoading" class="text-xs text-muted-foreground italic">
                  {{ $t('common.loading') }}
                </div>
                <div v-else-if="availableSkillEntries.length > 0" class="space-y-2">
                  <div
                    v-for="skill in availableSkillEntries"
                    :key="skill.id"
                    class="flex items-center justify-between py-1"
                  >
                    <span class="text-sm">
                      <span v-if="skill.emoji" class="mr-1">{{ skill.emoji }}</span>{{ skill.name }}
                      <span class="ml-1 text-xs font-mono text-muted-foreground">({{ skill.id }})</span>
                    </span>
                    <Switch
                      :checked="!disabledSkills.includes(skill.id)"
                      @update:checked="(val: boolean) => toggleSkill(skill.id, val)"
                    />
                  </div>
                  <div
                    v-for="skill in staleDisabledSkills"
                    :key="`stale-skill-${skill}`"
                    class="flex items-center justify-between py-1 opacity-60"
                  >
                    <span class="text-sm line-through">{{ skill }}</span>
                    <Switch
                      :checked="false"
                      @update:checked="(val: boolean) => toggleSkill(skill, val)"
                    />
                  </div>
                </div>
                <p v-else class="text-xs text-muted-foreground italic">
                  {{ $t('cronjobs.form.noSkills') }}
                </p>
              </div>

              <Separator />

              <!-- Attached Skills — both installed and agent skills, their SKILL.md is injected into the task prompt -->
              <div class="space-y-3">
                <Label>{{ $t('cronjobs.form.attachedSkills') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('cronjobs.form.attachedSkillsHelp') }}
                </p>
                <div v-if="metaLoading" class="text-xs text-muted-foreground italic">
                  {{ $t('common.loading') }}
                </div>
                <div v-else-if="attachableSkillEntries.length > 0" class="space-y-2">
                  <div
                    v-for="skill in attachableSkillEntries"
                    :key="`attached-${skill.id}`"
                    class="flex items-center justify-between py-1"
                  >
                    <span class="text-sm">
                      <span v-if="skill.emoji" class="mr-1">{{ skill.emoji }}</span>
                      <span class="font-mono">{{ skill.id }}</span>
                      <span
                        class="ml-1 text-xs uppercase tracking-wide"
                        :class="skill.kind === 'agent' ? 'text-primary' : 'text-muted-foreground'"
                      >
                        {{ skill.kind === 'agent' ? $t('cronjobs.form.skillKindAgent') : $t('cronjobs.form.skillKindInstalled') }}
                      </span>
                    </span>
                    <Switch
                      :checked="attachedSkills.includes(skill.id)"
                      @update:checked="(val: boolean) => toggleAttachedSkill(skill.id, val)"
                    />
                  </div>
                  <div v-if="attachedSkills.length > 0" class="flex flex-wrap gap-1.5 pt-1">
                    <Badge
                      v-for="skill in attachedSkills"
                      :key="`attached-selected-${skill}`"
                      variant="secondary"
                      class="text-xs font-normal"
                    >
                      📎 {{ skill }}
                    </Badge>
                  </div>
                </div>
                <p v-else class="text-xs text-muted-foreground italic">
                  {{ $t('cronjobs.form.noAttachableSkills') }}
                </p>
              </div>

              <Separator />

              <!-- System Prompt Override -->
              <div class="space-y-2">
                <Label for="cronjob-system-prompt">{{ $t('cronjobs.form.systemPromptOverride') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('cronjobs.form.systemPromptOverrideHelp') }}
                </p>
                <textarea
                  id="cronjob-system-prompt"
                  v-model="form.systemPromptOverride"
                  rows="5"
                  class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 font-mono"
                  :placeholder="$t('cronjobs.form.systemPromptPlaceholder')"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter class="oa-scrollbar mt-0 shrink-0 overflow-y-auto border-t border-border px-6 py-4 [scrollbar-gutter:stable]">
          <Button type="button" variant="outline" @click="$emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            {{ loading ? $t('common.saving') : (mode === 'create' ? $t('common.create') : $t('common.save')) }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { Cronjob, CronjobMeta } from '~/composables/useCronjobs'
import { normalizeCronjobProviderValue } from '~/features/cronjobs/utils/providerValue'
import { buildProviderModelOptions } from '~/utils/providerModelOptions'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  cronjob?: Cronjob | null
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [form: {
    name: string
    prompt: string
    schedule: string
    actionType?: 'task' | 'injection'
    provider?: string
    toolsOverride?: string | null
    skillsOverride?: string | null
    systemPromptOverride?: string | null
    attachedSkills?: string[] | null
  }]
}>()

const { providers, fetchProviders } = useProviders()
const { fetchCronjobMeta } = useCronjobs()

const providerModelOptions = computed(() => buildProviderModelOptions(providers.value))

const advancedOpen = ref(false)

/**
 * Meta loaded from `/api/cronjobs/meta` on every open of the dialog.
 * We always fetch fresh so the lists reflect any tool/skill added or
 * removed since the dialog was last opened.
 */
const meta = ref<CronjobMeta>({ tools: [], installedSkills: [], agentSkills: [] })
const metaLoading = ref(false)

const availableTools = computed(() => meta.value.tools)

/** Installed skills (enabled only) — the candidates for per-cronjob overrides. */
const availableSkillEntries = computed(() =>
  meta.value.installedSkills
    .filter(s => s.enabled)
    .map(s => ({ id: s.id, name: s.name, emoji: s.emoji })),
)

/**
 * Union of attachable skills for the "Attached Skills" section:
 * both installed skills (id `owner/name`) and agent skills (bare name).
 * Backend resolves each id to its SKILL.md via `loadAttachedSkillContent`.
 */
const attachableSkillEntries = computed(() => {
  const installed = meta.value.installedSkills
    .filter(s => s.enabled)
    .map(s => ({ id: s.id, emoji: s.emoji, kind: 'installed' as const }))
  const agent = meta.value.agentSkills
    .map(s => ({ id: s.name, emoji: undefined as string | undefined, kind: 'agent' as const }))
  return [...agent, ...installed].sort((a, b) => a.id.localeCompare(b.id))
})

const form = reactive({
  name: '',
  prompt: '',
  schedule: '',
  actionType: 'task' as 'task' | 'injection',
  provider: '',
  systemPromptOverride: '',
})

const disabledTools = ref<string[]>([])
const disabledSkills = ref<string[]>([])
const attachedSkills = ref<string[]>([])

/**
 * Tools/skills that were disabled in this cronjob but no longer exist in the
 * current meta — surfaced in the UI so users can see and clean them up
 * instead of carrying silent dead overrides.
 */
const staleDisabledTools = computed(() =>
  disabledTools.value.filter(t => !meta.value.tools.includes(t)),
)
const staleDisabledSkills = computed(() => {
  const ids = new Set(meta.value.installedSkills.map(s => s.id))
  return disabledSkills.value.filter(s => !ids.has(s))
})

const hasOverrides = computed(() => [
  disabledTools.value.length,
  disabledSkills.value.length,
  attachedSkills.value.length,
  form.systemPromptOverride.trim().length,
].some(count => count > 0))

function toggleAttachedSkill(skill: string, enabled: boolean) {
  if (enabled) {
    if (!attachedSkills.value.includes(skill)) {
      attachedSkills.value = [...attachedSkills.value, skill]
    }
  } else {
    attachedSkills.value = attachedSkills.value.filter(s => s !== skill)
  }
}

async function loadMeta(): Promise<void> {
  metaLoading.value = true
  try {
    meta.value = await fetchCronjobMeta()
  } catch {
    // Fall back to empty lists on error — the form still works, just shows
    // no toggles. Errors are not fatal for save/cancel flows.
    meta.value = { tools: [], installedSkills: [], agentSkills: [] }
  } finally {
    metaLoading.value = false
  }
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function applyCronjob(cronjob: Cronjob) {
  form.name = cronjob.name
  form.prompt = cronjob.prompt
  form.schedule = cronjob.schedule
  form.actionType = cronjob.actionType ?? 'task'
  form.provider = normalizeCronjobProviderValue(cronjob.provider, providers.value)
  form.systemPromptOverride = cronjob.systemPromptOverride ?? ''
  disabledTools.value = parseStringArray(cronjob.toolsOverride)
  disabledSkills.value = parseStringArray(cronjob.skillsOverride)
  attachedSkills.value = [...(cronjob.attachedSkills ?? [])]
  advancedOpen.value = hasOverrides.value
}

function resetForm() {
  form.name = ''
  form.prompt = ''
  form.schedule = ''
  form.actionType = 'task'
  form.provider = ''
  form.systemPromptOverride = ''
  disabledTools.value = []
  disabledSkills.value = []
  attachedSkills.value = []
  advancedOpen.value = false
}

/**
 * Legacy "provider name" values can only be mapped to `providerId:modelId`
 * once providers are loaded, so re-normalize after the fetch. Skipped when the
 * dialog was closed or switched to another cronjob in the meantime.
 */
function syncProviderAfterFetch(cronjob: Cronjob | null) {
  if (!cronjob || !props.open || props.cronjob !== cronjob) return
  form.provider = normalizeCronjobProviderValue(cronjob.provider, providers.value)
}

const editingCronjob = computed(() => (props.mode === 'edit' && props.cronjob) || null)

async function initializeDialog() {
  const cronjob = editingCronjob.value
  if (cronjob) applyCronjob(cronjob)
  else resetForm()

  await Promise.all([fetchProviders(), loadMeta()])
  syncProviderAfterFetch(cronjob)
}

watch(() => props.open, (isOpen) => {
  if (isOpen) initializeDialog()
})

function toggleTool(tool: string, enabled: boolean) {
  if (enabled) {
    disabledTools.value = disabledTools.value.filter(t => t !== tool)
  } else {
    if (!disabledTools.value.includes(tool)) {
      disabledTools.value.push(tool)
    }
  }
}

function toggleSkill(skill: string, enabled: boolean) {
  if (enabled) {
    disabledSkills.value = disabledSkills.value.filter(s => s !== skill)
  } else {
    if (!disabledSkills.value.includes(skill)) {
      disabledSkills.value.push(skill)
    }
  }
}

function nonEmptyJson(values: string[]): string | null {
  return values.length > 0 ? JSON.stringify(values) : null
}

function taskOverrides() {
  return {
    provider: form.provider || undefined,
    toolsOverride: nonEmptyJson(disabledTools.value),
    skillsOverride: nonEmptyJson(disabledSkills.value),
    systemPromptOverride: form.systemPromptOverride.trim() || null,
    attachedSkills: attachedSkills.value.length > 0 ? [...attachedSkills.value] : null,
  }
}

const INJECTION_OVERRIDES = {
  provider: undefined,
  toolsOverride: null,
  skillsOverride: null,
  systemPromptOverride: null,
  attachedSkills: null,
}

function onSubmit() {
  emit('submit', {
    name: form.name,
    prompt: form.prompt,
    schedule: form.schedule,
    actionType: form.actionType,
    ...(form.actionType === 'injection' ? INJECTION_OVERRIDES : taskOverrides()),
  })
}
</script>
