<template>
  <!-- Interactive block (SPEC 7.4c). Renders `confirm`, `choice` and `multi`;
       every other kind never reaches this component because the parser
       degrades it to text. The card is a sibling of the chat bubble, not a
       box inside it: one surface, one column, one row per option. -->
  <div class="w-full">
    <!-- Gone quiet: the strand or the turn behind the card no longer exists. -->
    <div
      v-if="staleReason"
      class="w-full overflow-hidden rounded-lg border border-border bg-background"
      role="status"
    >
      <p class="px-4 pb-2 pt-3 text-sm font-medium leading-snug text-foreground">{{ block.question }}</p>
      <p class="border-t border-border px-4 py-2 text-xs text-muted-foreground">{{ staleReason }}</p>
    </div>

    <!-- Answered: the question stays, only the chosen row(s) remain. -->
    <div
      v-else-if="closedRows.length > 0"
      class="w-full overflow-hidden rounded-lg border border-border bg-background"
      :class="settleClass"
      role="status"
      :aria-label="`${block.question} — ${closedAriaLabel}`"
    >
      <p class="px-4 pb-2 pt-3 text-sm font-medium leading-snug text-foreground">{{ block.question }}</p>
      <div class="divide-y divide-border border-t border-border">
        <div
          v-for="row in closedRows"
          :key="`${row.icon}-${row.label}`"
          class="flex min-h-11 w-full items-start gap-3 px-4 py-2 text-left"
        >
          <AppIcon
            :name="row.icon"
            class="mt-1 size-4 shrink-0"
            :class="row.icon === 'check' ? 'text-primary' : 'text-muted-foreground'"
          />
          <span class="text-sm leading-5 text-foreground">{{ row.label }}</span>
        </div>
      </div>
    </div>

    <!-- Open card. -->
    <div
      v-else
      class="w-full overflow-hidden rounded-lg border border-border bg-background"
      role="group"
      :aria-labelledby="questionId"
      :aria-busy="pending ? 'true' : 'false'"
    >
      <div class="border-b border-border px-4 pb-2 pt-3">
        <p :id="questionId" class="text-sm font-medium leading-snug text-foreground">{{ block.question }}</p>
        <p v-if="isMulti" class="mt-1 text-xs text-muted-foreground">{{ $t('chat.interaction.multiHint') }}</p>
      </div>

      <div
        class="divide-y divide-border"
        :role="isMulti ? undefined : 'radiogroup'"
        :aria-labelledby="isMulti ? undefined : questionId"
      >
        <button
          v-for="option in block.options"
          :key="option.id"
          type="button"
          :role="isMulti ? 'checkbox' : 'radio'"
          :aria-checked="isSelected(option.id) ? 'true' : 'false'"
          class="flex min-h-11 w-full items-start gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:cursor-not-allowed disabled:text-muted-foreground disabled:[&_svg]:text-border"
          :class="isDestructive(option)
            ? (isSelected(option.id) ? 'bg-destructive/10 text-destructive hover:bg-destructive/15 dark:bg-destructive/15 dark:hover:bg-destructive/20' : 'text-destructive hover:bg-destructive/10')
            : (isSelected(option.id) ? 'bg-selected-container text-on-selected-container hover:bg-selected-container-hover' : 'text-foreground hover:bg-muted')"
          :disabled="pending"
          @click="isMulti ? toggle(option.id) : choose(option.id)"
        >
          <span
            class="mt-1 flex size-4 shrink-0 items-center justify-center border"
            :class="[
              isMulti ? 'rounded-sm' : 'rounded-full',
              isSelected(option.id)
                ? (isDestructive(option) ? 'border-destructive bg-destructive' : 'border-primary bg-primary')
                : (isDestructive(option) ? 'border-destructive' : 'border-muted-foreground'),
            ]"
            aria-hidden="true"
          >
            <AppIcon v-if="isMulti && isSelected(option.id)" name="check" class="size-3 text-primary-foreground" />
            <span v-else-if="!isMulti && isSelected(option.id)" class="size-1.5 rounded-full bg-primary-foreground" />
          </span>
          <span class="text-sm leading-5">{{ option.label }}</span>
          <AppIcon
            v-if="pending && pendingOption === option.id"
            name="loader"
            class="ml-auto mt-1 size-4 shrink-0 motion-safe:animate-spin"
          />
        </button>
      </div>

      <!-- Own answer: the last row of the same list. -->
      <div class="border-t border-border">
        <button
          v-if="!ownAnswerOpen"
          type="button"
          class="flex min-h-11 w-full items-start gap-3 px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
          :class="multiOwnAnswer ? 'bg-selected-container hover:bg-selected-container-hover' : 'hover:bg-muted'"
          @click="multiOwnAnswer ? clearMultiOwnAnswer() : openOwnAnswer()"
        >
          <AppIcon name="edit" class="mt-1 size-4 shrink-0 text-muted-foreground" />
          <span class="text-sm leading-5 text-foreground">{{ multiOwnAnswer || $t('chat.interaction.ownAnswer') }}</span>
        </button>
        <!-- 36 px button in a 44 px row: 4 px of air on every side, and the
             inner radius is the card radius minus that inset (8 − 4 = 4 px). -->
        <div v-else class="flex items-center gap-2 pr-1">
          <!-- `:value` + `@input` instead of `v-model`: the render harness
               drives this component through a non-DOM renderer, where the
               `v-model` directive would reach for addEventListener. -->
          <input
            ref="ownAnswerInput"
            type="text"
            :value="ownAnswerText"
            @input="ownAnswerText = ($event.target as HTMLInputElement).value"
            :aria-label="$t('chat.interaction.ownAnswer')"
            :placeholder="$t('chat.interaction.ownAnswerPlaceholder')"
            class="h-11 w-full min-w-0 bg-transparent px-4 text-sm focus:outline-none"
            @keydown.enter.prevent="confirmOwnAnswer"
            @keydown.esc.prevent="cancelOwnAnswer"
          >
          <button
            type="button"
            class="inline-flex h-9 shrink-0 items-center gap-2 rounded bg-primary px-3 text-sm font-medium text-primary-foreground disabled:text-muted-foreground disabled:[&_svg]:text-border disabled:bg-muted"
            :aria-label="$t('chat.interaction.sendAnswer')"
            :disabled="ownAnswerText.trim().length === 0"
            @click="confirmOwnAnswer"
          >
            <AppIcon name="send" class="size-4" />
          </button>
        </div>
      </div>

      <div v-if="isMulti" class="flex justify-end border-t border-border px-4 py-2">
        <button
          type="button"
          class="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:[&_svg]:text-border disabled:bg-muted"
          :disabled="pending || (selected.length === 0 && !multiOwnAnswer)"
          @click="sendSelection"
        >
          <span>{{ $t('chat.interaction.sendAnswer') }}</span>
          <AppIcon v-if="pending" name="loader" class="size-4 shrink-0 motion-safe:animate-spin" />
        </button>
      </div>

      <p v-if="errorMessage" class="border-t border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive" role="alert">
        {{ errorMessage }}
        <button type="button" class="ml-1 underline underline-offset-2" @click="retry">{{ $t('common.retry') }}</button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InteractionBlock, InteractionBlockOption } from '@axiom/core/contracts'

