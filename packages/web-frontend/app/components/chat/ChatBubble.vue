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
        class="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#2AABEE] text-white shadow-sm"
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
    <div v-if="!interactionCard(msg) || hasBubbleBody(msg)" class="min-w-0 max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed" :class="{
      'rounded-br-sm border border-primary/[0.22] bg-primary/[0.12] text-foreground': msg.role === 'user' && msg.source !== 'telegram',
      'rounded-br-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'user' && msg.source === 'telegram',
      'rounded-bl-sm border border-border bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered && !interactionCard(msg),
      // With a card below it the bubble drops its outline: one card,
      // one frame, no nested boxes of nearly the same colour.
      'bg-muted text-foreground': msg.role === 'assistant' && !msg.telegramDelivered && !!interactionCard(msg),
      'rounded-bl-sm border border-[#2AABEE]/30 bg-[#2AABEE]/10 text-foreground': msg.role === 'assistant' && msg.telegramDelivered,
      'rounded-lg border border-border bg-muted/50 text-muted-foreground text-xs': msg.role === 'system',
    }">
      <p v-if="msg.role === 'assistant' || msg.role === 'user' || msg.role === 'system'" class="mb-1 text-xs font-semibold text-muted-foreground" data-speaker-label>
        {{ msg.role === 'assistant' ? personaLabel : msg.role === 'system' ? $t('w4Content.system') : (msg.senderName || user?.username || $t('w4Content.you')) }}
      </p>
      <!-- Telegram label (source or delivered) -->
      <p v-if="msg.source === 'telegram'" class="mb-1 text-xs font-medium text-[#2AABEE]">
        via Telegram{{ msg.senderName ? ` (${msg.senderName})` : '' }}
      </p>
      <p v-else-if="msg.telegramDelivered" class="mb-1 text-xs font-medium text-[#2AABEE]">
        via Telegram
      </p>
      <!-- Reply-to quote bubble (WhatsApp/Telegram style). Shown above the
           user message body when the incoming Telegram message replied to
           another message. -->
      <div
        v-if="msg.role === 'user' && msg.replyContext"
        class="mb-1.5 rounded-md border-l-2 border-primary/60 bg-background/60 px-2 py-1 text-xs text-muted-foreground"
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
          class="prose-chat max-w-[70ch] break-words"
          v-html="renderMarkdown(segment.text)"
        />
      </template>
      <p v-else class="max-w-[70ch] whitespace-pre-wrap break-words">
        <SecretHandleText :text="msg.content" />
      </p>
      <!-- Privacy step 1: a secret in this message was stored instead
           of sent. Live-only hint; the lock chip above survives the
           reload and carries the information afterwards. -->
      <p
        v-if="msg.role === 'user' && (msg.sealedCount ?? 0) > 0"
        class="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground"
        data-sealed-hint
      >
        <AppIcon name="lock" size="sm" class="h-3 w-3" />
        <span>{{ $t('chat.secretsSealed', { count: msg.sealedCount ?? 0 }) }}</span>
      </p>
      <ChatAttachments v-if="msg.attachments?.length" :attachments="msg.attachments" />
      <ChatArtifactLinks v-if="msg.artifacts?.length" :artifacts="msg.artifacts" />
      <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /></div>
      <div v-if="msg.timestamp && !msg.streaming" class="mt-1 flex items-center justify-end gap-1.5">
        <button
          v-if="ttsEnabled && msg.role === 'assistant' && msg.content"
          type="button"
          class="inline-flex items-center justify-center rounded-md p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
          :title="ttsPlayingIndex === index ? $t('chat.ttsStop') : $t('chat.ttsPlay')"
          @click.stop="handleTtsPlay(msg.content, index)"
        >
          <AppIcon v-if="ttsLoading && ttsPlayingIndex === index" name="loader" size="sm" class="animate-spin" />
          <AppIcon v-else-if="ttsPlayingIndex === index" name="square" size="sm" />
          <AppIcon v-else name="volume" size="sm" />
        </button>
        <span class="text-[10px] leading-none text-muted-foreground/70">{{ formatTimeShort(msg.timestamp) }}</span>
      </div>
    </div>
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

/**
 * A speaking row: avatar, the message bubble (speaker, body, attachments,
 * canvases, time and read-aloud) and — as a sibling below the bubble, not a
 * box inside it — the interaction card (SPEC 7.4c).
 */
defineProps<{ msg: ChatMessage; index: number }>()

const { formatTimeShort } = useFormat()
const { renderMarkdown } = useMarkdown()
const {
  user, avatar, persona, tts,
  interactionCard, messageTextSegments, hasBubbleBody, answeredElsewhere, handleOwnAnswer,
} = useChatView()
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = avatar
const { label: personaLabel, initials: personaInitials, color: personaColor } = persona
const { playingIndex: ttsPlayingIndex, loading: ttsLoading, ttsEnabled, play: ttsPlay } = tts

function handleTtsPlay(content: string, index: number) {
  ttsPlay(content, index)
}
</script>
