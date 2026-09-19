<template>
  <!-- Interactive block (SPEC 7.4c). Renders `confirm` and `choice`; every
       other kind never reaches this component because the parser degrades it
       to text. An answered card collapses to a chip. -->
  <div class="my-2 w-full">
    <!-- Answered: one chip, alternatives gone. -->
    <div
      v-if="answeredLabel"
      class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-foreground"
      :class="settleClass"
      role="status"
      :aria-label="`${block.question} — ${answeredLabel}`"
    >
      <AppIcon name="check" class="h-3.5 w-3.5 shrink-0 text-primary" />
      <span class="truncate">{{ answeredLabel }}</span>
    </div>

    <!-- Gone quiet: the strand or the turn behind the card no longer exists. -->
    <div
      v-else-if="staleReason"
      class="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      role="status"
    >
      <p class="font-medium text-foreground/80">{{ block.question }}</p>
      <p class="mt-1">{{ staleReason }}</p>
    </div>

    <!-- Open card. -->
    <div
      v-else
      class="w-full overflow-hidden rounded-lg border border-border bg-muted/20"
      role="group"
      :aria-labelledby="questionId"
      :aria-busy="pending ? 'true' : 'false'"
    >
      <p :id="questionId" class="px-3 py-2 text-sm font-medium text-foreground">{{ block.question }}</p>

      <p class="px-3 pb-2 text-xs text-muted-foreground">{{ $t('chat.interaction.textAlternative') }}</p>
      <div class="flex flex-col gap-1.5 border-t border-border/60 p-2 sm:flex-row sm:flex-wrap">
        <button
          v-for="option in block.options"
          :key="option.id"
          type="button"
          class="inline-flex min-h-[44px] flex-1 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-[9rem]"
          :class="option.style === 'danger' || (block.destructive && option.id === 'yes')
            ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
            : 'border-border text-foreground hover:border-primary/40 hover:bg-primary/10'"
          :disabled="pending"
          @click="choose(option.id)"
        >
          <span class="truncate">{{ option.label }}</span>
          <AppIcon
            v-if="pending && pendingOption === option.id"
            name="loader"
            class="h-4 w-4 shrink-0 motion-safe:animate-spin"
          />
        </button>
      </div>

      <p v-if="errorMessage" class="border-t border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
        {{ errorMessage }}
        <button type="button" class="ml-1 underline underline-offset-2" @click="retry">{{ $t('common.retry') }}</button>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InteractionBlock } from '@axiom/core/contracts'

const props = defineProps<{
  block: InteractionBlock
  /** The chat_messages row id that carries the block. */
  messageId?: number
  /** Answer restored from `chat_messages.metadata` after a reload. */
  answered?: { label: string } | null
}>()

const emit = defineEmits<{ answered: [{ blockId: string; label: string }] }>()

const { answerBlock, newClientMessageId } = useInteractions()
const { t } = useI18n()

const localAnswer = ref<string | null>(null)
const staleReason = ref<string | null>(null)
const errorMessage = ref<string | null>(null)
const pending = ref(false)
const pendingOption = ref<string | null>(null)
const settled = ref(false)
// One key per tap: a retry of the same tap is idempotent server-side, so a
// dropped response can never produce two answers.
const clientMessageId = ref<string | null>(null)
const attemptedOption = ref<string | null>(null)

const questionId = computed(() => `interaction-${props.block.id}-question`)
const answeredLabel = computed(() => localAnswer.value ?? props.answered?.label ?? null)
// The one pulse from 7.4c — and nothing at all when the user asked for less
// motion (`prefers-reduced-motion`).
const settleClass = computed(() => settled.value ? 'motion-safe:animate-pulse' : '')

async function choose(optionId: string) {
  if (pending.value || answeredLabel.value || staleReason.value) return
  if (!props.messageId) {
    // A streaming message has no row id yet; answering has to wait for the
    // turn to be persisted rather than post against nothing.
    errorMessage.value = t('chat.interaction.notReady')
    return
  }
  errorMessage.value = null
  pending.value = true
  pendingOption.value = optionId
  if (attemptedOption.value !== optionId) clientMessageId.value = null
  attemptedOption.value = optionId
  clientMessageId.value = clientMessageId.value ?? newClientMessageId()

  const outcome = await answerBlock({
    messageId: props.messageId,
    block: props.block,
    value: optionId,
    clientMessageId: clientMessageId.value,
  })

  pending.value = false
  pendingOption.value = null

  if (outcome.status === 'applied' || outcome.status === 'already_answered') {
    const label = outcome.label || props.block.options.find(o => o.id === optionId)?.label || optionId
    localAnswer.value = label
    settled.value = true
    setTimeout(() => { settled.value = false }, 600)
    emit('answered', { blockId: props.block.id, label })
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
  if (attemptedOption.value) void choose(attemptedOption.value)
}
</script>
