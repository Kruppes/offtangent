<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
    <Alert v-if="error" variant="destructive" class="shrink-0">
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

    <div class="shrink-0 space-y-3 rounded-xl border border-border bg-card p-3">
      <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <Input
          v-model="filters.search"
          :placeholder="$t('email.sentLog.filters.search')"
          @keyup.enter="fetchEntries"
        />
        <Input
          v-model="filters.recipient"
          :placeholder="$t('email.sentLog.filters.recipient')"
          @keyup.enter="fetchEntries"
        />
        <select
          v-model="filters.accountId"
          class="h-9 rounded-md border border-input bg-background px-3 text-sm"
          :aria-label="$t('email.sentLog.filters.account')"
          @change="fetchEntries"
        >
          <option value="">{{ $t('email.sentLog.filters.allAccounts') }}</option>
          <option v-for="account in knownAccounts" :key="account.id" :value="account.id">
            {{ account.name }}
          </option>
        </select>
        <Input v-model="filters.dateFrom" type="date" :aria-label="$t('email.sentLog.filters.dateFrom')" @change="fetchEntries" />
        <Input v-model="filters.dateTo" type="date" :aria-label="$t('email.sentLog.filters.dateTo')" @change="fetchEntries" />
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <button
          v-for="status in EMAIL_SEND_LOG_STATUSES"
          :key="status"
          type="button"
          class="rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors"
          :class="filters.status.includes(status)
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-border text-muted-foreground hover:bg-muted'"
          :aria-pressed="filters.status.includes(status)"
          @click="toggleStatus(status)"
        >
          {{ $t(`email.sentLog.status.${status}`) }}
        </button>

        <div class="ml-auto flex items-center gap-2">
          <span class="text-xs text-muted-foreground">{{ $t('email.sentLog.count', { count: total }) }}</span>
          <Button variant="outline" size="sm" @click="fetchEntries">
            <AppIcon name="refresh" class="mr-1 h-4 w-4" />
            {{ $t('common.refresh') }}
          </Button>
          <Button v-if="hasActiveFilters" variant="ghost" size="sm" @click="resetFilters">
            {{ $t('email.sentLog.filters.reset') }}
          </Button>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="loading && entries.length === 0" class="py-16 text-center text-sm text-muted-foreground">
        {{ $t('common.loading') }}
      </div>

      <div v-else-if="entries.length === 0" class="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
        <AppIcon name="send" size="xl" class="opacity-40" />
        <p class="text-sm">{{ hasActiveFilters ? $t('email.sentLog.noResults') : $t('email.sentLog.empty') }}</p>
      </div>

      <div v-else class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="w-28">{{ $t('email.sentLog.columns.status') }}</TableHead>
                <TableHead>{{ $t('email.sentLog.columns.recipients') }}</TableHead>
                <TableHead>{{ $t('email.sentLog.columns.subject') }}</TableHead>
                <TableHead class="w-32">{{ $t('email.sentLog.columns.account') }}</TableHead>
                <TableHead class="w-44">{{ $t('email.sentLog.columns.createdAt') }}</TableHead>
                <TableHead class="w-52">{{ $t('email.sentLog.columns.decision') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow
                v-for="entry in entries"
                :key="entry.id"
                class="cursor-pointer"
                @click="selected = entry"
              >
                <TableCell>
                  <Badge :variant="statusVariant(entry.status)" class="text-[10px]">
                    {{ $t(`email.sentLog.status.${entry.status}`) }}
                  </Badge>
                </TableCell>
                <TableCell class="max-w-xs truncate text-xs">{{ recipientSummary(entry) }}</TableCell>
                <TableCell>
                  <div class="flex items-center gap-1.5">
                    <span class="truncate">{{ entry.subject || $t('email.sentLog.noSubject') }}</span>
                    <AppIcon
                      v-if="entry.attachments.length > 0"
                      name="paperclip"
                      class="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                  </div>
                </TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ entry.accountName }}</TableCell>
                <TableCell class="text-xs text-muted-foreground">{{ formatDateTime(entry.createdAt) }}</TableCell>
                <TableCell @click.stop>
                  <div v-if="entry.status === 'pending'" class="flex gap-1.5">
                    <Button size="sm" :disabled="decidingId === entry.id" @click="decide(entry.id, 'approve')">
                      {{ $t('email.sentLog.actions.approve') }}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      :disabled="decidingId === entry.id"
                      @click="decide(entry.id, 'reject')"
                    >
                      {{ $t('email.sentLog.actions.reject') }}
                    </Button>
                  </div>
                  <Button
                    v-else-if="entry.status === 'failed'"
                    size="sm"
                    variant="outline"
                    :disabled="decidingId === entry.id"
                    @click="decide(entry.id, 'retry')"
                  >
                    <AppIcon name="refresh" class="mr-1 h-4 w-4" />
                    {{ $t('email.sentLog.actions.retry') }}
                  </Button>
                  <span v-else-if="decisionLabelKey(entry)" class="text-xs text-muted-foreground">
                    {{ $t(decisionLabelKey(entry)!, { user: entry.decidedBy }) }}
                  </span>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        <div v-if="hasMore" class="border-t border-border p-3 text-center">
          <Button variant="outline" size="sm" :disabled="loading" @click="loadMore">
            {{ $t('email.sentLog.loadMore') }}
          </Button>
        </div>
      </div>
    </div>

    <EmailSendLogDetailDialog
      :open="!!selected"
      :entry="selected"
      :deciding="decidingId === selected?.id"
      @close="selected = null"
      @decide="action => selected && decide(selected.id, action)"
    />
  </div>
</template>

<script setup lang="ts">
import type { EmailSendLogEntry } from '~/api/email'
import { EMAIL_SEND_LOG_STATUSES } from '~/api/email'
import { useEmailSendLog } from '../composables/useEmailSendLog'
import { decisionLabelKey, formatDateTime, statusVariant } from '../sendLogFormat'
import EmailSendLogDetailDialog from './EmailSendLogDetailDialog.vue'

const {
  entries,
  total,
  loading,
  error,
  filters,
  knownAccounts,
  hasMore,
  hasActiveFilters,
  decidingId,
  decide,
  fetchEntries,
  loadMore,
  resetFilters,
  toggleStatus,
} = useEmailSendLog()

const selected = ref<EmailSendLogEntry | null>(null)

watch(entries, list => {
  if (!selected.value) return
  selected.value = list.find(entry => entry.id === selected.value!.id) ?? selected.value
})

onMounted(fetchEntries)

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [filters.value.search, filters.value.recipient], () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(fetchEntries, 300)
})

onUnmounted(() => clearTimeout(searchTimer))

function recipientSummary(entry: EmailSendLogEntry): string {
  return [...entry.to, ...entry.cc, ...entry.bcc].join(', ')
}
</script>
