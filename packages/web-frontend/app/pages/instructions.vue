<template>
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('instructions.title')" :subtitle="$t('instructions.subtitle')" />

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-hidden p-6">
      <Alert v-if="error" variant="destructive" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="mb-3 shrink-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ $t('memory.saveSuccess') }}</span>
          <button type="button" class="ml-2 opacity-70 transition-opacity hover:opacity-100" :aria-label="$t('aria.closeAlert')" @click="clearMessages()">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Tabs v-model="activeFile" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-4 flex shrink-0 flex-wrap items-center gap-3">
          <TabsList class="self-start">
            <TabsTrigger
              v-for="item in instructionItems"
              :key="item.id"
              :value="item.id"
              @click="activeFile = item.id"
            >
              {{ item.title }}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          v-for="item in instructionItems"
          :key="item.id"
          :value="item.id"
          class="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <div v-if="loading && !loadedFiles.has(item.id)" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
            {{ $t('instructions.loading') }}
          </div>
          <div v-else class="flex flex-1 flex-col overflow-hidden min-h-0">
            <MarkdownEditor
              v-model="contents[item.id]"
              :saving="saving"
              :file-path="item.path"
              @save="handleSaveCurrent"
            >
              <template #footerActions>
                <Button variant="outline" :disabled="restoringDefault" @click="restoreDialogOpen = true">
                  <span
                    v-if="restoringDefault"
                    class="h-4 w-4 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground"
                    aria-hidden="true"
                  />
                  {{ restoringDefault ? $t('instructions.restoringDefault') : $t('instructions.restoreDefault') }}
                </Button>
              </template>
            </MarkdownEditor>
          </div>
        </TabsContent>
      </Tabs>
    </div>

    <ConfirmDialog
      :open="restoreDialogOpen"
      :title="$t('instructions.restoreDefaultConfirmTitle')"
      :description="$t('instructions.restoreDefaultConfirmDescription')"
      :confirm-label="$t('instructions.restoreDefault')"
      :cancel-label="$t('common.cancel')"
      :destructive="false"
      :loading="restoringDefault"
      @confirm="handleRestoreDefault"
      @cancel="restoreDialogOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const {
  loading,
  saving,
  error,
  successMessage,
  loadAgentRules,
  saveAgentRules,
  loadDefaultAgentRules,
  loadHeartbeat,
  saveHeartbeat,
  loadDefaultHeartbeat,
  loadConsolidationRules,
  saveConsolidationRules,
  loadDefaultConsolidationRules,
  loadTasksGuidelines,
  saveTasksGuidelines,
  loadDefaultTasksGuidelines,
  clearMessages,
} = useMemory()

const VALID_FILES = ['agents', 'consolidation', 'heartbeat', 'tasks'] as const

type InstructionFileId = (typeof VALID_FILES)[number]

type InstructionItem = {
  id: InstructionFileId
  title: string
  path: string
  load: () => Promise<string>
  save: (content: string) => Promise<boolean>
  loadDefault: () => Promise<string>
}

const activeFile = computed<InstructionFileId>({
  get() {
    const raw = route.query.file as string
    return VALID_FILES.includes(raw as InstructionFileId) ? (raw as InstructionFileId) : 'agents'
  },
  set(value) {
    router.replace({ query: { ...route.query, file: value } })
  },
})

const instructionItems = computed<InstructionItem[]>(() => [
  {
    id: 'agents',
    title: t('settings.agentRulesTitle'),
    path: '/data/config/AGENTS.md',
    load: loadAgentRules,
    save: saveAgentRules,
    loadDefault: loadDefaultAgentRules,
  },
  {
    id: 'consolidation',
    title: t('settings.consolidationRulesTitle'),
    path: '/data/config/CONSOLIDATION.md',
    load: loadConsolidationRules,
    save: saveConsolidationRules,
    loadDefault: loadDefaultConsolidationRules,
  },
  {
    id: 'heartbeat',
    title: t('settings.heartbeatTasksTitle'),
    path: '/data/config/HEARTBEAT.md',
    load: loadHeartbeat,
    save: saveHeartbeat,
    loadDefault: loadDefaultHeartbeat,
  },
  {
    id: 'tasks',
    title: t('settings.tasksGuidelinesTitle'),
    path: '/data/config/TASKS.md',
    load: loadTasksGuidelines,
    save: saveTasksGuidelines,
    loadDefault: loadDefaultTasksGuidelines,
  },
])

const currentInstruction = computed<InstructionItem>(() => (
  instructionItems.value.find(item => item.id === activeFile.value) ?? instructionItems.value[0]!
))

const contents = reactive<Record<InstructionFileId, string>>({
  agents: '',
  consolidation: '',
  heartbeat: '',
  tasks: '',
})
const loadedFiles = ref<Set<InstructionFileId>>(new Set())
const restoreDialogOpen = ref(false)
const restoringDefault = ref(false)

async function ensureCurrentFileLoaded() {
  const fileId = activeFile.value
  if (loadedFiles.value.has(fileId)) return

  clearMessages()
  const content = await currentInstruction.value.load()
  if (error.value) return

  contents[fileId] = content
  loadedFiles.value = new Set([...loadedFiles.value, fileId])
}

async function handleSaveCurrent() {
  const saved = await currentInstruction.value.save(contents[activeFile.value])
  if (!saved) return

  setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

async function handleRestoreDefault() {
  restoringDefault.value = true
  try {
    clearMessages()
    const content = await currentInstruction.value.loadDefault()
    if (error.value) return

    contents[activeFile.value] = content
    restoreDialogOpen.value = false
  } finally {
    restoringDefault.value = false
  }
}

watch(activeFile, async () => {
  await ensureCurrentFileLoaded()
}, { immediate: true })
</script>
