<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('skills.title')" :subtitle="$t('skills.subtitle')">
      <template v-if="activeTab === 'installed'" #actions>
        <Button class="h-8 px-3 text-xs md:h-10 md:px-4 md:py-2 md:text-sm" @click="showInstallDialog = true">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('skills.addSkill') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden p-6">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearError()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Success banner -->
      <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="successMessage = null">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Tabs -->
      <Tabs v-model="activeTab" class="flex flex-1 flex-col overflow-hidden min-h-0">
        <div class="mb-4 flex shrink-0 flex-wrap items-center gap-3">
          <TabsList class="self-start">
            <TabsTrigger value="installed" @click="switchTab('installed')">{{ $t('skills.installedTab') }}</TabsTrigger>
            <TabsTrigger value="agent" @click="switchTab('agent')">{{ $t('skills.agentTab') }}</TabsTrigger>
            <TabsTrigger value="builtin" @click="switchTab('builtin')">{{ $t('skills.builtinTab') }}</TabsTrigger>
          </TabsList>
        </div>

        <!-- Installed Skills tab -->
        <TabsContent value="installed" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
          <div v-if="loading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('skills.loading') }}
          </div>

          <!-- Empty state -->
          <div v-else-if="skills.length === 0" class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground">
            <AppIcon name="puzzle" size="xl" class="h-12 w-12 opacity-40" />
            <div>
              <p class="text-sm font-medium text-foreground">{{ $t('skills.emptyTitle') }}</p>
              <p class="mt-1 text-sm">{{ $t('skills.emptyDescription') }}</p>
            </div>
            <Button @click="showInstallDialog = true">
              <AppIcon name="add" class="mr-1 h-4 w-4" />
              {{ $t('skills.addFirstSkill') }}
            </Button>
          </div>

          <!-- Skills list -->
          <div v-else class="flex-1 space-y-3 overflow-y-auto min-h-0">
            <Card v-for="skill in skills" :key="skill.id" class="transition-colors">
              <div class="flex items-center gap-4 p-4">
                <!-- Icon / Emoji -->
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">
                  <span v-if="skill.emoji">{{ skill.emoji }}</span>
                  <AppIcon v-else-if="skill.id.startsWith('uploaded/')" name="upload" class="h-5 w-5 text-muted-foreground" />
                  <AppIcon v-else name="puzzle" class="h-5 w-5 text-muted-foreground" />
                </div>

                <!-- Info -->
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-foreground truncate">{{ skill.id.startsWith('uploaded/') ? skill.id.slice('uploaded/'.length) : skill.id }}</span>
                  </div>
                  <p v-if="skill.description" class="mt-0.5 text-sm text-muted-foreground line-clamp-1">
                    {{ skill.description }}
                  </p>
                </div>

                <!-- Actions -->
                <div class="flex shrink-0 items-center gap-2">
                  <!-- Settings -->
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('skills.settings')" @click.stop="openSettings(skill)">
                        <AppIcon name="settings" class="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ $t('skills.settings') }}</TooltipContent>
                  </Tooltip>

                  <!-- Delete -->
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('skills.delete')" @click.stop="openDeleteConfirm(skill)">
                        <AppIcon name="trash" class="h-4 w-4 text-muted-foreground hover:text-destructive transition-colors" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{{ $t('skills.delete') }}</TooltipContent>
                  </Tooltip>

                  <!-- Toggle -->
                  <Switch
                    :checked="skill.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @update:checked="handleToggleSkill(skill)"
                  />
                </div>
              </div>
            </Card>
          </div>
        </TabsContent>

        <!-- Agent Skills tab -->
        <TabsContent value="agent" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
          <div v-if="agentLoading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('skills.agentLoading') }}
          </div>

          <!-- Empty state -->
          <div v-else-if="agentSkills.length === 0" class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-center text-muted-foreground">
            <AppIcon name="puzzle" size="xl" class="h-12 w-12 opacity-40" />
            <div>
              <p class="text-sm font-medium text-foreground">{{ $t('skills.agentEmpty') }}</p>
              <p class="mt-1 text-sm">{{ $t('skills.agentEmptyDescription') }}</p>
            </div>
          </div>

          <!-- Agent skills list -->
          <div v-else class="flex-1 space-y-3 overflow-y-auto min-h-0">
            <Card v-for="skill in agentSkills" :key="skill.name" class="transition-colors">
              <div class="flex items-start gap-4 p-4">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <AppIcon name="sparkles" class="h-5 w-5 text-muted-foreground" />
                </div>
                <div class="min-w-0 flex-1">
                  <span class="font-semibold text-foreground truncate">{{ skill.name }}</span>
                  <p v-if="skill.description" class="mt-0.5 text-sm text-muted-foreground line-clamp-1">
                    {{ skill.description }}
                  </p>
                  <div
                    v-if="hasMetadataBadges(skill)"
                    class="mt-2 flex flex-wrap items-center gap-1.5"
                  >
                    <!-- Missing env vars (warning) -->
                    <Badge
                      v-for="envVar in skill.missingEnvVars"
                      :key="`env-${envVar}`"
                      variant="warning"
                      :title="$t('skills.metadata.missingEnvTooltip')"
                    >
                      ⚠ {{ envVar }}
                    </Badge>
                    <!-- Platforms -->
                    <Badge
                      v-for="platform in skill.platforms"
                      :key="`platform-${platform}`"
                      variant="secondary"
                      :title="$t('skills.metadata.platformTooltip')"
                    >
                      {{ platform }}
                    </Badge>
                    <!-- Required toolsets -->
                    <Badge
                      v-for="toolset in skill.requiresToolsets"
                      :key="`toolset-${toolset}`"
                      variant="muted"
                      :title="$t('skills.metadata.toolsetTooltip')"
                    >
                      {{ $t('skills.metadata.needsPrefix') }} {{ toolset }}
                    </Badge>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </TabsContent>

        <!-- Built-in Tools tab -->
        <TabsContent value="builtin" class="flex flex-1 flex-col overflow-hidden min-h-0 mt-0">
          <div v-if="builtinLoading" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('skills.loading') }}
          </div>

          <div v-else class="flex-1 space-y-4 overflow-y-auto min-h-0">
            <!-- web_fetch card -->
            <Card>
              <CardHeader class="py-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <AppIcon name="file" class="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle class="text-base">{{ $t('skills.webFetchTitle') }}</CardTitle>
                      <CardDescription class="mt-0.5">{{ $t('skills.webFetchDescription') }}</CardDescription>
                    </div>
                  </div>
                  <Switch
                    :checked="localWebFetch.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @update:checked="handleToggleWebFetch"
                  />
                </div>
              </CardHeader>
            </Card>

            <!-- web_search card -->
            <Card>
              <CardHeader class="py-4">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <AppIcon name="globe" class="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle class="text-base">{{ $t('skills.webSearchTitle') }}</CardTitle>
                      <CardDescription class="mt-0.5">{{ $t('skills.webSearchDescription') }}</CardDescription>
                    </div>
                  </div>
                  <Switch
                    :checked="localWebSearch.enabled"
                    :aria-label="$t('skills.toggleEnabled')"
                    @update:checked="(val: boolean) => localWebSearch.enabled = val"
                  />
                </div>
              </CardHeader>
              <CardContent v-if="localWebSearch.enabled" class="space-y-4 pt-0">
                <!-- Provider select -->
                <div class="space-y-2">
                  <Label :for="'web-search-provider'">{{ $t('skills.webSearchProvider') }}</Label>
                  <Select
                    :model-value="localWebSearch.provider"
                    @update:model-value="localWebSearch.provider = $event as 'duckduckgo' | 'brave' | 'searxng' | 'tavily'"
                  >
                    <SelectTrigger id="web-search-provider">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="duckduckgo">DuckDuckGo</SelectItem>
                      <SelectItem value="brave">Brave Search</SelectItem>
                      <SelectItem value="searxng">SearXNG</SelectItem>
                      <SelectItem value="tavily">Tavily</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <!-- Brave API Key (conditional) -->
                <div v-if="localWebSearch.provider === 'brave'" class="space-y-2">
                  <Label :for="'brave-api-key'">{{ $t('skills.braveApiKey') }}</Label>
                  <Input
                    id="brave-api-key"
                    v-model="localBraveApiKey"
                    type="password"
                    :placeholder="$t('skills.braveApiKeyPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('skills.braveApiKeyHint') }}</p>
                </div>

                <!-- SearXNG URL (conditional) -->
                <div v-if="localWebSearch.provider === 'searxng'" class="space-y-2">
                  <Label :for="'searxng-url'">{{ $t('skills.searxngUrl') }}</Label>
                  <Input
                    id="searxng-url"
                    v-model="localSearxngUrl"
                    type="text"
                    :placeholder="$t('skills.searxngUrlPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('skills.searxngUrlHint') }}</p>
                </div>

                <!-- Tavily API Key (conditional) -->
                <div v-if="localWebSearch.provider === 'tavily'" class="space-y-2">
                  <Label :for="'tavily-api-key'">{{ $t('skills.tavilyApiKey') }}</Label>
                  <Input
                    id="tavily-api-key"
                    v-model="localTavilyApiKey"
                    type="password"
                    :placeholder="$t('skills.tavilyApiKeyPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="text-xs text-muted-foreground">{{ $t('skills.tavilyApiKeyHint') }}</p>
                </div>

                <div class="flex justify-end">
                <Button size="sm" :disabled="savingBuiltin" @click="handleSaveWebSearch">
                  <span
                    v-if="savingBuiltin"
                    class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                    aria-hidden="true"
                  />
                  {{ $t('common.save') }}
                </Button>
                </div>
              </CardContent>
            </Card>

          </div>
        </TabsContent>
      </Tabs>
    </div>
  </div>

  <!-- Install Skill dialog -->
  <Dialog :open="showInstallDialog" @update:open="(v: boolean) => { if (!v) closeInstallDialog() }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ $t('skills.installTitle') }}</DialogTitle>
        <DialogDescription>{{ $t('skills.installDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- Mode tabs -->
        <Tabs v-model="installMode" class="w-full">
          <TabsList class="w-full">
            <TabsTrigger value="url" class="flex-1">{{ $t('skills.installModeUrl') }}</TabsTrigger>
            <TabsTrigger value="file" class="flex-1">{{ $t('skills.installModeFile') }}</TabsTrigger>
          </TabsList>
        </Tabs>

        <!-- URL mode -->
        <div v-if="installMode === 'url'" class="space-y-2">
          <Label for="skill-source">{{ $t('skills.installSource') }}</Label>
          <Input
            id="skill-source"
            v-model="installSource"
            type="text"
            :placeholder="$t('skills.installPlaceholder')"
            :disabled="installing"
            autocomplete="off"
            @keydown.enter="handleInstall"
          />
          <div class="text-xs text-muted-foreground space-y-1">
            <p>{{ $t('skills.installExamples') }}</p>
            <code class="block rounded bg-muted px-2 py-1 text-[11px]">zats/perplexity</code>
            <code class="block rounded bg-muted px-2 py-1 text-[11px]">https://github.com/anthropics/skills/tree/main/skills/pdf</code>
          </div>
        </div>

        <!-- File upload mode -->
        <div v-if="installMode === 'file'" class="space-y-2">
          <Label>{{ $t('skills.uploadFile') }}</Label>
          <input
            ref="fileInputRef"
            type="file"
            accept=".zip,.skill"
            class="hidden"
            :disabled="installing"
            @change="handleFileSelect"
          />

          <!-- Drop zone / file display -->
          <div
            v-if="!selectedFile"
            class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-8 text-center transition-colors hover:border-muted-foreground/50 hover:bg-muted/50"
            @click="triggerFileInput"
          >
            <AppIcon name="upload" class="h-8 w-8 text-muted-foreground/50" />
            <div>
              <p class="text-sm font-medium text-foreground">{{ $t('skills.uploadDropzone') }}</p>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ $t('skills.uploadHint') }}</p>
            </div>
          </div>

          <!-- Selected file -->
          <div v-else class="flex items-center gap-3 rounded-lg border bg-muted/50 p-3">
            <AppIcon name="file" class="h-5 w-5 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ selectedFile.name }}</p>
              <p class="text-xs text-muted-foreground">{{ formatFileSize(selectedFile.size) }}</p>
            </div>
            <button
              type="button"
              class="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
              :aria-label="$t('skills.removeFile')"
              :disabled="installing"
              @click="removeSelectedFile"
            >
              <AppIcon name="close" class="h-4 w-4" />
            </button>
          </div>
        </div>

        <!-- Install error -->
        <Alert v-if="installError" variant="destructive">
          <AlertDescription>{{ installError }}</AlertDescription>
        </Alert>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="installing" @click="closeInstallDialog">
          {{ $t('common.cancel') }}
        </Button>
        <Button
          :disabled="(installMode === 'url' && !installSource.trim()) || (installMode === 'file' && !selectedFile) || installing"
          @click="handleInstall"
        >
          <span
            v-if="installing"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ installing ? $t('skills.installing') : $t('skills.install') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Skill Settings dialog -->
  <Dialog :open="!!settingsSkill" @update:open="(v: boolean) => { if (!v) closeSettings() }">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          <span v-if="settingsSkill?.emoji" class="mr-2">{{ settingsSkill.emoji }}</span>
          {{ settingsSkill?.id }}
        </DialogTitle>
        <DialogDescription>{{ $t('skills.settingsDescription') }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- Declared env vars -->
        <div v-for="key in settingsEnvKeys" :key="key" class="space-y-2">
          <div class="flex items-center gap-2">
            <Label :for="`env-${key}`" class="flex-1">{{ key }}</Label>
            <button
              v-if="!settingsSkill?.envKeys?.includes(key)"
              type="button"
              class="text-muted-foreground hover:text-destructive transition-colors"
              :aria-label="$t('skills.removeEnvVar')"
              @click="removeEnvKey(key)"
            >
              <AppIcon name="close" class="h-3.5 w-3.5" />
            </button>
          </div>
          <Input
            :id="`env-${key}`"
            :model-value="envValuesForm[key] || ''"
            type="password"
            :placeholder="$t('skills.envValuePlaceholder')"
            autocomplete="off"
            @update:model-value="envValuesForm[key] = $event"
          />
        </div>

        <!-- Add new env var -->
        <div class="space-y-2">
          <Label>{{ $t('skills.addEnvVar') }}</Label>
          <div class="flex gap-2">
            <Input
              v-model="newEnvKey"
              type="text"
              :placeholder="$t('skills.envKeyPlaceholder')"
              class="flex-1 font-mono"
              autocomplete="off"
              @keydown.enter.prevent="addEnvKey"
            />
            <Button variant="outline" size="sm" :disabled="!newEnvKey.trim()" @click="addEnvKey">
              <AppIcon name="add" class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="savingSettings" @click="closeSettings">
          {{ $t('common.cancel') }}
        </Button>
        <Button :disabled="savingSettings" @click="handleSaveSettings">
          <span
            v-if="savingSettings"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
            aria-hidden="true"
          />
          {{ $t('common.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('skills.delete')"
    :description="$t('skills.deleteConfirm', { name: deleteTarget?.id ?? '' })"
    :confirm-label="$t('skills.deleteConfirmButton')"
    :cancel-label="$t('common.cancel')"
    :loading="deleting"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />
</template>

<script setup lang="ts">
import type { Skill, AgentSkill } from '~/composables/useSkills'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const {
  skills,
  agentSkills,
  builtinTools,
  braveSearchApiKey,
  searxngUrl,
  tavilyApiKey,
  loading,
  error,
  installing,
  fetchSkills,
  fetchAgentSkills,
  fetchBuiltinTools,
  installSkill,
  uploadSkill,
  updateSkill,
  deleteSkill,
  updateBuiltinTools,
  clearError,
} = useSkills()

const activeTab = ref<'installed' | 'agent' | 'builtin'>('installed')
const agentLoading = ref(false)
const successMessage = ref<string | null>(null)
const builtinLoading = ref(false)

// Install dialog
const showInstallDialog = ref(false)
const installSource = ref('')
const installError = ref<string | null>(null)
const installMode = ref<'url' | 'file'>('url')
const selectedFile = ref<File | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

// Settings dialog
const settingsSkill = ref<Skill | null>(null)
const envValuesForm = ref<Record<string, string>>({})
const customEnvKeys = ref<string[]>([])
const newEnvKey = ref('')
const savingSettings = ref(false)

// Combined env keys: declared from SKILL.md + custom added by user
const settingsEnvKeys = computed(() => {
  const declared = settingsSkill.value?.envKeys ?? []
  return [...declared, ...customEnvKeys.value]
})

// Delete dialog
const deleteTarget = ref<Skill | null>(null)
const deleting = ref(false)

// Built-in tools local state
const localWebSearch = reactive({
  enabled: true,
  provider: 'duckduckgo' as 'duckduckgo' | 'brave' | 'searxng' | 'tavily',
})
const localWebFetch = reactive({
  enabled: true,
})
const localBraveApiKey = ref('')
const localSearxngUrl = ref('')
const localTavilyApiKey = ref('')
const savingBuiltin = ref(false)

function syncBuiltinLocal() {
  localWebSearch.enabled = builtinTools.value.webSearch.enabled
  localWebSearch.provider = builtinTools.value.webSearch.provider
  localWebFetch.enabled = builtinTools.value.webFetch.enabled
  localBraveApiKey.value = braveSearchApiKey.value
  localSearxngUrl.value = searxngUrl.value
  localTavilyApiKey.value = tavilyApiKey.value
}

async function switchTab(tab: 'installed' | 'agent' | 'builtin') {
  clearError()
  successMessage.value = null
  activeTab.value = tab

  if (tab === 'agent') {
    agentLoading.value = true
    await fetchAgentSkills()
    agentLoading.value = false
  } else if (tab === 'builtin') {
    builtinLoading.value = true
    await fetchBuiltinTools()
    syncBuiltinLocal()
    builtinLoading.value = false
  }
}

// Install skill
function closeInstallDialog() {
  showInstallDialog.value = false
  installSource.value = ''
  installError.value = null
  installMode.value = 'url'
  selectedFile.value = null
}

async function handleInstall() {
  installError.value = null

  if (installMode.value === 'file') {
    if (!selectedFile.value) return
    const result = await uploadSkill(selectedFile.value)
    if (result) {
      closeInstallDialog()
      successMessage.value = t('skills.installSuccess')
      autoHideSuccess()
    } else {
      installError.value = error.value
      clearError()
    }
    return
  }

  if (!installSource.value.trim()) return
  const result = await installSkill(installSource.value.trim())
  if (result) {
    closeInstallDialog()
    successMessage.value = t('skills.installSuccess')
    autoHideSuccess()
  } else {
    installError.value = error.value
    clearError()
  }
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    selectedFile.value = input.files[0] ?? null
  }
}

function triggerFileInput() {
  fileInputRef.value?.click()
}

function removeSelectedFile() {
  selectedFile.value = null
  if (fileInputRef.value) fileInputRef.value.value = ''
}

// Toggle skill enabled/disabled
async function handleToggleSkill(skill: Skill) {
  const newEnabled = !skill.enabled
  // Optimistic update
  const idx = skills.value.findIndex(s => s.id === skill.id)
  if (idx >= 0) skills.value[idx] = { ...skills.value[idx]!, enabled: newEnabled }

  const result = await updateSkill(skill.id, { enabled: newEnabled })
  if (!result && idx >= 0) {
    // Revert on failure
    skills.value[idx] = { ...skills.value[idx]!, enabled: !newEnabled }
  }
}

// Settings dialog
function openSettings(skill: Skill) {
  settingsSkill.value = skill
  envValuesForm.value = {}
  customEnvKeys.value = []
  newEnvKey.value = ''
  // Pre-populate with empty strings for each envKey
  for (const key of skill.envKeys ?? []) {
    envValuesForm.value[key] = ''
  }
}

function closeSettings() {
  settingsSkill.value = null
  envValuesForm.value = {}
  customEnvKeys.value = []
  newEnvKey.value = ''
}

function addEnvKey() {
  const key = newEnvKey.value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  if (!key) return
  const declared = settingsSkill.value?.envKeys ?? []
  if (declared.includes(key) || customEnvKeys.value.includes(key)) return
  customEnvKeys.value.push(key)
  envValuesForm.value[key] = ''
  newEnvKey.value = ''
}

function removeEnvKey(key: string) {
  customEnvKeys.value = customEnvKeys.value.filter(k => k !== key)
  delete envValuesForm.value[key]
}

async function handleSaveSettings() {
  if (!settingsSkill.value) return
  savingSettings.value = true

  // Only send non-empty values
  const envValues: Record<string, string> = {}
  for (const [key, value] of Object.entries(envValuesForm.value)) {
    if (value) envValues[key] = value
  }

  // Merge declared + custom env keys
  const allEnvKeys = [...new Set([...(settingsSkill.value.envKeys ?? []), ...customEnvKeys.value])]

  const updatePayload: { envValues: Record<string, string>; envKeys?: string[] } = { envValues }
  // Only send envKeys if custom keys were added
  if (customEnvKeys.value.length > 0) {
    updatePayload.envKeys = allEnvKeys
  }

  const result = await updateSkill(settingsSkill.value.id, updatePayload)
  savingSettings.value = false

  if (result) {
    closeSettings()
    successMessage.value = t('skills.settingsSaved')
    autoHideSuccess()
  }
}

// Delete skill
function openDeleteConfirm(skill: Skill) {
  deleteTarget.value = skill
}

async function handleDelete() {
  if (!deleteTarget.value) return
  deleting.value = true

  const success = await deleteSkill(deleteTarget.value.id)
  deleting.value = false

  if (success) {
    deleteTarget.value = null
    successMessage.value = t('skills.deleteSuccess')
    autoHideSuccess()
  }
}

// Built-in tools: save web_search settings
async function handleSaveWebSearch() {
  savingBuiltin.value = true

  const input: {
    builtinTools: { webSearch: { enabled: boolean; provider: 'duckduckgo' | 'brave' | 'searxng' | 'tavily' } }
    braveSearchApiKey?: string
    searxngUrl?: string
    tavilyApiKey?: string
  } = {
    builtinTools: {
      webSearch: {
        enabled: localWebSearch.enabled,
        provider: localWebSearch.provider,
      },
    },
  }

  // Only send API key / URL if it changed (non-empty means user typed new value)
  if (localWebSearch.provider === 'brave' && localBraveApiKey.value !== braveSearchApiKey.value) {
    input.braveSearchApiKey = localBraveApiKey.value
  }
  if (localWebSearch.provider === 'searxng' && localSearxngUrl.value !== searxngUrl.value) {
    input.searxngUrl = localSearxngUrl.value
  }
  if (localWebSearch.provider === 'tavily' && localTavilyApiKey.value !== tavilyApiKey.value) {
    input.tavilyApiKey = localTavilyApiKey.value
  }

  const success = await updateBuiltinTools(input)
  savingBuiltin.value = false

  if (success) {
    successMessage.value = t('skills.builtinSaved')
    autoHideSuccess()
  }
}

// Toggle web_fetch
async function handleToggleWebFetch() {
  const newEnabled = !localWebFetch.enabled
  localWebFetch.enabled = newEnabled

  const success = await updateBuiltinTools({
    builtinTools: {
      webFetch: { enabled: newEnabled },
    },
  })

  if (!success) {
    localWebFetch.enabled = !newEnabled
  }
}

const { t } = useI18n()

function hasMetadataBadges(skill: AgentSkill): boolean {
  return (
    (skill.missingEnvVars?.length ?? 0) > 0 ||
    (skill.platforms?.length ?? 0) > 0 ||
    (skill.requiresToolsets?.length ?? 0) > 0
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function autoHideSuccess() {
  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

onMounted(async () => {
  if (!isAdmin.value) return
  await fetchSkills()
})
</script>
