import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { ArtifactFence } from '~/utils/inlineArtifacts'
import type { ChatMessage, useChat } from '~/composables/useChat'
import type { ArtifactRef } from '~/api/artifacts'
import type { InteractionBlock, InteractionSegment } from '@axiom/core/contracts'
import type { ChatFilters } from './useChatFilters'
import type { ComposerDraft } from './useComposerDraft'
import type { ThinkingLevelState } from './useThinkingLevel'
import type { useTaskReports } from './useTaskReports'
import type { useChatScroll } from './useChatScroll'
import type { useStt } from '~/composables/useStt'
import type { useTts } from '~/composables/useTts'
import type { useAuth } from '~/composables/useAuth'
import type { useUserAvatar } from '~/composables/useUserAvatar'

/**
 * Everything the parts of one chat view share. Provided once by ChatView,
 * read by the transcript rows and the composer, so no prop is drilled
 * through three levels.
 */
export interface ChatViewContext {
  filters: ChatFilters
  scroll: ReturnType<typeof useChatScroll>
  draft: ComposerDraft
  thinking: ThinkingLevelState
  taskReports: ReturnType<typeof useTaskReports>
  stt: ReturnType<typeof useStt>
  tts: ReturnType<typeof useTts>
  isAdmin: ComputedRef<boolean>
  user: ReturnType<typeof useAuth>['user']
  avatar: ReturnType<typeof useUserAvatar>
  isStreaming: Ref<boolean>
  connectionStatus: Ref<string>
  queuePosition: Ref<number | null>
  boundSessionId: Ref<string | null>
  /** Speaker of the assistant bubbles (persona name, initials, colour). */
  persona: { label: ComputedRef<string>; initials: ComputedRef<string>; color: ComputedRef<string | undefined> }
  turnActive: ComputedRef<boolean>
  expandedTools: { set: Ref<Set<string>>; toggle: (id: string) => void }
  expandedThinking: { set: Ref<Set<string>>; toggle: (id: string) => void }
  expandedInjections: { set: Ref<Set<number>>; toggle: (id: number) => void }
  expandedSummaries: { set: Ref<Set<string>>; toggle: (id: string) => void }
  pendingChatActions: Ref<Set<string>>
  interactionCard: (msg: ChatMessage) => InteractionBlock | null
  messageTextSegments: (msg: ChatMessage) => Array<Extract<InteractionSegment, { type: 'text' }>>
  hasBubbleBody: (msg: ChatMessage) => boolean
  artifactFences: (msg: ChatMessage) => ArtifactFence[]
  answeredElsewhere: (index: number) => boolean
  handleOwnAnswer: (text: string) => Promise<void>
  handleChatAction: (messageId: string, actionId: string) => Promise<void>
  handlePickerSelect: (msg: ChatMessage, command: string) => void
  openCanvasAt: (artifact: ArtifactRef) => void
  /** The one send path of the session (composer and interaction cards). */
  sendMessage: ReturnType<typeof useChat>['sendMessage']
}

const CHAT_VIEW_KEY: InjectionKey<ChatViewContext> = Symbol('chat-view')

export function provideChatView(context: ChatViewContext): void {
  provide(CHAT_VIEW_KEY, context)
}

export function useChatView(): ChatViewContext {
  const context = inject(CHAT_VIEW_KEY)
  if (!context) throw new Error('useChatView() needs a ChatView ancestor')
  return context
}
