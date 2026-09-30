<template>
  <!-- Admin gate -->
  <div v-if="!isAdmin" class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground">
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <!-- Page body -->
  <div v-else class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('users.title')" :subtitle="$t('users.subtitle')">
      <template #actions>
        <Button class="h-8 px-3 text-xs md:h-10 md:px-4 md:py-2 md:text-sm" @click="openCreate">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('users.addUser') }}
        </Button>
      </template>
    </PageHeader>

    <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto p-6">
      <!-- Error / success banners -->
      <Alert v-if="errorMessage" variant="destructive" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ errorMessage }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button type="button" class="ml-2 opacity-70 hover:opacity-100 transition-opacity" :aria-label="$t('aria.closeAlert')" @click="clearMessages">
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <!-- Loading state -->
      <div v-if="loading && users.length === 0" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
        {{ $t('users.loading') }}
      </div>

      <!-- Empty state -->
      <div v-else-if="users.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
        <AppIcon name="users" size="xl" class="h-10 w-10 opacity-40" />
        <p class="text-sm">{{ $t('users.empty') }}</p>
      </div>

      <!-- Users table -->
      <div v-else class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('users.columns.username') }}</TableHead>
                <TableHead>{{ $t('users.columns.role') }}</TableHead>
                <TableHead>{{ $t('users.columns.telegram') }}</TableHead>
                <TableHead>{{ $t('users.columns.createdAt') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="entry in users"
                :key="entry.id"
                class="cursor-pointer"
                @click="openEdit(entry)"
              >
                <!-- Username + avatar -->
                <TableCell>
                  <div class="flex items-center gap-3">
                    <img
                      v-if="entry.telegramId"
                      :src="getUserAvatarUrl(entry.telegramId)"
                      :alt="entry.username"
                      class="h-9 w-9 shrink-0 rounded-full object-cover"
                      @error="($event.target as HTMLImageElement).style.display = 'none'; ($event.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden')"
                    >
                    <span
                      :class="[
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary',
                        entry.telegramId ? 'hidden' : '',
                      ]"
                    >
                      {{ entry.username.slice(0, 1).toUpperCase() }}
                    </span>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-semibold text-foreground">{{ entry.username }}</span>
                        <Badge v-if="entry.id === currentUserId" variant="secondary" class="px-1.5 py-0 text-[10px]">
                          {{ $t('users.you') }}
                        </Badge>
                      </div>
                      <span class="text-xs text-muted-foreground">
                        {{ $t('users.updatedAt', { date: formatDateTime(entry.updatedAt) }) }}
                      </span>
                    </div>
                  </div>
                </TableCell>

                <!-- Role -->
                <TableCell>
                  <Badge :variant="entry.role === 'admin' ? 'warning' : 'success'">
                    {{ entry.role === 'admin' ? $t('roles.admin') : $t('roles.user') }}
                  </Badge>
                </TableCell>

                <!-- Telegram -->
                <TableCell>
                  <span v-if="entry.telegramId" class="font-mono text-xs text-foreground">{{ entry.telegramId }}</span>
                  <span v-else class="text-xs text-muted-foreground">{{ $t('users.notLinked') }}</span>
                </TableCell>

                <!-- Created -->
                <TableCell class="text-sm text-muted-foreground">
                  {{ formatDateTime(entry.createdAt) }}
                </TableCell>

                <!-- Row actions (dropdown) -->
                <TableCell class="text-right" @click.stop>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('aria.userMenu')">
                        <AppIcon name="moreVertical" class="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="openEdit(entry)">
                        <AppIcon name="edit" class="h-4 w-4" />
                        {{ $t('users.edit') }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        destructive
                        :disabled="entry.id === currentUserId"
                        @click="openDelete(entry)"
                      >
                        <AppIcon name="trash" class="h-4 w-4" />
                        {{ $t('users.delete') }}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  </div>

  <!-- Add / Edit dialog -->
  <UserFormDialog
    :open="showModal"
    :mode="formMode"
    :user="editingUser"
    :loading="actionPending"
    @close="closeModal"
    @submit="handleSubmit"
  />

  <!-- Delete confirmation dialog -->
  <ConfirmDialog
    :open="!!deleteTarget"
    :title="$t('users.delete')"
    :description="$t('users.deleteConfirm', { username: deleteTarget?.username ?? '' })"
    :confirm-label="$t('users.delete')"
    :loading="actionPending"
    destructive
    @confirm="handleDelete"
    @cancel="deleteTarget = null"
  />
</template>

<script setup lang="ts">
import type { User } from '~/composables/useUsers'

const { t } = useI18n()
const { formatDateTime } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const currentUserId = computed(() => user.value?.id ?? -1)

const { users, loading, error, fetchUsers, createUser, updateUser, deleteUser } = useUsers()

/* ── Modal state ── */
const showModal = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingUser = ref<User | null>(null)
const deleteTarget = ref<User | null>(null)
const actionPending = ref(false)
const successMessage = ref<string | null>(null)
const localError = ref<string | null>(null)

const errorMessage = computed(() => localError.value || error.value)

onMounted(async () => {
  if (!isAdmin.value) return
  await fetchUsers()
})

/* ── Avatar ── */
function getUserAvatarUrl(telegramId: string): string {
  const config = useRuntimeConfig()
  const { getAccessToken } = useAuth()
  const token = getAccessToken()
  return `${config.public.apiBase}/api/telegram-users/avatar-by-telegram-id/${telegramId}${token ? `?token=${token}` : ''}`
}

/* ── Helpers ── */
function clearMessages() {
  localError.value = null
  successMessage.value = null
  error.value = null
}

function autoHideSuccess() {
  setTimeout(() => { successMessage.value = null }, 3000)
}

/* ── Create / Edit ── */
function openCreate() {
  clearMessages()
  formMode.value = 'create'
  editingUser.value = null
  showModal.value = true
}

function openEdit(entry: User) {
  clearMessages()
  formMode.value = 'edit'
  editingUser.value = entry
  showModal.value = true
}

function closeModal() {
  showModal.value = false
  editingUser.value = null
}

async function handleSubmit(payload: { username: string; password: string; role: string }) {
  clearMessages()
  actionPending.value = true

  let success = false
  if (formMode.value === 'create') {
    success = await createUser(payload.username, payload.password, payload.role)
    if (success) successMessage.value = t('users.createSuccess')
  } else if (editingUser.value) {
    const updates: { role?: string; password?: string } = { role: payload.role }
    if (payload.password.trim()) updates.password = payload.password.trim()
    success = await updateUser(editingUser.value.id, updates)
    if (success) successMessage.value = t('users.updateSuccess')
  }

  if (!success) {
    localError.value = error.value || t('common.saveFailed')
  } else {
    closeModal()
    autoHideSuccess()
  }

  actionPending.value = false
}

/* ── Delete ── */
function openDelete(entry: User) {
  clearMessages()
  deleteTarget.value = entry
}

async function handleDelete() {
  if (!deleteTarget.value) return
  clearMessages()
  actionPending.value = true

  const success = await deleteUser(deleteTarget.value.id)
  if (success) {
    successMessage.value = t('users.deleteSuccess')
    deleteTarget.value = null
    autoHideSuccess()
  } else {
    localError.value = error.value || t('common.deleteFailed')
  }

  actionPending.value = false
}
</script>
