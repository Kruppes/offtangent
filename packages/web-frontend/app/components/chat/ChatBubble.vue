<template>
    <div class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
      <template v-if="msg.role === 'user'">
        <img v-if="userAvatarUrl && !avatarFailed" :src="userAvatarUrl" :alt="user?.username" class="h-8 w-8 rounded-full object-cover" @error="onAvatarError">
        <span v-else-if="user?.username" class="text-xs font-semibold">{{ userInitial }}</span>
        <AppIcon v-else name="user" class="h-4 w-4" />
      </template>
      <span v-else-if="msg.role === 'assistant'" class="flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold" :style="{ borderColor: personaColor }" :title="personaLabel">{{ personaInitials }}</span>
      <AppIcon v-else name="info" class="h-4 w-4" />
      <!-- Telegram badge (source or delivered) -->
      <span
        v-if="msg.source === 'telegram' || msg.telegramDelivered"
        class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-telegram text-white"
        :title="msg.source === 'telegram' ? (msg.senderName ? `via Telegram (${msg.senderName})` : 'via Telegram') : 'Also sent via Telegram'"
      >
        <svg class="h-2 w-2" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zm5.53 7.18l-1.97 9.3c-.15.67-.54.83-1.09.52l-3.01-2.22-1.45 1.4c-.16.16-.3.3-.61.3l.22-3.05 5.55-5.02c.24-.22-.05-.34-.38-.13l-6.87 4.33-2.96-.93c-.64-.2-.66-.64.13-.95l11.57-4.46c.54-.19 1.01.13.87.91z"/>
        </svg>
      </span>
    </div>
    <!-- Message column: the bubble, and below it — as a sibling, not
         as a box inside the bubble — the interaction card (SPEC 7.4c). -->
    <div class="flex min-w-0 flex-col" :class="[msg.role === 'user' ? 'items-end' : 'items-start', interactionCard(msg) ? 'flex-1' : '']">
    <p
      v-if="interactionCard(msg) && !hasBubbleBody(msg)"
      class="mb-1 text-xs font-semibold text-muted-foreground"
      data-speaker-label
    >{{ personaLabel }}</p>
    <div v-if="!interactionCard(msg) || hasBubbleBody(msg)" class="min-w-0 max-w-full rounded-2xl px-4 py-2 text-sm leading-relaxed" :class="{
      'rounded-br-sm bg-card text-foreground': msg.role === 'user' && msg.source !== 'telegram',
      'rounded-br-sm bg-telegram-subtle text-foreground': msg.role === 'user' && msg.source === 'telegram',
      'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered && !interactionCard(msg),
      // With a card below it the bubble drops its outline: one card,
      // one frame, no nested boxes of nearly the same colour.
      'bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered && !!interactionCard(msg),
      'rounded-bl-sm bg-telegram-subtle text-foreground': msg.role === 'assistant' && msg.telegramDelivered,
      'rounded-lg border border-border bg-muted text-muted-foreground text-xs': msg.role === 'system',
    }">
      <p v-if="msg.role === 'assistant' || msg.role === 'user' || msg.role === 'system'" class="mb-1 text-xs font-semibold text-muted-foreground" data-speaker-label>
        {{ msg.role === 'assistant' ? personaLabel : msg.role === 'system' ? $t('w4Content.system') : (msg.senderName || user?.username || $t('w4Content.you')) }}
      </p>
      <!-- Telegram label (source or delivered) -->
      <p v-if="msg.source === 'telegram'" class="mb-1 text-xs font-medium text-telegram">
        via Telegram{{ msg.senderName ? ` (${msg.senderName})` : '' }}
      </p>
      <p v-else-if="msg.telegramDelivered" class="mb-1 text-xs font-medium text-telegram">
        via Telegram
      </p>
      <!-- Reply-to quote bubble (WhatsApp/Telegram style). Shown above the
           user message body when the incoming Telegram message replied to
           another message. -->
      <div
        v-if="msg.role === 'user' && msg.replyContext"
        class="mb-2 rounded-md border-l-2 border-primary bg-background px-2 py-1 text-xs text-muted-foreground"
      >
        <span class="whitespace-pre-wrap break-words">[Replying to: "{{ msg.replyContext }}"]</span>
      </div>
      <!-- Assistant body. Interactive blocks (SPEC 7.4c) are cut out of
           the markdown and rendered as cards in place; everything
           else — including a block that does not parse — stays
           ordinary markdown. -->
      <template v-if="msg.role === 'assistant'">
        <div
          v-for="(segment, si) in messageTextSegments(msg)"
          :key="`${index}-${si}`"
          class="prose-chat max-w-conversation break-words"
          v-html="renderMarkdown(segment.text)"
        />
      </template>
      <!-- A user message reads at the size of an answer (16 px), not 14. -->
      <p v-else class="max-w-reading whitespace-pre-wrap break-words" :class="msg.role === 'user' ? 'text-base' : ''">
        <SecretHandleText :text="msg.content" />
      </p>
      <!-- Privacy step 1: a secret in this message was stored instead
           of sent. Live-only hint; the lock chip above survives the
           reload and carries the information afterwards. -->
      <p
        v-if="msg.role === 'user' && (msg.sealedCount ?? 0) > 0"
        class="mt-1 flex items-center gap-1 text-2xs text-muted-foreground"
        data-sealed-hint
      >
        <AppIcon name="lock" size="sm" class="h-3 w-3" />
        <span>{{ $t('chat.secretsSealed', { count: msg.sealedCount ?? 0 }) }}</span>
      </p>
      <!-- The spoken version of this answer (also one made in the app), shown
           as its own element; it is played, never generated again. -->
      <VoiceNoteBubble v-if="msg.role === 'assistant' && voiceNoteOf(msg)" :url="voiceNoteOf(msg)!.url" :seconds="voiceNoteOf(msg)!.seconds" kind="assistant" />
      <ChatAttachments v-if="msg.attachments?.length" :attachments="msg.attachments" :role="msg.role" />
      <ChatArtifactLinks v-if="msg.artifacts?.length" :artifacts="msg.artifacts" :attachments="msg.attachments" :fences="artifactFences(msg)" />
      <div v-if="msg.streaming" class="mt-2 flex items-center gap-1"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /></div>
      <div v-if="msg.timestamp && !msg.streaming" class="flex items-center justify-end gap-2">
        <span class="text-2xs text-muted-foreground">{{ formatTimeShort(msg.timestamp) }}</span>
      </div>
    </div>
    <ChatMessageActions v-if="msg.role === 'assistant' && !msg.streaming && msg.content.trim()" :markdown="msg.content">
      <MessageSpeechActions :message-id="msg.id" :text="msg.content" :has-voice-note="!!voiceNoteOf(msg)" />
      <MessageForkAction v-if="forkable(msg)" :strand-id="boundSessionId!" :message-id="msg.id!" />
    </ChatMessageActions>
    <!-- W5b: a stored user message can be forked too; same hover/focus rule
         as the answer actions, always visible on touch. -->
    <div
      v-if="msg.role === 'user' && forkable(msg)"
      role="toolbar"
      :aria-label="$t('fork.toolbarLabel')"
      class="mt-1 flex flex-wrap items-center justify-end gap-1 transition-opacity motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:group-hover/msg:opacity-100 pointer-fine:group-focus-within/msg:opacity-100"
      data-user-message-actions
    >
      <MessageForkAction :strand-id="boundSessionId!" :message-id="msg.id!" />
    </div>
    <MessageSpeechPanel v-if="msg.role === 'assistant' && !msg.streaming && msg.content.trim()" :message-id="msg.id" :text="msg.content" />
    <ChatInteractionBlock
      v-if="interactionCard(msg)"
      class="mt-2 w-full max-w-xl"
      :block="interactionCard(msg)!"
      :message-id="typeof msg.id === 'number' ? msg.id : undefined"
      :answered="msg.interactionAnswers?.[interactionCard(msg)!.id] ?? null"
      :answered-elsewhere="answeredElsewhere(index)"
      @own-answer="handleOwnAnswer"
    />
    </div>