const props = defineProps<{
  block: InteractionBlock
  /** The chat_messages row id that carries the block. */
  messageId?: number
  /** Answer restored from `chat_messages.metadata` after a reload. */
  answered?: { label: string } | null
  /**
   * A later user message exists in the strand, so the question was already
   * taken care of in the chat itself. Free text answers are ordinary
   * messages and leave no trace in `interactionAnswers`, which is why the
   * card has to read the strand to know it is done.
   */
  answeredElsewhere?: boolean
}>()

const emit = defineEmits<{
  answered: [{ blockId: string; label: string }]
  /** Free text: ChatView sends it through the ordinary composer send path. */
  ownAnswer: [text: string]
}>()

const { answerBlock, newClientMessageId } = useInteractions()
const { t } = useI18n()

const localAnswer = ref<string | null>(null)
const localAnswerIds = ref<string[] | null>(null)
const localOwnAnswer = ref<string | null>(null)
const staleReason = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const pending = ref(false)
const pendingOption = ref<string | null>(null)
const settled = ref(false)
// One key per tap: a retry of the same tap is idempotent server-side, so a
// dropped response can never produce two answers.
const clientMessageId = ref<string | null>(null)
const attemptedValue = ref<string | string[] | null>(null)
const selected = ref<string[]>([])
const ownAnswerOpen = ref(false)
const ownAnswerText = ref('')
const ownAnswerInput = ref<HTMLInputElement | null>(null)
/** Free text collected on a multi card; it travels with the send button. */
const multiOwnAnswer = ref<string | null>(null)

const isMulti = computed(() => props.block.kind === 'multi')
const questionId = computed(() => `interaction-${props.block.id}-question`)
const answeredLabel = computed(() => localAnswer.value ?? props.answered?.label ?? null)
// The one pulse from 7.4c — and nothing at all when the user asked for less
// motion (`prefers-reduced-motion`).
const settleClass = computed(() => settled.value ? 'motion-safe:animate-pulse' : '')

interface ClosedRow { icon: 'check' | 'edit'; label: string }

/**
 * The rows an answered card keeps. Option answers carry a check, a free text
 * answer carries the pencil it was written with.
 */
const closedRows = computed<ClosedRow[]>(() => {
  const rows: ClosedRow[] = []
  const label = answeredLabel.value
  if (label) {
    for (const optionLabel of optionLabelsOf(label)) rows.push({ icon: 'check', label: optionLabel })
  }
  if (localOwnAnswer.value) rows.push({ icon: 'edit', label: localOwnAnswer.value })
  if (rows.length === 0 && props.answeredElsewhere) {
    rows.push({ icon: 'edit', label: t('chat.interaction.answeredInChat') })
  }
  return rows
})

