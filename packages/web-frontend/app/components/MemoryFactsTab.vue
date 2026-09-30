<template>
  <div class="flex flex-1 flex-col overflow-hidden min-h-0">
    <Alert v-if="errorMessage" variant="destructive" class="mb-4 shrink-0">
      <AlertDescription class="flex items-center justify-between gap-3">
        <span>{{ errorMessage }}</span>
        <button
          type="button"
          class="opacity-70 transition-opacity hover:opacity-100"
          :aria-label="$t('aria.closeAlert')"
          @click="clearMessages"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <Alert v-if="successMessage" variant="success" class="mb-4 shrink-0">
      <AlertDescription class="flex items-center justify-between gap-3">
        <span>{{ successMessage }}</span>
        <button
          type="button"
          class="opacity-70 transition-opacity hover:opacity-100"
          :aria-label="$t('aria.closeAlert')"
          @click="clearMessages"
        >
          <AppIcon name="close" class="h-4 w-4" />
        </button>
      </AlertDescription>
    </Alert>

    <div class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div class="border-b border-border px-4 py-4">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div class="flex flex-1 flex-col gap-3 sm:flex-row">
            <input
              v-model="searchQuery"
              type="text"
              :placeholder="$t('memory.factsSearchPlaceholder')"
              class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring sm:max-w-md"
            >

            <Select v-if="showUserFilter" v-model="selectedUserId" @update:model-value="handleUserFilterChange">
              <SelectTrigger class="w-full sm:w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{{ $t('memory.factsAllUsers') }}</SelectItem>
                <SelectItem v-for="entry in users" :key="entry.id" :value="String(entry.id)">
                  {{ entry.username }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="text-xs text-muted-foreground">
            {{ $t('memory.factsPagination', { from: paginationFrom, to: paginationTo, total: totalFacts }) }}
          </div>
        </div>
      </div>

      <div v-if="loading && facts.length === 0" class="flex items-center justify-center py-16 text-sm text-muted-foreground">
        {{ $t('memory.loading') }}
      </div>

      <div
        v-else-if="totalFacts === 0"
        class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center text-muted-foreground"
      >
        <AppIcon name="brain" size="xl" class="h-10 w-10 opacity-40" />
        <p class="text-sm">
          {{ hasActiveFilters ? $t('memory.factsNoResults') : $t('memory.factsEmpty') }}
        </p>
      </div>

      <div v-else class="flex flex-col overflow-hidden">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="min-w-[320px]">{{ $t('memory.factsColumnContent') }}</TableHead>
                <TableHead>{{ $t('memory.factsColumnUser') }}</TableHead>
                <TableHead>{{ $t('memory.factsColumnSource') }}</TableHead>
                <TableHead>{{ $t('memory.factsColumnDate') }}</TableHead>
                <TableHead class="text-right">{{ $t('memory.factsColumnActions') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="fact in facts" :key="fact.id" class="align-top">
                <TableCell class="max-w-0">
                  <input
                    v-if="editingFactId === fact.id"
                    ref="editingInput"
                    v-model="editingContent"
                    type="text"
                    class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background transition focus:ring-2 focus:ring-ring"
                    @blur="handleEditBlur"
                    @keydown.enter.prevent="saveEditingFact"
                    @keydown.esc.prevent="handleEditEscape"
                  >
                  <button
                    v-else
                    type="button"
                    class="w-full rounded-md px-1 py-1 text-left text-sm text-foreground transition hover:bg-muted/70"
                    @click="startEditing(fact)"
                  >
                    <span class="whitespace-normal break-words">{{ fact.content }}</span>
                  </button>
                </TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {{ getUserLabel(fact.userId) }}
                </TableCell>
                <TableCell class="text-sm text-muted-foreground">
                  {{ fact.source }}
                </TableCell>
                <TableCell class="whitespace-nowrap text-sm text-muted-foreground">
                  {{ formatDateTime(fact.timestamp) }}
                </TableCell>
                <TableCell class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      class="gap-1.5"
                      :disabled="saving"
                      @click="startEditing(fact)"
                    >
                      <AppIcon name="edit" class="h-4 w-4" />
                      <span class="hidden sm:inline">{{ $t('memory.factsEdit') }}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="gap-1.5 text-destructive hover:text-destructive"
                      :disabled="saving"
                      @click="openDeleteDialog(fact)"
                    >
                      <AppIcon name="trash" class="h-4 w-4" />
                      <span class="hidden sm:inline">{{ $t('memory.factsDelete') }}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div v-if="totalPages > 1" class="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
          <span class="text-xs text-muted-foreground">
            {{ $t('memory.factsPagination', { from: paginationFrom, to: paginationTo, total: totalFacts }) }}
          </span>
          <div class="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              :disabled="currentPage <= 1 || loading"
              :aria-label="$t('memory.factsPrevPage')"
              @click="currentPage--"
            >
              <AppIcon name="arrowLeft" class="h-4 w-4" />
            </Button>
            <span class="px-2 text-xs text-muted-foreground">{{ currentPage }} / {{ totalPages }}</span>
            <Button
              variant="outline"
              size="sm"
              :disabled="currentPage >= totalPages || loading"
              :aria-label="$t('memory.factsNextPage')"
              @click="currentPage++"
            >
              <AppIcon name="arrowRight" class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('memory.factsDeleteConfirmTitle')"
      :description="$t('memory.factsDeleteConfirmDescription', { content: deleteTarget?.content ?? '' })"
      :confirm-label="$t('memory.factsDelete')"
      :loading="saving"
      destructive
      @confirm="handleDeleteFact"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import type { MemoryFact } from '~/composables/useMemoryFacts'

const { t } = useI18n()
const { formatDateTime } = useFormat()

const { users, error: usersError, fetchUsers } = useUsers()
const {
  loading,
  saving,
  error: factsError,
  loadFacts,
  updateFact,
  deleteFact,
} = useMemoryFacts()

const facts = ref<MemoryFact[]>([])
const totalFacts = ref(0)
const searchQuery = ref('')
const selectedUserId = ref('')
const currentPage = ref(1)
const editingFactId = ref<number | null>(null)
const editingContent = ref('')
const editingInput = ref<HTMLInputElement | null>(null)
const deleteTarget = ref<MemoryFact | null>(null)
const successMessage = ref<string | null>(null)
const localError = ref<string | null>(null)
const isCancellingEdit = ref(false)

const pageSize = 10
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
let successTimeout: ReturnType<typeof setTimeout> | null = null

const showUserFilter = computed(() => users.value.length > 1)
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim()) || Boolean(selectedUserId.value))
const totalPages = computed(() => Math.max(1, Math.ceil(totalFacts.value / pageSize)))
const paginationFrom = computed(() => totalFacts.value === 0 ? 0 : ((currentPage.value - 1) * pageSize) + 1)
const paginationTo = computed(() => Math.min(currentPage.value * pageSize, totalFacts.value))
const errorMessage = computed(() => localError.value || factsError.value || usersError.value)
const usersById = computed(() => new Map(users.value.map((entry) => [entry.id, entry.username])))

watch(currentPage, async () => {
  await refreshFacts()
})

watch(searchQuery, () => {
  clearMessages()

  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }

  searchDebounceTimer = setTimeout(async () => {
    if (currentPage.value !== 1) {
      currentPage.value = 1
      return
    }

    await refreshFacts()
  }, 250)
})

