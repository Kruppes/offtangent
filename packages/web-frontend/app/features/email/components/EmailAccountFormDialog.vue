<template>
  <Dialog :open="open" @update:open="$emit('close')">
    <DialogContent class="max-w-2xl max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? $t('email.createTitle') : $t('email.editTitle') }}</DialogTitle>
        <DialogDescription>
          {{ mode === 'create' ? $t('email.createDescription') : $t('email.editDescription') }}
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-6" @submit.prevent="onSubmit">
        <div class="space-y-2">
          <Label for="email-name">{{ $t('email.form.name') }}</Label>
          <Input id="email-name" v-model="form.name" :placeholder="$t('email.form.namePlaceholder')" required />
        </div>

        <!-- IMAP -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.imapSection') }}</h3>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div class="space-y-2 sm:col-span-2">
              <Label for="email-imap-host">{{ $t('email.form.host') }}</Label>
              <Input id="email-imap-host" v-model="form.imapHost" placeholder="127.0.0.1" required />
            </div>
            <div class="space-y-2">
              <Label for="email-imap-port">{{ $t('email.form.port') }}</Label>
              <Input id="email-imap-port" v-model="form.imapPort" type="number" min="1" max="65535" required />
            </div>
            <div class="space-y-2">
              <Label for="email-imap-security">{{ $t('email.form.security') }}</Label>
              <Select v-model="form.imapSecurity">
                <SelectTrigger id="email-imap-security">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="opt in securityOptions" :key="opt" :value="opt">
                    {{ $t(`email.form.securityOption.${opt}`) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="email-imap-user">{{ $t('email.form.user') }}</Label>
              <Input id="email-imap-user" v-model="form.imapUser" autocomplete="off" required />
            </div>
            <div class="space-y-2">
              <Label for="email-imap-password">{{ $t('email.form.password') }}</Label>
              <Input
                id="email-imap-password"
                v-model="form.imapPassword"
                type="password"
                autocomplete="new-password"
                :placeholder="account?.imapPasswordSet ? $t('email.form.passwordKeep') : ''"
                :required="mode === 'create'"
              />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" :disabled="connection.testing.value !== null" @click="connection.testConnection(connectionPayload(), 'imap')">
              {{ connection.testing.value === 'imap' ? $t('email.form.testing') : $t('email.form.testImap') }}
            </Button>
            <p v-if="connection.testResult.value?.imap?.ok" class="text-sm text-emerald-600">
              {{ $t('email.form.testImapSuccess') }}
            </p>
            <p v-else-if="connection.testResult.value?.imap?.error" class="text-sm text-destructive">
              {{ connection.testResult.value.imap.error }}
            </p>
          </div>
        </section>

        <!-- SMTP -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.smtpSection') }}</h3>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div class="space-y-2 sm:col-span-2">
              <Label for="email-smtp-host">{{ $t('email.form.host') }}</Label>
              <Input id="email-smtp-host" v-model="form.smtpHost" placeholder="127.0.0.1" required />
            </div>
            <div class="space-y-2">
              <Label for="email-smtp-port">{{ $t('email.form.port') }}</Label>
              <Input id="email-smtp-port" v-model="form.smtpPort" type="number" min="1" max="65535" required />
            </div>
            <div class="space-y-2">
              <Label for="email-smtp-security">{{ $t('email.form.security') }}</Label>
              <Select v-model="form.smtpSecurity">
                <SelectTrigger id="email-smtp-security">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="opt in securityOptions" :key="opt" :value="opt">
                    {{ $t(`email.form.securityOption.${opt}`) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.sameCredentials" type="checkbox" class="h-4 w-4">
            {{ $t('email.form.sameCredentials') }}
          </label>
          <div v-if="!form.sameCredentials" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="email-smtp-user">{{ $t('email.form.user') }}</Label>
              <Input id="email-smtp-user" v-model="form.smtpUser" autocomplete="off" required />
            </div>
            <div class="space-y-2">
              <Label for="email-smtp-password">{{ $t('email.form.password') }}</Label>
              <Input
                id="email-smtp-password"
                v-model="form.smtpPassword"
                type="password"
                autocomplete="new-password"
                :placeholder="account?.smtpPasswordSet ? $t('email.form.passwordKeep') : ''"
                :required="mode === 'create'"
              />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" :disabled="connection.testing.value !== null" @click="connection.testConnection(connectionPayload(), 'smtp')">
              {{ connection.testing.value === 'smtp' ? $t('email.form.testing') : $t('email.form.testSmtp') }}
            </Button>
            <p v-if="connection.testResult.value?.smtp?.ok" class="text-sm text-emerald-600">
              {{ $t('email.form.testSmtpSuccess') }}
            </p>
            <p v-else-if="connection.testResult.value?.smtp?.error" class="text-sm text-destructive">
              {{ connection.testResult.value.smtp.error }}
            </p>
          </div>
          <p v-if="connection.testError.value" class="text-sm text-destructive">
            {{ connection.testError.value }}
          </p>
        </section>

        <!-- Folder restriction -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.foldersSection') }}</h3>
          <p class="text-xs text-muted-foreground">{{ $t('email.form.foldersHelp') }}</p>
          <div class="space-y-2">
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.folderMode" type="radio" value="all" class="h-4 w-4">
              {{ $t('email.form.folderModeAll') }}
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input v-model="form.folderMode" type="radio" value="selected" class="h-4 w-4">
              {{ $t('email.form.folderModeSelected') }}
            </label>
          </div>

          <div v-if="form.folderMode === 'selected'" class="space-y-2 rounded-md border border-border p-3">
            <div class="flex items-center gap-3">
              <Button type="button" size="sm" variant="outline" :disabled="connection.foldersLoading.value" @click="onLoadFolders">
                {{ connection.foldersLoading.value ? $t('email.form.loadingFolders') : $t('email.form.loadFolders') }}
              </Button>
              <p v-if="connection.foldersError.value" class="text-sm text-destructive">
                {{ connection.foldersError.value }}
              </p>
            </div>
            <div v-if="folderOptions.length" class="max-h-52 space-y-1 overflow-y-auto">
              <label v-for="folder in folderOptions" :key="folder" class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  class="h-4 w-4"
                  :checked="form.allowedFolders.includes(folder)"
                  @change="toggleFolder(folder)"
                >
                <span class="truncate">{{ folder }}</span>
              </label>
            </div>
            <p v-else-if="!connection.foldersLoading.value" class="text-xs text-muted-foreground">
              {{ $t('email.form.noFoldersLoaded') }}
            </p>
          </div>
        </section>

        <!-- Permissions -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.permissionsSection') }}</h3>
          <div
            v-for="flag in permissionFlags"
            :key="flag.key"
            class="flex items-start justify-between gap-4 py-1"
          >
            <div class="min-w-0">
              <p class="text-sm">{{ $t(`email.form.${flag.key}`) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t(`email.form.${flag.key}Help`) }}</p>
            </div>
            <Switch :checked="form[flag.key]" @update:checked="(val: boolean) => (form[flag.key] = val)" />
          </div>
        </section>

        <!-- Allowlist -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.allowlistSection') }}</h3>
          <p class="text-xs text-muted-foreground">{{ $t('email.form.allowlistHelp') }}</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-2">
              <Label for="email-allowlist-addresses">{{ $t('email.form.allowlistAddresses') }}</Label>
              <textarea
                id="email-allowlist-addresses"
                v-model="form.allowlistAddresses"
                rows="4"
                class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="boss@example.com"
              />
            </div>
            <div class="space-y-2">
              <Label for="email-allowlist-domains">{{ $t('email.form.allowlistDomains') }}</Label>
              <textarea
                id="email-allowlist-domains"
                v-model="form.allowlistDomains"
                rows="4"
                class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="example.com"
              />
            </div>
          </div>
        </section>

        <!-- Sending options -->
        <section class="space-y-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('email.form.sendingSection') }}</h3>
          <div class="space-y-2">
            <Label for="email-display-name">{{ $t('email.form.displayName') }}</Label>
            <Input id="email-display-name" v-model="form.displayName" :placeholder="$t('email.form.displayNamePlaceholder')" />
          </div>
          <div class="space-y-2">
            <Label for="email-signature">{{ $t('email.form.signature') }}</Label>
            <textarea
              id="email-signature"
              v-model="form.signature"
              rows="3"
              class="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :placeholder="$t('email.form.signaturePlaceholder')"
            />
          </div>
          <div
            v-for="flag in sendingFlags"
            :key="flag.key"
            class="flex items-start justify-between gap-4 py-1"
          >
            <div class="min-w-0">
              <p class="text-sm">{{ $t(`email.form.${flag.key}`) }}</p>
              <p class="text-xs text-muted-foreground">{{ $t(`email.form.${flag.key}Help`) }}</p>
            </div>
            <Switch :checked="form[flag.key]" @update:checked="(val: boolean) => (form[flag.key] = val)" />
          </div>
          <div class="space-y-2">
            <Label for="email-attachment-path">{{ $t('email.form.attachmentDownloadPath') }}</Label>
            <Input id="email-attachment-path" v-model="form.attachmentDownloadPath" placeholder="email-attachments" />
            <p class="text-xs text-muted-foreground">{{ $t('email.form.attachmentDownloadPathHelp') }}</p>
          </div>
        </section>

        <DialogFooter>
          <Button type="button" variant="ghost" :disabled="loading" @click="$emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="loading">
            {{ loading ? $t('common.saving') : $t('common.save') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type {
  EmailAccount,
  EmailAccountPayload,
  EmailConnectionPayload,
  EmailFolderMode,
  EmailSecurity,
} from '~/api/email'
import { useEmailConnection } from '~/features/email/composables/useEmailConnection'

const props = defineProps<{
  open: boolean
  mode: 'create' | 'edit'
  account?: EmailAccount | null
  loading?: boolean
}>()

const connection = useEmailConnection()

const folderOptions = computed(() => {
  const loaded = connection.folders.value.map(folder => folder.path)
  return [...new Set([...loaded, ...form.allowedFolders])].sort((a, b) => a.localeCompare(b))
})

const securityOptions: EmailSecurity[] = ['ssl', 'starttls', 'none']

/** SMTP falls back to the IMAP credentials unless the user unchecks the box. */
function smtpCredentials() {
  return form.sameCredentials
    ? { user: form.imapUser.trim(), password: form.imapPassword }
    : { user: form.smtpUser.trim(), password: form.smtpPassword }
}

function connectionPayload() {
  const smtp = smtpCredentials()
  const payload: EmailConnectionPayload = {
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapUser: form.imapUser.trim(),
    imapSecurity: form.imapSecurity,
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort),
    smtpUser: smtp.user,
    smtpSecurity: form.smtpSecurity,
    allowSelfSignedCert: form.allowSelfSignedCert,
  }

  if (props.mode === 'edit' && props.account) payload.accountId = props.account.id
  if (form.imapPassword) payload.imapPassword = form.imapPassword
  if (smtp.password) payload.smtpPassword = smtp.password

  return payload
}

function onLoadFolders() {
  return connection.loadFolders(connectionPayload())
}

function toggleFolder(folder: string) {
  const index = form.allowedFolders.indexOf(folder)
  if (index === -1) form.allowedFolders.push(folder)
  else form.allowedFolders.splice(index, 1)
}

const emit = defineEmits<{
  close: []
  submit: [payload: EmailAccountPayload]
}>()

const permissionFlags = [
  { key: 'canSend' },
  { key: 'canManage' },
  { key: 'canDelete' },
  { key: 'canDownloadAttachments' },
  { key: 'requireApproval' },
  { key: 'allowSelfSignedCert' },
] as const

const sendingFlags = [
  { key: 'appendToSentFolder' },
  { key: 'allowHtml' },
] as const

function emptyForm() {
  return {
    name: '',
    imapHost: '',
    imapPort: '993',
    imapUser: '',
    imapPassword: '',
    imapSecurity: 'ssl' as EmailSecurity,
    smtpHost: '',
    smtpPort: '465',
    smtpUser: '',
    smtpPassword: '',
    smtpSecurity: 'ssl' as EmailSecurity,
    sameCredentials: true,
    allowSelfSignedCert: false,
    canSend: false,
    canManage: false,
    canDelete: false,
    canDownloadAttachments: false,
    requireApproval: false,
    allowlistAddresses: '',
    allowlistDomains: '',
    folderMode: 'all' as EmailFolderMode,
    allowedFolders: [] as string[],
    displayName: '',
    signature: '',
    appendToSentFolder: false,
    allowHtml: false,
    attachmentDownloadPath: 'email-attachments',
  }
}

const form = reactive(emptyForm())

function resetForm() {
  Object.assign(form, emptyForm())
  connection.reset()

  const account = props.account
  if (props.mode !== 'edit' || !account) return

  Object.assign(form, {
    name: account.name,
    imapHost: account.imapHost,
    imapPort: String(account.imapPort),
    imapUser: account.imapUser,
    imapPassword: '',
    imapSecurity: account.imapSecurity,
    smtpHost: account.smtpHost,
    smtpPort: String(account.smtpPort),
    smtpUser: account.smtpUser,
    smtpPassword: '',
    smtpSecurity: account.smtpSecurity,
    sameCredentials: account.smtpUser === account.imapUser,
    allowSelfSignedCert: account.allowSelfSignedCert,
    canSend: account.canSend,
    canManage: account.canManage,
    canDelete: account.canDelete,
    canDownloadAttachments: account.canDownloadAttachments,
    requireApproval: account.requireApproval,
    allowlistAddresses: account.allowlist.addresses.join('\n'),
    allowlistDomains: account.allowlist.domains.join('\n'),
    folderMode: account.folderMode,
    allowedFolders: [...account.allowedFolders],
    displayName: account.displayName,
    signature: account.signature,
    appendToSentFolder: account.appendToSentFolder,
    allowHtml: account.allowHtml,
    attachmentDownloadPath: account.attachmentDownloadPath,
  })
}

watch(() => [props.open, props.account] as const, () => {
  if (props.open) resetForm()
}, { immediate: true })

function parseList(value: string): string[] {
  return value
    .split(/[\n,;]/)
    .map(entry => entry.trim())
    .filter(Boolean)
}

function onSubmit() {
  const smtp = smtpCredentials()
  const payload: EmailAccountPayload = {
    name: form.name.trim(),
    imapHost: form.imapHost.trim(),
    imapPort: Number(form.imapPort),
    imapUser: form.imapUser.trim(),
    imapSecurity: form.imapSecurity,
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort),
    smtpUser: smtp.user,
    smtpSecurity: form.smtpSecurity,
    allowSelfSignedCert: form.allowSelfSignedCert,
    canSend: form.canSend,
    canManage: form.canManage,
    canDelete: form.canDelete,
    canDownloadAttachments: form.canDownloadAttachments,
    requireApproval: form.requireApproval,
    allowlist: {
      addresses: parseList(form.allowlistAddresses),
      domains: parseList(form.allowlistDomains),
    },
    folderMode: form.folderMode,
    allowedFolders: form.folderMode === 'selected' ? [...form.allowedFolders] : [],
    displayName: form.displayName.trim(),
    signature: form.signature,
    appendToSentFolder: form.appendToSentFolder,
    allowHtml: form.allowHtml,
    attachmentDownloadPath: form.attachmentDownloadPath.trim(),
  }

  if (form.imapPassword) payload.imapPassword = form.imapPassword
  if (smtp.password) payload.smtpPassword = smtp.password

  emit('submit', payload)
}
</script>
