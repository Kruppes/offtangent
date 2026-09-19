<template>
  <Dialog :open="open" @update:open="value => !value && emit('close')">
    <DialogContent class="max-w-3xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Badge :variant="statusVariant(entry?.status)">
            {{ entry ? $t(`email.sentLog.status.${entry.status}`) : '' }}
          </Badge>
          <span class="truncate">{{ entry?.subject || $t('email.sentLog.noSubject') }}</span>
        </DialogTitle>
        <DialogDescription>
          {{ entry ? `${entry.accountName} · ${formatDateTime(entry.createdAt)}` : '' }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="entry" class="max-h-[60vh] space-y-4 overflow-y-auto pr-1 text-sm">
        <Alert v-if="entry.errorMessage" variant="destructive">
          <AlertDescription>{{ entry.errorMessage }}</AlertDescription>
        </Alert>

        <div v-if="entry.reason" class="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {{ entry.reason }}
        </div>

        <p v-if="decisionKey" class="text-xs text-muted-foreground">
          {{ $t(decisionKey, { user: entry.decidedBy }) }}
          <span v-if="entry.decidedAt"> · {{ formatDateTime(entry.decidedAt) }}</span>
        </p>

        <dl class="grid gap-2">
          <div v-for="field in recipientFields" :key="field.label" class="grid grid-cols-[4rem_1fr] gap-2">
            <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ field.label }}</dt>
            <dd class="break-all">{{ field.value }}</dd>
          </div>
        </dl>

        <div v-if="entry.attachments.length > 0">
          <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {{ $t('email.sentLog.attachments') }}
          </h3>
          <ul class="space-y-1">
            <li
              v-for="attachment in entry.attachments"
              :key="attachment.filename"
              class="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5"
            >
              <AppIcon name="paperclip" class="h-4 w-4 shrink-0 text-muted-foreground" />
              <span class="truncate">{{ attachment.filename }}</span>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ formatBytes(attachment.size) }}</span>
            </li>
          </ul>
        </div>

        <div>
          <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {{ $t('email.sentLog.body') }}
          </h3>
          <pre class="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-sans text-sm">{{ entry.bodyText }}</pre>
        </div>

        <div v-if="entry.bodyHtml">
          <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {{ $t('email.sentLog.bodyHtml') }}
          </h3>
          <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">{{ entry.bodyHtml }}</pre>
        </div>
      </div>

      <DialogFooter>
        <template v-if="entry?.status === 'pending'">
          <Button variant="outline" :disabled="deciding" @click="emit('decide', 'reject')">
            {{ $t('email.sentLog.actions.reject') }}
          </Button>
          <Button :disabled="deciding" @click="emit('decide', 'approve')">
            {{ $t('email.sentLog.actions.approve') }}
          </Button>
        </template>
        <Button
          v-else-if="entry?.status === 'failed'"
          variant="outline"
          :disabled="deciding"
          @click="emit('decide', 'retry')"
        >
          {{ $t('email.sentLog.actions.retry') }}
        </Button>
        <Button variant="outline" @click="emit('close')">{{ $t('common.close') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import type { EmailSendLogDecision, EmailSendLogEntry } from '~/api/email'
import { decisionLabelKey, formatBytes, formatDateTime, statusVariant } from '../sendLogFormat'

const props = defineProps<{ open: boolean; entry: EmailSendLogEntry | null; deciding?: boolean }>()
const emit = defineEmits<{ close: []; decide: [action: EmailSendLogDecision] }>()

const { t } = useI18n()

const decisionKey = computed(() => decisionLabelKey(props.entry))

const recipientFields = computed(() => {
  const entry = props.entry
  if (!entry) return []

  return ([
    ['to', entry.to],
    ['cc', entry.cc],
    ['bcc', entry.bcc],
  ] as const)
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => ({ label: t(`email.sentLog.${key}`), value: list.join(', ') }))
})
</script>