onMounted(async () => {
  await Promise.all([
    fetchUsers(),
    refreshFacts(),
  ])
})

onBeforeUnmount(() => {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
  if (successTimeout) clearTimeout(successTimeout)
})

function clearMessages() {
  localError.value = null
  successMessage.value = null
  factsError.value = null
  usersError.value = null
}

function showSuccess(message: string) {
  successMessage.value = message

  if (successTimeout) {
    clearTimeout(successTimeout)
  }

  successTimeout = setTimeout(() => {
    successMessage.value = null
  }, 3000)
}

async function refreshFacts() {
  const result = await loadFacts({
    query: searchQuery.value || undefined,
    userId: selectedUserId.value ? Number(selectedUserId.value) : undefined,
    limit: pageSize,
    offset: (currentPage.value - 1) * pageSize,
  })

  facts.value = result.facts
  totalFacts.value = result.total

  const maxPage = Math.max(1, Math.ceil(result.total / pageSize))
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  }
}

function handleUserFilterChange() {
  clearMessages()

  if (currentPage.value !== 1) {
    currentPage.value = 1
    return
  }

  void refreshFacts()
}

function getUserLabel(userId: number | null): string {
  if (userId === null) return '—'
  return usersById.value.get(userId) ?? `#${userId}`
}

function startEditing(fact: MemoryFact) {
  clearMessages()
  editingFactId.value = fact.id
  editingContent.value = fact.content

  nextTick(() => {
    editingInput.value?.focus()
    editingInput.value?.select()
  })
}

function cancelEditing() {
  editingFactId.value = null
  editingContent.value = ''
}

function handleEditEscape() {
  isCancellingEdit.value = true
  cancelEditing()

  setTimeout(() => {
    isCancellingEdit.value = false
  }, 0)
}

async function handleEditBlur() {
  if (isCancellingEdit.value) return
  await saveEditingFact()
}

async function saveEditingFact() {
  if (saving.value || editingFactId.value === null) return

  const factId = editingFactId.value
  const content = editingContent.value.trim()
  if (!content) {
    localError.value = t('memory.factsContentRequired')
    return
  }

  const existingFact = facts.value.find((entry) => entry.id === factId)
  if (!existingFact) {
    cancelEditing()
    return
  }

  if (existingFact.content === content) {
    cancelEditing()
    return
  }

  const updated = await updateFact(factId, content)
  if (!updated) {
    localError.value = factsError.value || t('memory.factsUpdateError')
    return
  }

  facts.value = facts.value.map((entry) => entry.id === factId ? { ...entry, content } : entry)
  cancelEditing()
  showSuccess(t('memory.factsUpdateSuccess'))
}

function openDeleteDialog(fact: MemoryFact) {
  clearMessages()
  deleteTarget.value = fact
}

async function handleDeleteFact() {
  if (!deleteTarget.value) return

  const targetId = deleteTarget.value.id
  const shouldStepBack = facts.value.length === 1 && currentPage.value > 1

  const deleted = await deleteFact(targetId)
  if (!deleted) {
    localError.value = factsError.value || t('memory.factsDeleteError')
    return
  }

  deleteTarget.value = null
  if (editingFactId.value === targetId) {
    cancelEditing()
  }

  if (shouldStepBack) {
    currentPage.value -= 1
    showSuccess(t('memory.factsDeleteSuccess'))
    return
  }

  await refreshFacts()
  showSuccess(t('memory.factsDeleteSuccess'))
}
</script>
