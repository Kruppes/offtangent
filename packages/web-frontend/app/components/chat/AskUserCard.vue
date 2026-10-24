<template>
  <!-- ask_user card (S1-C). The state comes from the `interactions` row;
       only an open card is operable. 2 to 4 questions form a wizard with ONE
       submit at the end. -->
  <div class="w-full max-w-xl" data-ask-user-card :data-status="card.resumePending.value ? 'resume' : (card.status.value ?? 'pending')">
    <!-- Skeleton: the tool call is running, `interaction.open` is on its way. -->
    <div
      v-if="!card.payload.value"
      class="w-full rounded-lg border border-dashed border-border bg-background px-4 py-3 text-sm text-muted-foreground"
      role="status"
      aria-busy="true"
      data-ask-user-skeleton
    >
      {{ pendingCount ? $t('chat.askUser.pendingCount', { n: pendingCount }, pendingCount) : $t('chat.askUser.pending') }}
    </div>

    <!-- Closed: answered (with the answer), dismissed, superseded, expired. -->
    <div
      v-else-if="!isOpenView"
      class="w-full overflow-hidden rounded-lg border border-border bg-background"
      role="status"
      data-ask-user-closed
    >
      <div class="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
        <p class="text-sm font-medium leading-5 text-foreground">{{ card.payload.value.question }}</p>
        <span class="shrink-0 text-xs text-muted-foreground" data-ask-user-status>{{ statusLabel }}</span>
      </div>
      <div v-if="answerRows.length" class="divide-y divide-border border-t border-border" data-ask-user-answer>
        <div v-for="item in answerRows" :key="item.key" class="flex min-h-11 items-start gap-3 px-4 py-2">
          <AppIcon name="check" class="mt-1 size-4 shrink-0 text-primary" />
          <span class="text-sm leading-5 text-foreground">
            <span v-if="answerRows.length > 1" class="text-muted-foreground">{{ item.question }}: </span>{{ item.label }}
          </span>
        </div>
      </div>
    </div>

    <!-- Open card. -->
    <div
      v-else
      class="w-full overflow-hidden rounded-lg border border-border bg-background"
      role="group"
      :aria-labelledby="headingId"
      :aria-busy="card.submitting.value ? 'true' : 'false'"
      data-ask-user-open
    >
      <div class="flex items-start justify-between gap-2 border-b border-border px-4 pb-2 pt-3">
        <div class="min-w-0">
          <p v-if="card.isWizard.value" class="text-xs text-muted-foreground" data-ask-user-progress>
            {{ $t('chat.askUser.progress', { current: card.progress.value.current, total: card.progress.value.total }) }}
          </p>
          <p :id="headingId" class="text-sm font-medium leading-5 text-foreground">{{ question?.question }}</p>
          <p v-if="question?.type === 'multi'" class="mt-1 text-xs text-muted-foreground">{{ $t('chat.interaction.multiHint') }}</p>
        </div>
        <button
          type="button"
          class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:text-border"
          :aria-label="$t('chat.askUser.dismiss')"
          :title="$t('chat.askUser.dismiss')"
          :disabled="card.submitting.value || card.resumePending.value"
          data-ask-user-dismiss
          @click="card.dismiss()"
        >
          <AppIcon name="close" class="size-4" />
        </button>
      </div>

      <template v-if="question">
        <!-- confirm: two buttons side by side. -->
        <div v-if="question.type === 'confirm'" class="flex flex-wrap gap-2 px-4 py-3" role="radiogroup" :aria-labelledby="headingId">
          <button
            v-for="option in question.options"
            :key="option.id"
            type="button"
            role="radio"
            :aria-checked="selectedOf(question.id).includes(option.id) ? 'true' : 'false'"
            class="min-h-11 flex-1 rounded-md border px-3 text-sm"
            :class="selectedOf(question.id).includes(option.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-foreground hover:bg-muted'"
            :data-option-id="option.id"
            @click="card.select(question.id, option.id)"
          >
            {{ option.label }}<span v-if="question.recommended === option.id" class="ml-1 text-xs" data-recommended>({{ $t('chat.askUser.recommended') }})</span>
          </button>
        </div>

        <!-- choice (radio) / multi (checkbox). -->
        <div
          v-else
          class="divide-y divide-border"
          :role="question.type === 'multi' ? 'group' : 'radiogroup'"
          :aria-labelledby="headingId"
        >
          <label
            v-for="option in question.options"
            :key="option.id"
            class="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-2 hover:bg-muted"
            :data-option-id="option.id"
          >
            <input
              :type="question.type === 'multi' ? 'checkbox' : 'radio'"
              class="mt-1 size-4 shrink-0 accent-primary"
              :name="`${headingId}-options`"
              :value="option.id"
              :checked="selectedOf(question.id).includes(option.id)"
              @change="card.select(question.id, option.id)"
            >
            <span class="min-w-0 text-sm leading-5 text-foreground">
              {{ option.label }}
              <span
                v-if="question.recommended === option.id"
                class="ml-1 rounded border border-primary px-1 text-2xs font-medium text-primary"
                data-recommended
              >{{ $t('chat.askUser.recommended') }}</span>
              <span v-if="option.description" class="block text-xs text-muted-foreground">{{ option.description }}</span>
            </span>
          </label>
        </div>

        <label v-if="question.allowComment" class="block border-t border-border px-4 py-2">
          <span class="mb-1 block text-xs text-muted-foreground">{{ $t('chat.askUser.commentPlaceholder') }}</span>
          <textarea
            class="w-full resize-y rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            rows="2"
            :maxlength="ASK_USER_COMMENT_MAX"
            :value="card.answers.value[question.id]?.comment ?? ''"
            data-ask-user-comment
            @input="card.setComment(question.id, ($event.target as HTMLTextAreaElement).value)"
          />
          <p class="text-right text-2xs text-muted-foreground">{{ (card.answers.value[question.id]?.comment ?? '').length }}/{{ ASK_USER_COMMENT_MAX }}</p>
        </label>
      </template>

      <p v-if="card.resumePending.value || card.errorMessage.value" class="border-t border-border px-4 py-2 text-xs text-destructive" role="alert" :data-ask-user-resume="card.resumePending.value ? '' : undefined">
        {{ card.resumePending.value ? $t('chat.askUser.retryHint') : card.errorMessage.value }}
      </p>

      <div class="flex items-center justify-between gap-2 border-t border-border px-4 py-2">
        <button
          v-if="card.isWizard.value"
          type="button"
          class="min-h-9 rounded-md px-3 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground"
          :disabled="card.step.value === 0"
          data-ask-user-back
          @click="card.back()"
        >
          {{ $t('chat.askUser.back') }}
        </button>
        <span v-else />
        <button
          v-if="!card.isLast.value"
          type="button"
          class="min-h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          :disabled="!card.currentComplete.value"
          data-ask-user-next
          @click="card.next()"
        >
          {{ $t('chat.askUser.next') }}
        </button>
        <button
          v-else
          type="button"
          class="min-h-9 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
          :disabled="!card.allComplete.value || card.submitting.value"
          data-ask-user-submit
          @click="card.submit()"
        >
          {{ card.resumePending.value ? $t('chat.askUser.resend') : $t('chat.interaction.sendAnswer') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, toRef } from 'vue'
import { useInteractionTable, type InteractionTableRow } from '~/composables/useInteractionTable'
import { newClientMessageId, useInteractions } from '~/composables/useInteractions'
import { ASK_USER_COMMENT_MAX, useAskUserCard } from '~/composables/chat/useAskUserCard'

const props = defineProps<{
  /** The `interactions` row of this tool call, null while it is on its way. */
  row: InteractionTableRow | null
  /** Question count announced by `interaction.pending`, null if unknown. */
  pendingCount?: number | null
}>()

const { t } = useI18n()
const { answerById, saveDraft, dismissById } = useInteractions()
const table = useInteractionTable()

// A response that carries the row updates the table right away; the socket
// frame that follows is the same row again. Not the row of a 502
// (`retryable`, review 1 B1): it says `answered` with `resumed: false`, which
// is no end state — the card stays sendable with the same key.
const card = useAskUserCard(toRef(props, 'row'), {
  answerById: async (input) => {
    const outcome = await answerById(input)
    if (outcome.status !== 'retryable' && 'interaction' in outcome && outcome.interaction) table.receive(outcome.interaction)
    return outcome
  },
  saveDraft,
  dismissById: async (id) => {
    const outcome = await dismissById(id)
    if ('interaction' in outcome && outcome.interaction) table.receive(outcome.interaction)
    return outcome
  },
  newRequestId: newClientMessageId,
  confirmDismiss: () => typeof window === 'undefined' || window.confirm(t('chat.askUser.dismissConfirm')),
})

// M3: a card that leaves the page (navigation) must not PUT its draft later.
onBeforeUnmount(() => card.cancelDraft())

const question = computed(() => card.current.value)
const headingId = computed(() => `ask-user-${props.row?.id ?? 'pending'}`)
const isOpenView = computed(() => card.status.value === 'open' || card.status.value === null || card.resumePending.value)

function selectedOf(questionId: string): string[] {
  return card.answers.value[questionId]?.selected ?? []
}

const statusLabel = computed(() => {
  switch (card.status.value) {
    case 'answered': return t('chat.askUser.status.answered')
    case 'dismissed': return t('chat.askUser.status.dismissed')
    case 'superseded': return t('chat.askUser.status.superseded')
    case 'expired': return t('chat.askUser.status.expired')
    default: return t('chat.askUser.status.open')
  }
})

/** The answer of a closed card: one row per question. */
const answerRows = computed(() => {
  const items = props.row?.answer?.items
  if (Array.isArray(items) && items.length) {
    return items.map(item => ({
      key: item.questionId,
      question: item.question ?? card.questions.value.find(q => q.id === item.questionId)?.question ?? '',
      label: [item.selected.filter(o => o.id !== 'other').map(o => o.label).join(', '), item.comment].filter(Boolean).join(' — '),
    }))
  }
  const label = props.row?.answer?.label ?? (card.status.value === 'answered' ? card.conflictLabel.value : null)
  return label ? [{ key: 'label', question: '', label }] : []
})
</script>
