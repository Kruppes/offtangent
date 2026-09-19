<template>
  <!-- Admin gate -->
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="opacity-50" />
    <h1 class="text-lg font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="max-w-xs text-sm">{{ $t('admin.description') }}</p>
  </div>

  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('cronjobs.pageTitle')" :subtitle="$t('cronjobs.pageSubtitle')">
      <template #actions>
        <Button class="h-8 gap-2 px-3 text-xs md:h-10 md:px-4 md:py-2 md:text-sm" @click="openCreateCronjob">
          <AppIcon name="add" class="h-4 w-4" />
          {{ $t('cronjobs.create') }}
        </Button>
      </template>
    </PageHeader>

    <div class="flex-shrink-0 border-b border-border px-3 py-2 md:px-5 md:py-3">
      <div class="flex items-center gap-2 md:hidden">
        <Popover>
          <PopoverTrigger as-child>
            <Button variant="outline" class="flex-1 justify-start gap-2">
              <AppIcon name="filter" size="sm" />
              {{ $t('cronjobs.filters.button') }}
              <Badge v-if="activeFilterCount > 0" variant="default" class="ml-auto px-1.5 py-0 text-[10px]">
                {{ activeFilterCount }}
              </Badge>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" class="flex w-[calc(100vw-1.5rem)] max-w-sm flex-col gap-2">
            <CronjobFilterFields
              v-model:search="filters.search"
              v-model:enabled="filters.enabled"
              v-model:action-type="filters.actionType"
              v-model:provider="filters.provider"
              v-model:last-run-status="filters.lastRunStatus"
              v-model:schedule-type="filters.scheduleType"
              :has-default-provider-option="hasDefaultProviderOption"
              :provider-options="providerOptions"
            />
          </PopoverContent>
        </Popover>

        <Button
          variant="outline"
          size="icon"
          :disabled="loading"
          :title="$t('tasks.refresh')"
          @click="loadCronjobs"
        >
          <AppIcon name="refresh" size="sm" />
        </Button>
      </div>

      <div class="hidden flex-col gap-2 md:flex lg:flex-row lg:items-center">
        <div class="flex flex-1 flex-wrap items-center gap-2">
          <CronjobFilterFields
            v-model:search="filters.search"
            v-model:enabled="filters.enabled"
            v-model:action-type="filters.actionType"
            v-model:provider="filters.provider"
            v-model:last-run-status="filters.lastRunStatus"
            v-model:schedule-type="filters.scheduleType"
            :has-default-provider-option="hasDefaultProviderOption"
            :provider-options="providerOptions"
          />
        </div>

        <Button variant="outline" :disabled="loading" class="gap-2" @click="loadCronjobs">
          <AppIcon name="refresh" class="h-4 w-4" />
          {{ $t('tasks.refresh') }}
        </Button>
      </div>
    </div>

    <div class="flex flex-1 flex-col overflow-y-auto">
      <!-- Error banner -->
      <Alert v-if="error" variant="destructive" class="m-4 mb-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ error }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="error = null"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Success banner -->
      <Alert v-if="success" variant="success" class="m-4 mb-0">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ success }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearSuccess"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading skeleton -->
      <div v-if="loading && cronjobs.length === 0" class="space-y-3 p-6">
        <Skeleton v-for="i in 3" :key="i" class="h-14 rounded-lg" />
      </div>

      <!-- Empty state -->
      <div
        v-else-if="cronjobs.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
      >
        <AppIcon name="calendar" size="xl" class="opacity-40" />
        <h2 class="text-base font-semibold text-foreground">{{ $t('cronjobs.emptyTitle') }}</h2>
        <p class="max-w-md text-sm text-muted-foreground">{{ $t('cronjobs.emptyDescription') }}</p>
        <Button class="mt-2 gap-2" @click="openCreateCronjob">
          <AppIcon name="add" class="h-4 w-4" />
          {{ $t('cronjobs.create') }}
        </Button>
      </div>

      <!-- No filter matches -->
      <div
        v-else-if="filteredCronjobs.length === 0"
        class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center"
      >
        <AppIcon name="filter" size="xl" class="opacity-40" />
        <h2 class="text-base font-semibold text-foreground">{{ $t('cronjobs.noFilterMatchesTitle') }}</h2>
        <p class="max-w-md text-sm text-muted-foreground">{{ $t('cronjobs.noFilterMatchesDescription') }}</p>
        <Button variant="outline" class="mt-2" @click="resetFilters">
          {{ $t('cronjobs.filters.reset') }}
        </Button>
      </div>

      <template v-else>
        <!-- Mobile card list -->
        <div class="flex flex-col gap-2 p-3 md:hidden">
          <CronjobListCard
            v-for="cj in filteredCronjobs"
            :key="cj.id"
            :cronjob="cj"
            :provider-label="providerLabel(cj)"
            @edit="openEditCronjob(cj)"
            @trigger="handleTrigger(cj)"
            @delete="confirmDeleteCronjob(cj)"
            @toggle="(val) => handleToggle(cj.id, val)"
          />
        </div>

        <!-- Desktop table -->
        <div class="hidden overflow-x-auto md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ $t('cronjobs.columns.name') }}</TableHead>
                <TableHead>{{ $t('cronjobs.columns.schedule') }}</TableHead>
                <TableHead>{{ $t('cronjobs.columns.actionType') }}</TableHead>
                <TableHead>{{ $t('cronjobs.columns.provider') }}</TableHead>
                <TableHead>{{ $t('cronjobs.columns.enabled') }}</TableHead>
                <TableHead>{{ $t('cronjobs.columns.lastRun') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="cj in filteredCronjobs"
                :key="cj.id"
                class="cursor-pointer"
                @click="openEditCronjob(cj)"
              >
                <TableCell class="max-w-[260px] font-medium">
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="truncate">{{ cj.name }}</span>
                    <Badge v-if="cj.toolsOverride" variant="outline" class="shrink-0 text-xs">
                      {{ $t('cronjobs.badges.customTools') }}
                    </Badge>
                    <Badge v-if="cj.skillsOverride" variant="outline" class="shrink-0 text-xs">
                      {{ $t('cronjobs.badges.customSkills') }}
                    </Badge>
                    <Badge v-if="cj.systemPromptOverride" variant="outline" class="shrink-0 text-xs">
                      {{ $t('cronjobs.badges.customPrompt') }}
                    </Badge>
                  </div>
                  <div v-if="cj.attachedSkills?.length" class="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge
                      v-for="skill in cj.attachedSkills"
                      :key="`attached-${skill}`"
                      variant="secondary"
                      class="shrink-0 text-xs font-normal"
                      :title="$t('cronjobs.badges.attachedSkillTooltip', { name: skill })"
                    >
                      📎 {{ skill }}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <div class="flex flex-col">
                    <span class="text-sm">{{ cj.scheduleHuman }}</span>
                    <span class="font-mono text-xs text-muted-foreground">{{ cj.schedule }}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge :variant="cj.actionType === 'injection' ? 'warning' : 'default'">
                    {{ cj.actionType === 'injection' ? $t('cronjobs.actionTypeInjection') : $t('cronjobs.actionTypeTask') }}
                  </Badge>
                </TableCell>
                <TableCell class="text-muted-foreground">
                  {{ cj.actionType === 'injection' ? '—' : providerLabel(cj) }}
                </TableCell>
                <TableCell @click.stop>
                  <Switch
                    :checked="cj.enabled"
                    @update:checked="(val: boolean) => handleToggle(cj.id, val)"
                  />
                </TableCell>
                <TableCell>
                  <div v-if="cj.lastRunAt" class="flex flex-col gap-1">
                    <div class="flex items-center gap-1.5">
                      <Badge :variant="cronjobLastRunVariant(cj.lastRunStatus)">
                        {{ cj.lastRunStatus ?? '—' }}
                      </Badge>
                    </div>
                    <span class="text-xs text-muted-foreground">{{ formatTimestamp(cj.lastRunAt) }}</span>
                  </div>
                  <span v-else class="text-sm text-muted-foreground">—</span>
                </TableCell>
                <TableCell @click.stop>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button variant="ghost" size="sm" class="h-8 w-8 p-0">
                        <AppIcon name="moreVertical" size="sm" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="openEditCronjob(cj)">
                        <AppIcon name="edit" size="sm" class="mr-2" />
                        {{ $t('common.edit') }}
                      </DropdownMenuItem>
                      <DropdownMenuItem @click="handleTrigger(cj)">
                        <AppIcon name="send" size="sm" class="mr-2" />
                        {{ $t('cronjobs.runNow') }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive @click="confirmDeleteCronjob(cj)">
                        <AppIcon name="trash" size="sm" class="mr-2" />
                        {{ $t('common.delete') }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </template>
    </div>

    <!-- Cronjob form dialog -->
    <CronjobFormDialog
      :open="cronjobDialog.open"
      :mode="cronjobDialog.mode"
      :cronjob="cronjobDialog.cronjob"
      :loading="cronjobDialog.loading"
      @close="cronjobDialog.open = false"
      @submit="handleCronjobSubmit"
    />

    <!-- Delete cronjob confirmation -->
    <ConfirmDialog
      :open="deleteCronjobDialog.open"
      :title="$t('cronjobs.deleteConfirmTitle')"
      :description="$t('cronjobs.deleteConfirmDescription')"
      :confirm-label="$t('common.delete')"
      :loading="deleteCronjobDialog.loading"
      destructive
      @confirm="executeDeleteCronjob"
      @cancel="deleteCronjobDialog.open = false"
    />
  </div>
</template>

<script setup lang="ts">
import type { Cronjob, CronjobFormData } from '~/composables/useCronjobs'
import CronjobFilterFields from '~/features/cronjobs/components/CronjobFilterFields.vue'
import { useCronjobFilters } from '~/features/cronjobs/composables/useCronjobFilters'
import CronjobListCard from '~/features/cronjobs/components/CronjobListCard.vue'
import { cronjobLastRunVariant } from '~/features/cronjobs/utils/cronjobFormat'
import { formatCronjobProvider } from '~/features/cronjobs/utils/providerValue'

const { t } = useI18n()
const { formatTimestamp } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const { providers, fetchProviders } = useProviders()

function providerLabel(cj: Cronjob): string {
  return formatCronjobProvider(cj.provider, providers.value) || t('cronjobs.defaultProvider')
}

// === Cronjobs ===
const {
  cronjobs,
  loading,
  error,
  success,
  loadCronjobs,
  createCronjob,
  updateCronjob,
  deleteCronjob,
  toggleCronjob,
  triggerCronjob,
  clearSuccess,
} = useCronjobs()

const {
  filters,
  activeFilterCount,
  hasDefaultProviderOption,
  providerOptions,
  filteredCronjobs,
  resetFilters,
} = useCronjobFilters(cronjobs, providers)

// Create/Edit dialog
const cronjobDialog = reactive({
  open: false,
  mode: 'create' as 'create' | 'edit',
  cronjob: null as Cronjob | null,
  loading: false,
})

function openCreateCronjob() {
  cronjobDialog.mode = 'create'
  cronjobDialog.cronjob = null
  cronjobDialog.open = true
}

function openEditCronjob(cj: Cronjob) {
  cronjobDialog.mode = 'edit'
  cronjobDialog.cronjob = cj
  cronjobDialog.open = true
}

async function handleCronjobSubmit(form: CronjobFormData) {
  cronjobDialog.loading = true
  const result = cronjobDialog.mode === 'create' || !cronjobDialog.cronjob
    ? await createCronjob(form)
    : await updateCronjob(cronjobDialog.cronjob.id, form)
  cronjobDialog.loading = false
  if (result) cronjobDialog.open = false
}

async function handleToggle(id: string, enabled: boolean) {
  await toggleCronjob(id, enabled)
}

async function handleTrigger(cj: Cronjob) {
  const result = await triggerCronjob(cj.id)
  if (result) {
    success.value = t('cronjobs.triggerSuccess', { name: cj.name })
    setTimeout(() => clearSuccess(), 3000)
  }
}

// Delete dialog
const deleteCronjobDialog = reactive({
  open: false,
  loading: false,
  cronjobId: null as string | null,
})

function confirmDeleteCronjob(cj: Cronjob) {
  deleteCronjobDialog.cronjobId = cj.id
  deleteCronjobDialog.open = true
}

async function executeDeleteCronjob() {
  if (!deleteCronjobDialog.cronjobId) return
  deleteCronjobDialog.loading = true
  await deleteCronjob(deleteCronjobDialog.cronjobId)
  deleteCronjobDialog.loading = false
  deleteCronjobDialog.open = false
  deleteCronjobDialog.cronjobId = null
}

onMounted(async () => {
  if (!isAdmin.value) return
  await Promise.all([loadCronjobs(), fetchProviders()])
})
</script>
