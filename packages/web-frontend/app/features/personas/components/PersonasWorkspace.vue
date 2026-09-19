<!--
  Persona management (SPEC 13).

  Two surfaces: a list that shows what a persona IS (badge, colour, role in one
  sentence) rather than which files it happens to have, and an editor that
  offers fields first and the raw markdown second. Every state a user can land
  in is rendered explicitly — loading, error with a way out, empty with an
  explanation, and a visible confirmation after a write — because a form that
  silently does nothing is the failure mode of every settings screen.

  Removal follows SPEC 13.5: archive is the button, hard delete lives behind a
  preview that counts what would go with it.
-->
<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden bg-background">
    <!-- ══ List view ══ -->
    <template v-if="!editingId">
      <PageHeader :title="$t('personas.title')" :subtitle="$t('personas.subtitle')">
        <template #actions>
          <Button class="min-h-11" @click="openCreate">
            <AppIcon name="add" class="mr-1 h-4 w-4" />
            {{ $t('personas.createNew') }}
          </Button>
        </template>
      </PageHeader>

      <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto p-4 sm:p-6">
        <Alert v-if="!multiPersonaEnabled" variant="info" class="mb-4">
          <AlertDescription class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{{ $t('personas.multiPersonaDisabled') }}</span>
            <Button as-child variant="outline" size="sm" class="min-h-11 shrink-0 sm:ml-2">
              <NuxtLink to="/settings?tab=agent">{{ $t('personas.goToSettings') }}</NuxtLink>
            </Button>
          </AlertDescription>
        </Alert>

        <PersonaFeedback
          :error="error"
          :success="successMessage"
          :retry-label="$t('common.retry')"
          @retry="reload"
          @dismiss-error="error = null"
          @dismiss-success="successMessage = null"
        />

        <!-- Loading: skeletons in the shape of the cards that follow -->
        <div v-if="loading && personas.length === 0" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          <div v-for="n in 3" :key="n" class="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div class="flex items-center gap-3">
              <Skeleton class="h-10 w-10 shrink-0 rounded-full" />
              <Skeleton class="h-5 w-32" />
            </div>
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-2/3" />
            <Skeleton class="mt-2 h-11 w-full rounded-md" />
          </div>
        </div>

        <!-- Empty: say what a persona is, then offer the one action -->
        <div
          v-else-if="visiblePersonas.length === 0 && !loading"
          class="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center"
        >
          <AppIcon name="bot" size="xl" class="h-12 w-12 opacity-40" />
          <div class="max-w-md space-y-2">
            <h2 class="text-base font-semibold text-foreground">{{ $t('personas.emptyTitle') }}</h2>
            <p class="text-sm text-muted-foreground">{{ $t('personas.emptyBody') }}</p>
          </div>
          <Button class="min-h-11" @click="openCreate">
            <AppIcon name="add" class="mr-1 h-4 w-4" />
            {{ $t('personas.createFirst') }}
          </Button>
          <Button v-if="archivedPersonas.length > 0" variant="ghost" class="min-h-11" @click="showArchived = true">
            {{ $t('personas.showArchived', { count: archivedPersonas.length }) }}
          </Button>
        </div>

        <template v-else>
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <article
              v-for="persona in visiblePersonas"
              :key="persona.id"
              class="group flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
              :class="persona.archived ? 'opacity-70' : ''"
            >
              <div class="flex items-start gap-3">
                <span
                  class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg"
                  :style="avatarStyle(persona)"
                  aria-hidden="true"
                >{{ persona.badge || initial(persona) }}</span>

                <div class="min-w-0 flex-1">
                  <h3 class="truncate text-base font-semibold text-foreground">{{ persona.displayName }}</h3>
                  <p class="truncate font-mono text-xs text-muted-foreground">{{ persona.id }}</p>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-11 w-11 shrink-0"
                      :aria-label="$t('personas.actionsFor', { name: persona.displayName })"
                    >
                      <AppIcon name="moreVertical" class="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem @click="startEdit(persona.id)">
                      <AppIcon name="edit" class="h-4 w-4" />
                      {{ $t('personas.edit') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="!persona.isDefault" @click="handleMakeDefault(persona)">
                      <AppIcon name="check" class="h-4 w-4" />
                      {{ $t('personas.makeDefault') }}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator v-if="!persona.isDefault" />
                    <DropdownMenuItem v-if="!persona.archived && !persona.isDefault" @click="handleArchive(persona, true)">
                      <AppIcon name="archive" class="h-4 w-4" />
                      {{ $t('personas.archive') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="persona.archived" @click="handleArchive(persona, false)">
                      <AppIcon name="unarchive" class="h-4 w-4" />
                      {{ $t('personas.restore') }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="!persona.isDefault" destructive @click="startDelete(persona)">
                      <AppIcon name="trash" class="h-4 w-4" />
                      {{ $t('personas.deleteForever') }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <p class="mt-3 line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
                {{ persona.role || $t('personas.noRole') }}
              </p>

              <div class="mt-3 flex flex-wrap gap-1.5">
                <Badge v-if="persona.isDefault" variant="outline" class="text-xs">{{ $t('personas.defaultBadge') }}</Badge>
                <Badge v-if="persona.archived" variant="outline" class="text-xs">{{ $t('personas.archivedBadge') }}</Badge>
                <Badge v-if="persona.hasTelegramBinding" variant="success" class="text-xs">
                  <AppIcon name="send" size="sm" class="mr-1" />
                  {{ $t('personas.telegramBound') }}
                </Badge>
              </div>

              <div class="mt-4 border-t border-border pt-3">
                <Button variant="outline" class="min-h-11 w-full" @click="startEdit(persona.id)">
                  <AppIcon name="edit" size="sm" class="mr-1" />
                  {{ $t('personas.edit') }}
                </Button>
              </div>
            </article>
          </div>

          <div v-if="archivedPersonas.length > 0" class="mt-6 flex justify-center">
            <Button variant="ghost" class="min-h-11" @click="showArchived = !showArchived">
              {{ showArchived ? $t('personas.hideArchived') : $t('personas.showArchived', { count: archivedPersonas.length }) }}
            </Button>
          </div>
        </template>
      </div>
    </template>

    <!-- ══ Editor ══ -->
    <template v-else>
      <PageHeader :title="editingHeading" :subtitle="$t('personas.editDescription')">
        <template #actions>
          <Button variant="outline" class="min-h-11" @click="cancelEdit">{{ $t('personas.back') }}</Button>
          <Button class="min-h-11" :disabled="saving || editLoading" @click="handleSave">
            <span
              v-if="saving"
              class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
              aria-hidden="true"
            />
            {{ $t('common.save') }}
          </Button>
        </template>
      </PageHeader>

      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
          <PersonaFeedback
            :error="error"
            :success="successMessage"
            :retry-label="$t('common.retry')"
            @retry="startEdit(editingId!)"
            @dismiss-error="error = null"
            @dismiss-success="successMessage = null"
          />

          <div v-if="editLoading" class="flex flex-col gap-4" aria-busy="true">
            <Skeleton class="h-11 w-full rounded-md" />
            <Skeleton class="h-11 w-full rounded-md" />
            <Skeleton class="h-24 w-full rounded-md" />
            <Skeleton class="h-24 w-full rounded-md" />
          </div>

          <Tabs v-else-if="form" v-model="editorTab" class="w-full">
            <TabsList class="mb-4 grid w-full grid-cols-2">
              <TabsTrigger value="fields" class="min-h-11">{{ $t('personas.tabFields') }}</TabsTrigger>
              <TabsTrigger value="advanced" class="min-h-11">{{ $t('personas.tabAdvanced') }}</TabsTrigger>
            </TabsList>

            <!-- ── Structured fields ── -->
            <TabsContent value="fields" class="flex flex-col gap-5">
              <div class="flex flex-col gap-2">
                <Label for="persona-name">{{ $t('personas.fieldName') }}</Label>
                <Input id="persona-name" v-model="form.name" class="min-h-11" :placeholder="editingId" />
                <p class="text-xs text-muted-foreground">{{ $t('personas.fieldNameHint', { id: editingId }) }}</p>
              </div>

              <div class="grid gap-4 sm:grid-cols-2">
                <div class="flex flex-col gap-2">
                  <Label for="persona-badge">{{ $t('personas.fieldBadge') }}</Label>
                  <Input id="persona-badge" v-model="form.badge" class="min-h-11" maxlength="8" placeholder="🧭" />
                  <p class="text-xs text-muted-foreground">{{ $t('personas.fieldBadgeHint') }}</p>
                </div>

                <div class="flex flex-col gap-2">
                  <Label for="persona-color">{{ $t('personas.fieldColor') }}</Label>
                  <div class="flex items-center gap-2">
                    <input
                      id="persona-color"
                      v-model="colorPicker"
                      type="color"
                      class="h-11 w-14 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
                      :aria-label="$t('personas.fieldColor')"
                    >
                    <Input
                      v-model="form.color"
                      class="min-h-11 font-mono"
                      placeholder="#4f8ef7"
                      :aria-label="$t('personas.fieldColorHex')"
                    />
                  </div>
                  <p v-if="colorInvalid" class="text-xs text-destructive">{{ $t('personas.fieldColorInvalid') }}</p>
                  <p v-else class="text-xs text-muted-foreground">{{ $t('personas.fieldColorHint') }}</p>
                </div>
              </div>

              <div class="flex flex-col gap-2">
                <Label for="persona-role">{{ $t('personas.fieldRole') }}</Label>
                <Input id="persona-role" v-model="form.role" class="min-h-11" :placeholder="$t('personas.fieldRolePlaceholder')" />
                <p class="text-xs text-muted-foreground">{{ $t('personas.fieldRoleHint') }}</p>
              </div>

              <div class="flex flex-col gap-2">
                <Label for="persona-tone">{{ $t('personas.fieldTone') }}</Label>
                <Input id="persona-tone" v-model="form.tone" class="min-h-11" :placeholder="$t('personas.fieldTonePlaceholder')" />
                <div class="flex flex-wrap gap-2">
                  <button
                    v-for="preset in tonePresets"
                    :key="preset"
                    type="button"
                    class="min-h-11 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="form.tone = preset"
                  >{{ preset }}</button>
                </div>
              </div>

              <PersonaChipList
                id="persona-subjects"
                v-model="form.subjects"
                :label="$t('personas.fieldSubjects')"
                :hint="$t('personas.fieldSubjectsHint')"
                :placeholder="$t('personas.fieldSubjectsPlaceholder')"
                :add-label="$t('personas.add')"
                :remove-label="$t('personas.remove')"
              />

              <PersonaChipList
                id="persona-tools"
                v-model="form.tools"
                :label="$t('personas.fieldTools')"
                :hint="$t('personas.fieldToolsHint')"
                :placeholder="$t('personas.fieldToolsPlaceholder')"
                :add-label="$t('personas.add')"
                :remove-label="$t('personas.remove')"
              />

              <div class="flex flex-col gap-2">
                <Label for="persona-model">{{ $t('personas.fieldModel') }}</Label>
                <Input id="persona-model" v-model="form.model" class="min-h-11 font-mono" :placeholder="$t('personas.fieldModelPlaceholder')" />
                <p class="text-xs text-muted-foreground">{{ $t('personas.fieldModelHint') }}</p>
              </div>
            </TabsContent>

            <!-- ── Raw markdown ── -->
            <TabsContent value="advanced" class="flex flex-col gap-6">
              <Alert variant="warning">
                <AlertDescription>{{ $t('personas.advancedWarning') }}</AlertDescription>
              </Alert>

              <div v-for="spec in fileSpecs" :key="spec.key" class="flex flex-col gap-2">
                <div class="flex flex-wrap items-center gap-2">
                  <Label :for="`file-${spec.key}`" class="font-semibold">{{ $t(spec.labelKey) }}</Label>
                  <span class="font-mono text-xs text-muted-foreground">{{ spec.fileName }}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-auto min-h-11"
                    @click="copyFile(spec.key)"
                  >{{ copiedKey === spec.key ? $t('personas.copied') : $t('personas.copy') }}</Button>
                </div>
                <p class="text-xs text-muted-foreground">{{ $t(spec.hintKey) }}</p>
                <textarea
                  :id="`file-${spec.key}`"
                  v-model="rawFiles[spec.key]"
                  class="min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  :rows="spec.rows"
                  spellcheck="false"
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </template>

    <!-- ══ Create dialog ══ -->
    <Dialog :open="showCreateDialog" @update:open="(v: boolean) => { if (!v) showCreateDialog = false }">
      <DialogContent class="max-h-[90vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ $t('personas.createTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('personas.createDescription') }}</DialogDescription>
        </DialogHeader>

        <form class="flex flex-col gap-4 py-2" @submit.prevent="handleCreate">
          <div class="flex flex-col gap-2">
            <Label for="new-persona-name">{{ $t('personas.fieldName') }}</Label>
            <Input
              id="new-persona-name"
              v-model="createForm.name"
              class="min-h-11"
              :placeholder="$t('personas.createNamePlaceholder')"
              autocomplete="off"
            />
          </div>

          <div class="flex flex-col gap-2">
            <Label for="new-persona-id">{{ $t('personas.idLabel') }}</Label>
            <Input
              id="new-persona-id"
              v-model="createForm.id"
              class="min-h-11 font-mono"
              :placeholder="$t('personas.idPlaceholder')"
              autocomplete="off"
              :aria-describedby="createError ? 'new-persona-id-error' : 'new-persona-id-hint'"
              :aria-invalid="!!createError"
            />
            <p id="new-persona-id-hint" class="text-xs text-muted-foreground">{{ $t('personas.idHint') }}</p>
            <p v-if="createError" id="new-persona-id-error" class="text-xs text-destructive">{{ createError }}</p>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <div class="flex flex-col gap-2">
              <Label for="new-persona-badge">{{ $t('personas.fieldBadge') }}</Label>
              <Input id="new-persona-badge" v-model="createForm.badge" class="min-h-11" maxlength="8" placeholder="🧭" />
            </div>
            <div class="flex flex-col gap-2">
              <Label for="new-persona-color">{{ $t('personas.fieldColor') }}</Label>
              <input
                id="new-persona-color"
                v-model="createForm.color"
                type="color"
                class="h-11 w-full cursor-pointer rounded-md border border-input bg-background p-1"
              >
            </div>
          </div>

          <div class="flex flex-col gap-2">
            <Label for="new-persona-role">{{ $t('personas.fieldRole') }}</Label>
            <Input id="new-persona-role" v-model="createForm.role" class="min-h-11" :placeholder="$t('personas.fieldRolePlaceholder')" />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" class="min-h-11" @click="showCreateDialog = false">
              {{ $t('common.cancel') }}
            </Button>
            <Button type="submit" class="min-h-11" :disabled="creating || !createForm.id.trim()">
              <span
                v-if="creating"
                class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                aria-hidden="true"
              />
              {{ $t('personas.createNew') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- ══ Hard delete with cascade preview (SPEC 13.5) ══ -->
    <Dialog :open="!!deleteTarget" @update:open="(v: boolean) => { if (!v) deleteTarget = null }">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('personas.deleteTitle', { name: deleteTarget?.displayName ?? '' }) }}</DialogTitle>
          <DialogDescription>{{ $t('personas.deleteDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="py-2">
          <div v-if="previewLoading" class="flex flex-col gap-2" aria-busy="true">
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-2/3" />
          </div>
          <ul v-else-if="deletePreview" class="space-y-1 text-sm text-muted-foreground">
            <li v-for="row in previewRows" :key="row.key" class="flex justify-between gap-4">
              <span>{{ $t(`personas.cascade.${row.key}`) }}</span>
              <span class="font-mono text-foreground">{{ row.value }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted-foreground">{{ $t('personas.previewUnavailable') }}</p>

          <p class="mt-4 text-sm text-foreground">{{ $t('personas.deleteKeepsHistory') }}</p>

          <div class="mt-4 flex flex-col gap-2">
            <Label for="delete-confirm-id">{{ $t('personas.deleteTypeId', { id: deleteTarget?.id ?? '' }) }}</Label>
            <Input id="delete-confirm-id" v-model="deleteConfirmation" class="min-h-11 font-mono" autocomplete="off" />
          </div>
        </div>

        <DialogFooter class="flex-col gap-2 sm:flex-row">
          <Button variant="outline" class="min-h-11" @click="deleteTarget = null">{{ $t('common.cancel') }}</Button>
          <Button
            variant="outline"
            class="min-h-11"
            @click="deleteTarget && handleArchive(deleteTarget, true, true)"
          >
            <AppIcon name="archive" class="mr-1 h-4 w-4" />
            {{ $t('personas.archiveInstead') }}
          </Button>
          <Button
            variant="destructive"
            class="min-h-11"
            :disabled="deleting || deleteConfirmation.trim() !== deleteTarget?.id"
            @click="handleDelete"
          >
            <span
              v-if="deleting"
              class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-destructive-foreground/30 border-t-destructive-foreground"
              aria-hidden="true"
            />
            {{ $t('personas.deleteForever') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import PersonaChipList from './PersonaChipList.vue'
import PersonaFeedback from './PersonaFeedback.vue'
import type { PersonaFields, PersonaFiles, PersonaListItem, PersonaDeletePreview } from '~/api/personas'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const { t } = useI18n()

const {
  personas,
  loading,
  error,
  fetchPersonas,
  getPersona,
  updatePersona,
  createPersona,
  archivePersona,
  makeDefault,
  getDeletePreview,
  deletePersona,
} = usePersonas()

const { settings, fetchSettings } = useSettings()
const multiPersonaEnabled = computed(() => settings.value?.multiPersona?.enabled ?? false)

const successMessage = ref<string | null>(null)
const showArchived = ref(false)

const activePersonas = computed(() => personas.value.filter(p => !p.archived))
const archivedPersonas = computed(() => personas.value.filter(p => p.archived))
const visiblePersonas = computed(() => (showArchived.value ? personas.value : activePersonas.value))

/* ── Editor state ── */

const editingId = ref<string | null>(null)
const editLoading = ref(false)
const saving = ref(false)
const editorTab = ref('fields')
const copiedKey = ref<string | null>(null)

/** The editable projection: strings, never null, so v-model stays simple. */
interface EditorForm {
  name: string
  badge: string
  color: string
  role: string
  tone: string
  model: string
  subjects: string[]
  tools: string[]
}

const form = ref<EditorForm | null>(null)
const rawFiles = ref<PersonaFiles>({ identity: '', soul: '', user: '', tools: '', agents: '', heartbeat: '' })
/** What the server last returned, to send only what actually changed. */
const loadedFiles = ref<PersonaFiles | null>(null)

const editingHeading = computed(() =>
  t('personas.editTitle', { id: form.value?.name?.trim() || editingId.value || '' }),
)

const tonePresets = computed(() => [
  t('personas.tonePreset1'),
  t('personas.tonePreset2'),
  t('personas.tonePreset3'),
])

const colorPicker = computed({
  get: () => (/^#[0-9a-fA-F]{6}$/.test(form.value?.color ?? '') ? (form.value as EditorForm).color : '#7c7c7c'),
  set: (value: string) => { if (form.value) form.value.color = value.toLowerCase() },
})

const colorInvalid = computed(() => {
  const value = form.value?.color?.trim() ?? ''
  return value.length > 0 && !/^#[0-9a-fA-F]{6}$/.test(value)
})

const fileSpecs = [
  { key: 'identity' as const, fileName: 'IDENTITY.md', labelKey: 'personas.fileIdentity', hintKey: 'personas.fileIdentityHint', rows: 6 },
  { key: 'soul' as const, fileName: 'SOUL.md', labelKey: 'personas.fileSoul', hintKey: 'personas.fileSoulHint', rows: 12 },
  { key: 'user' as const, fileName: 'USER.md', labelKey: 'personas.fileUser', hintKey: 'personas.fileUserHint', rows: 6 },
  { key: 'tools' as const, fileName: 'TOOLS.md', labelKey: 'personas.fileTools', hintKey: 'personas.fileToolsHint', rows: 6 },
  { key: 'agents' as const, fileName: 'AGENTS.md', labelKey: 'personas.fileAgents', hintKey: 'personas.fileAgentsHint', rows: 6 },
  { key: 'heartbeat' as const, fileName: 'HEARTBEAT.md', labelKey: 'personas.fileHeartbeat', hintKey: 'personas.fileHeartbeatHint', rows: 6 },
]

/* ── Create dialog ── */

const showCreateDialog = ref(false)
const creating = ref(false)
const createError = ref<string | null>(null)
const createForm = ref({ id: '', name: '', badge: '', color: '#4f8ef7', role: '' })

/* ── Delete dialog ── */

const deleteTarget = ref<PersonaListItem | null>(null)
const deletePreview = ref<PersonaDeletePreview | null>(null)
const previewLoading = ref(false)
const deleting = ref(false)
const deleteConfirmation = ref('')

const previewRows = computed(() => {
  const preview = deletePreview.value
  if (!preview) return []
  return ([
    ['strands', preview.strands],
    ['messages', preview.messages],
    ['tasks', preview.tasks],
    ['cronjobs', preview.cronjobs],
    ['facts', preview.facts],
    ['captures', preview.captures],
  ] as const).map(([key, value]) => ({ key, value }))
})

/* ── Presentation helpers ── */

function avatarStyle(persona: PersonaListItem): Record<string, string> {
  // A persona without a colour gets the neutral surface, never a white box in
  // dark mode: both values come from the theme, not from a literal.
  if (!persona.color) return { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }
  return { backgroundColor: `${persona.color}20`, color: persona.color }
}

function initial(persona: PersonaListItem): string {
  return (persona.displayName || persona.id).charAt(0).toUpperCase()
}

function flash(message: string): void {
  successMessage.value = message
  setTimeout(() => { successMessage.value = null }, 3500)
}

/* ── Actions ── */

async function reload(): Promise<void> {
  error.value = null
  await fetchPersonas()
}

function openCreate(): void {
  createForm.value = { id: '', name: '', badge: '', color: '#4f8ef7', role: '' }
  createError.value = null
  showCreateDialog.value = true
}

async function startEdit(id: string): Promise<void> {
  editingId.value = id
  editLoading.value = true
  editorTab.value = 'fields'
  error.value = null
  successMessage.value = null

  const persona = await getPersona(id)
  if (persona) {
    const fields = persona.fields
    form.value = {
      name: fields.name ?? '',
      badge: fields.badge ?? '',
      color: fields.color ?? '',
      role: fields.role ?? '',
      tone: fields.tone ?? '',
      model: fields.model ?? '',
      subjects: [...fields.subjects],
      tools: [...fields.tools],
    }
    rawFiles.value = { ...persona.files }
    loadedFiles.value = { ...persona.files }
  }
  editLoading.value = false
}

function cancelEdit(): void {
  editingId.value = null
  form.value = null
  loadedFiles.value = null
  error.value = null
  successMessage.value = null
}

/** Empty string means "clear the field", which the API models as null. */
function orNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

async function handleSave(): Promise<void> {
  if (!editingId.value || !form.value) return
  if (colorInvalid.value) {
    error.value = t('personas.fieldColorInvalid')
    return
  }

  saving.value = true
  error.value = null

  const fields: Partial<PersonaFields> = {
    name: orNull(form.value.name),
    badge: orNull(form.value.badge),
    color: orNull(form.value.color),
    role: orNull(form.value.role),
    tone: orNull(form.value.tone),
    model: orNull(form.value.model),
    subjects: form.value.subjects,
    tools: form.value.tools,
  }

  // Only send the raw files the user actually touched: a full write would
  // clobber an edit somebody else made in another tab for no reason.
  const files: Partial<PersonaFiles> = {}
  for (const spec of fileSpecs) {
    if (loadedFiles.value && rawFiles.value[spec.key] !== loadedFiles.value[spec.key]) {
      files[spec.key] = rawFiles.value[spec.key]
    }
  }

  const result = await updatePersona(editingId.value, {
    ...(Object.keys(files).length > 0 ? { files } : {}),
    fields,
  })
  saving.value = false

  if (result) {
    rawFiles.value = { ...result.files }
    loadedFiles.value = { ...result.files }
    flash(t('personas.saveSuccess'))
  }
}

async function handleCreate(): Promise<void> {
  const id = createForm.value.id.trim().toLowerCase()
  if (!id) return
  if (!/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/.test(id)) {
    createError.value = t('personas.idHint')
    return
  }

  creating.value = true
  createError.value = null
  error.value = null

  const result = await createPersona({
    id,
    fields: {
      name: orNull(createForm.value.name),
      badge: orNull(createForm.value.badge),
      color: orNull(createForm.value.color),
      role: orNull(createForm.value.role),
    },
  })
  creating.value = false

  if (result) {
    showCreateDialog.value = false
    flash(t('personas.createSuccess', { name: result.displayName }))
    await startEdit(id)
  } else {
    createError.value = error.value
    error.value = null
  }
}

async function handleArchive(persona: PersonaListItem, archived: boolean, closeDialog = false): Promise<void> {
  const result = await archivePersona(persona.id, archived)
  if (closeDialog) deleteTarget.value = null
  if (result) {
    flash(archived
      ? t('personas.archiveSuccess', { name: persona.displayName })
      : t('personas.restoreSuccess', { name: persona.displayName }))
  }
}

async function handleMakeDefault(persona: PersonaListItem): Promise<void> {
  const result = await makeDefault(persona.id)
  if (result) flash(t('personas.defaultSuccess', { name: persona.displayName }))
}

async function startDelete(persona: PersonaListItem): Promise<void> {
  deleteTarget.value = persona
  deleteConfirmation.value = ''
  deletePreview.value = null
  previewLoading.value = true
  deletePreview.value = await getDeletePreview(persona.id)
  previewLoading.value = false
}

async function handleDelete(): Promise<void> {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  const ok = await deletePersona(target.id)
  deleting.value = false
  if (ok) {
    deleteTarget.value = null
    flash(t('personas.deleteSuccess', { name: target.displayName }))
  }
}

async function copyFile(key: keyof PersonaFiles): Promise<void> {
  try {
    await navigator.clipboard.writeText(rawFiles.value[key])
    copiedKey.value = key
    setTimeout(() => { copiedKey.value = null }, 1500)
  } catch {
    // A denied clipboard permission is not worth an error banner: the textarea
    // is right there and selectable.
  }
}

onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([fetchPersonas(), fetchSettings()])
})
</script>