const closedAriaLabel = computed(() => closedRows.value.map(row => row.label).join(', '))

/**
 * Split a restored answer label back into its option labels. `labelOf` joins
 * with ", ", so the split is reversed only when every part is a real option —
 * otherwise the label stays one row and nothing is invented.
 */
function optionLabelsOf(label: string): string[] {
  if (localAnswerIds.value) {
    return localAnswerIds.value.map(id => props.block.options.find(option => option.id === id)?.label ?? id)
  }
  const parts = label.split(', ')
  const known = props.block.options.map(option => option.label)
  return parts.length > 1 && parts.every(part => known.includes(part)) ? parts : [label]
}

function isDestructive(option: InteractionBlockOption): boolean {
  return option.style === 'danger' || (!!props.block.destructive && option.id === 'yes')
}

function isSelected(optionId: string): boolean {
  return isMulti.value ? selected.value.includes(optionId) : pendingOption.value === optionId
}

function toggle(optionId: string) {
  if (pending.value) return
  selected.value = selected.value.includes(optionId)
    ? selected.value.filter(id => id !== optionId)
    : [...selected.value, optionId]
}

function openOwnAnswer() {
  ownAnswerOpen.value = true
  ownAnswerText.value = multiOwnAnswer.value ?? ''
  void nextTick(() => ownAnswerInput.value?.focus())
}

function cancelOwnAnswer() {
  ownAnswerOpen.value = false
  ownAnswerText.value = ''
}

function clearMultiOwnAnswer() {
  multiOwnAnswer.value = null
}

/**
 * Enter (or the send button) on the inline input. On a multi card the text
 * becomes one more selection and leaves with the send button; everywhere else
 * it goes out immediately as an ordinary chat message.
 */
function confirmOwnAnswer() {
  const text = ownAnswerText.value.trim()
  if (!text) return
  ownAnswerOpen.value = false
  ownAnswerText.value = ''
  if (isMulti.value) {
    multiOwnAnswer.value = text
    return
  }
  emit('ownAnswer', text)
  localOwnAnswer.value = text
  settled.value = true
  setTimeout(() => { settled.value = false }, 600)
}

function sendSelection() {
  const text = multiOwnAnswer.value
  if (selected.value.length === 0) {
    // Nothing to answer with `/api/interactions`; the free text alone is an
    // ordinary message, and sending it twice would resume the turn twice.
    if (!text) return
    emit('ownAnswer', text)
    multiOwnAnswer.value = null
    localOwnAnswer.value = text
    settled.value = true
    setTimeout(() => { settled.value = false }, 600)
    return
  }
  void submit([...selected.value])
}

function choose(optionId: string) {
  void submit(optionId)
}

function labelOf(value: string | string[]): string {
  const ids = Array.isArray(value) ? value : [value]
  return ids.map(id => props.block.options.find(option => option.id === id)?.label ?? id).join(', ')
}

/** Same tap, same key — an array answer compares by its ids, not by identity. */
function valueKey(value: string | string[]): string {
  return Array.isArray(value) ? value.join('\u0000') : value
}

async function submit(value: string | string[]) {
  if (pending.value || answeredLabel.value || staleReason.value) return
  if (!props.messageId) {
    // A streaming message has no row id yet; answering has to wait for the
    // turn to be persisted rather than post against nothing.
    errorMessage.value = t('chat.interaction.notReady')
    return
  }
  errorMessage.value = null
  pending.value = true
  pendingOption.value = Array.isArray(value) ? null : value
  const previous = attemptedValue.value
  if (previous === null || valueKey(previous) !== valueKey(value)) clientMessageId.value = null
  attemptedValue.value = value
  clientMessageId.value = clientMessageId.value ?? newClientMessageId()

  const outcome = await answerBlock({
    messageId: props.messageId,
    block: props.block,
    value,
    clientMessageId: clientMessageId.value,
  })

  pending.value = false
  pendingOption.value = null

  if (outcome.status === 'applied' || outcome.status === 'already_answered') {
    const label = outcome.label || labelOf(value)
    localAnswer.value = label
    localAnswerIds.value = Array.isArray(value) ? [...value] : [value]
    settled.value = true
    setTimeout(() => { settled.value = false }, 600)
    emit('answered', { blockId: props.block.id, label })
    // Free text picked up along the way rides out as its own message.
    if (multiOwnAnswer.value) {
      const text = multiOwnAnswer.value
      multiOwnAnswer.value = null
      localOwnAnswer.value = text
      emit('ownAnswer', text)
    }
    return
  }
  if (outcome.status === 'stale') {
    staleReason.value = outcome.reason || t('chat.interaction.stale')
    return
  }
  // A failed answer keeps the card open: the question is still open.
  errorMessage.value = outcome.message || t('chat.interaction.failed')
}

function retry() {
  if (attemptedValue.value) void submit(attemptedValue.value)
}
</script>