</template>

<script setup lang="ts">
import type { ChatMessage } from '~/composables/useChat'
import { useChatView } from '~/composables/chat/chatViewContext'
import SecretHandleText from '../SecretHandleText.vue'
import ChatArtifactLinks from './ChatArtifactLinks.vue'
import ChatMessageActions from './ChatMessageActions.vue'
import MessageSpeechActions from './MessageSpeechActions.vue'
import MessageSpeechPanel from './MessageSpeechPanel.vue'
import MessageForkAction from './MessageForkAction.vue'
import VoiceNoteBubble from '../audio/VoiceNoteBubble.vue'
import { useMessageSpeech } from '~/composables/useMessageSpeech'

/**
 * A speaking row: avatar, the message bubble (speaker, body, attachments,
 * canvases, voice note and time), its actions (copy, read aloud, audio summary) and — as a sibling below the bubble, not a
 * box inside it — the interaction card (SPEC 7.4c).
 */
defineProps<{ msg: ChatMessage; index: number }>()

const { formatTimeShort } = useFormat()
const { renderMarkdown } = useMarkdown()
const {
  user, avatar, persona,
  interactionCard, messageTextSegments, hasBubbleBody, answeredElsewhere, artifactFences, handleOwnAnswer,
  boundSessionId,
} = useChatView()

/** W5b: only a stored message (numeric id) of a bound strand can be forked. */
function forkable(msg: ChatMessage): boolean {
  return typeof msg.id === 'number' && msg.id > 0 && !msg.streaming && !!boundSessionId.value && !!msg.content.trim()
}
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = avatar
const { label: personaLabel, initials: personaInitials, color: personaColor } = persona
const speech = useMessageSpeech()

/** Stored note of the message, or one created in this tab since the load. */
function voiceNoteOf(msg: ChatMessage) {
  return msg.voiceNote ?? speech.voiceNoteFor(msg.id)
}
</script>
