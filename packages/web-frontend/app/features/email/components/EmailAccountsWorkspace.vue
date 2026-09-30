<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div class="mb-4 flex justify-end">
        <Button @click="openCreate">
          <AppIcon name="add" class="mr-1 h-4 w-4" />
          {{ $t('email.addAccount') }}
        </Button>
      </div>

      <Alert v-if="errorMessage" variant="destructive" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ errorMessage }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <Alert v-if="successMessage" variant="success" class="mb-4">
        <AlertDescription class="flex items-center justify-between">
          <span>{{ successMessage }}</span>
          <button
            type="button"
            class="ml-2 opacity-70 transition-opacity hover:opacity-100"
            :aria-label="$t('aria.closeAlert')"
            @click="clearMessages"
          >
            <AppIcon name="close" class="h-4 w-4" />
          </button>
        </AlertDescription>
      </Alert>

      <div v-if="loading && accounts.length === 0" class="flex flex-1 items-center justify-center py-20 text-sm text-muted-foreground">
        {{ $t('common.loading') }}
      </div>

      <div v-else-if="accounts.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center text-muted-foreground">
        <AppIcon name="mail" size="xl" class="opacity-40" />
        <p class="text-sm">{{ $t('email.empty') }}</p>
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('email.columns.name') }}</TableHead>
                <TableHead>{{ $t('email.columns.server') }}</TableHead>
                <TableHead>{{ $t('email.columns.permissions') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="account in accounts"
                :key="account.id"
                class="cursor-pointer"
                @click="openEdit(account)"
              >
                <TableCell>
                  <div class="font-semibold text-foreground">{{ account.name }}</div>
                  <div class="text-xs text-muted-foreground">{{ account.imapUser }}</div>
                </TableCell>
                <TableCell class="font-mono text-xs">
                  <div><span class="text-muted-foreground">IMAP:</span> {{ account.imapHost }}:{{ account.imapPort }}</div>
                  <div><span class="text-muted-foreground">SMTP:</span> {{ account.smtpHost }}:{{ account.smtpPort }}</div>
                </TableCell>
                <TableCell>
                  <div class="flex flex-wrap gap-1">
                    <Badge v-for="badge in permissionBadges(account)" :key="badge" variant="secondary" class="text-[10px]">
                      {{ $t(`email.form.${badge}`) }}
                    </Badge>
                    <span v-if="permissionBadges(account).length === 0" class="text-xs text-muted-foreground">
                      {{ $t('email.readonly') }}
                    </span>
                  </div>
                </TableCell>
                <TableCell class="text-right" @click.stop>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button variant="ghost" size="icon-sm" :aria-label="$t('email.accountMenu')">
                        <AppIcon name="moreVertical" class="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="openEdit(account)">
                        <AppIcon name="edit" class="h-4 w-4" />
                        {{ $t('common.edit') }}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive @click="deleteTarget = account">
                        <AppIcon name="trash" class="h-4 w-4" />
                        {{ $t('common.delete') }}
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

    <EmailAccountFormDialog
      :open="showDialog"
      :mode="formMode"
      :account="editingAccount"
      :loading="actionPending"
      @close="closeDialog"
      @submit="handleSubmit"
    />

    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('email.deleteTitle')"
      :description="$t('email.deleteConfirm', { name: deleteTarget?.name ?? '' })"
      :confirm-label="$t('common.delete')"
      :loading="actionPending"
      destructive
      @confirm="handleDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import type { EmailAccount, EmailAccountPayload } from '~/api/email'
import { useEmailAccounts } from '../composables/useEmailAccounts'
import EmailAccountFormDialog from './EmailAccountFormDialog.vue'

const { t } = useI18n()
const { accounts, loading, error, fetchAccounts, createAccount, updateAccount, deleteAccount } = useEmailAccounts()

const showDialog = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const editingAccount = ref<EmailAccount | null>(null)
const deleteTarget = ref<EmailAccount | null>(null)
const actionPending = ref(false)
const successMessage = ref<string | null>(null)
const localError = ref<string | null>(null)

const errorMessage = computed(() => localError.value || error.value)

onMounted(fetchAccounts)

function permissionBadges(account: EmailAccount): string[] {
  return ([
    ['canSend', account.canSend],
    ['canManage', account.canManage],
    ['canDelete', account.canDelete],
    ['canDownloadAttachments', account.canDownloadAttachments],
    ['requireApproval', account.requireApproval],
  ] as const)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
}

function clearMessages() {
  localError.value = null
  successMessage.value = null
  error.value = null
}

function autoHideSuccess() {
  setTimeout(() => { successMessage.value = null }, 3000)
}

function openCreate() {
  clearMessages()
  formMode.value = 'create'
  editingAccount.value = null
  showDialog.value = true
}

function openEdit(account: EmailAccount) {
  clearMessages()
  formMode.value = 'edit'
  editingAccount.value = account
  showDialog.value = true
}

function closeDialog() {
  showDialog.value = false
  editingAccount.value = null
}

async function handleSubmit(payload: EmailAccountPayload) {
  clearMessages()
  actionPending.value = true

  const success = formMode.value === 'create'
    ? await createAccount(payload)
    : editingAccount.value
      ? await updateAccount(editingAccount.value.id, payload)
      : false

  if (success) {
    successMessage.value = formMode.value === 'create' ? t('email.createSuccess') : t('email.updateSuccess')
    closeDialog()
    autoHideSuccess()
  } else {
    localError.value = error.value || t('common.saveFailed')
  }

  actionPending.value = false
}

async function handleDelete() {
  if (!deleteTarget.value) return
  clearMessages()
  actionPending.value = true

  if (await deleteAccount(deleteTarget.value.id)) {
    successMessage.value = t('email.deleteSuccess')
    deleteTarget.value = null
    autoHideSuccess()
  } else {
    localError.value = error.value || t('common.deleteFailed')
  }

  actionPending.value = false
}
</script>
