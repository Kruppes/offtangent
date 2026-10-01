<template>
  <!-- Chat and canvas share one row: on a wide window the canvas is a side
       panel next to the chat, on a narrow one it slides over it (SPEC 2.8/2.9).
       The chat column keeps `min-w-0` so a wide canvas shrinks it instead of
       pushing it out of the viewport. -->
  <div class="relative flex h-full overflow-hidden">
  <div
    class="relative flex min-w-0 flex-1 flex-col overflow-hidden"
    @dragenter.prevent="handleDragEnter"
    @dragover.prevent="handleDragOver"
    @dragleave.prevent="handleDragLeave"
    @drop.prevent="handleDrop"
  >
    <!-- Drag & drop overlay -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isDraggingFiles"
        class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      >
        <div class="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.06] px-10 py-8 text-primary shadow-lg">
          <AppIcon name="paperclip" class="h-10 w-10" />
          <p class="text-sm font-medium">{{ $t('chat.dropFilesHere') }}</p>
        </div>
      </div>
    </Transition>
    <!--
      Chat toolbar — uses the shared <PageHeader> (slim variant, no title)
      so on mobile the action buttons teleport into the layout header and
      the second bar disappears entirely.
    -->
    <PageHeader>
      <!--
        Connection status dot (desktop-only): lives in the default slot so
        it renders on the LEFT side of the toolbar. On mobile it's not
        needed — the global status indicator is hidden there too, and the
        Send button's disabled state already communicates offline state.
      -->
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :class="{
            'bg-success shadow-[0_0_6px_hsl(var(--success))]': connectionStatus === 'connected',
            'bg-warning animate-pulse': connectionStatus === 'connecting',
            'bg-muted-foreground': connectionStatus === 'disconnected',
          }"
        />
        <span class="hidden sm:inline">{{ chatStatusText }}</span>
      </div>
      <template #actions>
        <Button variant="outline" size="sm" class="min-h-11 min-w-11 gap-2 hover:border-destructive hover:text-destructive" :aria-label="$t('turnProgress.stopAll')" :disabled="!isStreaming" @click="handleStop">
          <AppIcon name="square" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('turnProgress.stopAll') }}</span>
        </Button>
        <!-- /new starts a fresh session in the (user, persona) slot, which is
             meaningless inside a named thread: threads replace that flow. -->
        <Button v-if="!boundToThread" variant="outline" size="sm" class="gap-2" :disabled="isStreaming || sessionResetting" @click="handleNewSession">
          <AppIcon name="sparkles" class="h-4 w-4" />
          <span class="hidden sm:inline">{{ $t('chat.newSession') }}</span>
        </Button>
        <Popover v-model:open="filterOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" size="sm" class="min-h-11 min-w-11 gap-2" :aria-label="$t('chat.displayFilters')">
              <AppIcon name="settings" class="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-64">
            <div class="flex flex-col gap-3">
              <p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{{ $t('chat.displayFilters') }}</p>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-thinking">{{ $t('chat.filterThinking') }}</Label>
                <Switch id="filter-thinking" v-model:checked="showThinking" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-tools">{{ $t('chat.filterToolCalls') }}</Label>
                <Switch id="filter-tools" v-model:checked="showToolCalls" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-injections">{{ $t('chat.filterInjections') }}</Label>
                <Switch id="filter-injections" v-model:checked="showInjections" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <Label class="cursor-pointer text-sm" for="filter-summaries">{{ $t('chat.filterSessionSummaries') }}</Label>
                <Switch id="filter-summaries" v-model:checked="showSessionSummaries" />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </template>
    </PageHeader>

    <!-- Session binding failed: the thread cannot be opened at all, so we show
         a dedicated state with a way back instead of a chat bubble. -->
    <div v-if="sessionError" class="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <AppIcon name="warning" class="h-10 w-10 text-destructive/70" />
      <div class="max-w-sm space-y-1">
        <p class="text-sm font-semibold text-foreground">{{ $t('threads.sessionErrorTitle') }}</p>
        <p class="text-sm text-muted-foreground">{{ sessionErrorText }}</p>
      </div>
      <Button class="min-h-[44px] gap-2" @click="$emit('back')">
        <AppIcon name="arrowLeft" class="h-4 w-4" />
        {{ $t('threads.backToInbox') }}
      </Button>
    </div>

    <div v-else ref="messagesContainer" class="relative flex flex-1 flex-col gap-4 overflow-y-auto p-4" @scroll="onMessagesScroll" @copy="handleCopyAsMarkdown" @click="handleMarkdownCodeCopy">
      <TranscriptState :state="contentState" @retry="reloadHistory">
        <div
          v-for="{ message: msg, index: i, key, tools } in transcriptRows"
          :key="key"
          :class="[
            // Mobile: messages fill the available width (minus avatar + gap
            // or the pl-11 offset for tool cards). On sm+ screens we cap them
            // so bubbles don't span edge-to-edge on wider viewports.
            msg.role === 'divider' ? 'w-full' : (msg.role === 'tool' || (msg.role === 'system' && (msg.isTaskResult || msg.isTaskStatusUpdate || msg.stallInfo || msg.errorInfo || msg.picker || msg.chatAction)) || msg.isThinking) ? 'self-start w-full max-w-full sm:max-w-[75%] pl-11' : 'flex max-w-full gap-3 sm:max-w-[75%]',
            {
              'self-end flex-row-reverse': msg.role === 'user',
              'self-start': msg.role === 'assistant' && !msg.isThinking,
              'self-center max-w-full sm:max-w-[85%]': msg.role === 'system' && !msg.isTaskResult && !msg.isTaskStatusUpdate && !msg.stallInfo && !msg.errorInfo && !msg.picker && !msg.chatAction,
              // A message carrying an interaction card spans the full column:
              // the card is a sibling of the bubble and needs the same width.
              'w-full': !!interactionCard(msg),
            },
          ]"
        >
          <!-- Session divider -->
          <template v-if="msg.role === 'divider'">
            <!-- Collapsible summary card -->
            <div v-if="msg.content && showSessionSummaries" class="w-full max-w-none px-2 mb-1">
              <div class="mx-auto max-w-lg">
                <button
                  class="group flex w-full items-center gap-2 rounded-t-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
                  :class="{ 'rounded-b-lg': !expandedSummaries.has(String(msg.id ?? i)) }"
                  @click="toggleSummary(String(msg.id ?? i))"
                >
                  <AppIcon name="file" size="sm" class="h-3 w-3 shrink-0 opacity-50" />
                  <span class="font-medium">{{ $t('chat.sessionSummary') }}</span>
                  <span class="flex-1" />
                  <AppIcon
                    :name="expandedSummaries.has(String(msg.id ?? i)) ? 'chevronDown' : 'chevronRight'"
                    class="h-3 w-3 shrink-0"
                  />
                </button>
                <div
                  v-if="expandedSummaries.has(String(msg.id ?? i))"
                  class="rounded-b-lg border border-t-0 border-border/60 bg-muted/10 px-4 py-3"
                >
                  <p class="text-xs leading-relaxed text-muted-foreground/80">
                    {{ msg.content }}
                  </p>
                </div>
              </div>
            </div>
            <!-- New Session divider line (always visible) -->
            <div class="w-full max-w-none px-2">
              <div class="relative flex items-center py-2">
                <div class="grow border-t border-border" />
                <div class="mx-4 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                  <AppIcon name="sparkles" class="h-3 w-3" />
                  <span>{{ $t('chat.newSessionDivider') }}</span>
                </div>
                <div class="grow border-t border-border" />
              </div>
            </div>
          </template>

          <!-- Thinking card (clickable/expandable) -->
          <template v-else-if="msg.isThinking">
            <ChatCollapsibleCard
              icon="sparkles"
              :expanded="expandedThinking.has(String(msg.id ?? i))"
              @toggle="toggleThinking(String(msg.id ?? i))"
            >
              <template #header>
                <span class="font-medium">{{ $t('chat.thinking') }}</span>
                <span v-if="msg.streaming" class="ml-2 inline-flex items-center gap-1">
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                  <span class="h-1 w-1 animate-pulse rounded-full bg-current opacity-60" />
                </span>
              </template>
              <div class="max-h-80 overflow-y-auto px-3 py-2">
                <p class="whitespace-pre-wrap break-words text-muted-foreground">{{ msg.content }}</p>
              </div>
            </ChatCollapsibleCard>
          </template>

          <!-- Tool call card (clickable/expandable) -->
          <template v-else-if="tools">
            <ToolActivityGroup :tools="tools" :active="isStreaming || (!!boundSessionId && sessionActivity[boundSessionId]?.state === 'running')">
              <template #default="{ msg }">
                <ChatCollapsibleCard
                  :icon="toolIconName(msg.toolData!)"
                  :expanded="expandedTools.has(msg.toolData!.toolCallId)"
                  @toggle="toggleTool(msg.toolData!.toolCallId)"
                >
                  <template #header>
                    <span class="shrink-0 font-medium">{{ toolDisplayName(msg.toolData!) }}</span>
                    <span
                      v-if="toolSummary(msg.toolData!)"
                      class="min-w-0 truncate font-mono text-muted-foreground/70"
                      :title="toolSummary(msg.toolData!)!"
                    >
                      {{ toolSummary(msg.toolData!) }}
                    </span>
                  </template>
                  <div>
                    <div v-if="!isToolSkillLoad(msg.toolData!) && !hasMemoryView(msg.toolData!)" class="border-b border-border px-3 py-2"><p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Input</p><ToolDataDisplay :data="msg.toolData!.toolArgs" /></div>
                    <template v-if="isEditFileTool(msg.toolData!) && getToolEdits(msg.toolData!) && getToolMemoryInfo(msg.toolData!).isMemoryFile">
                      <div class="max-h-80 overflow-y-auto">
                        <MemoryEditsDiff
                          :edits="getToolEdits(msg.toolData!)!"
                          :file-name="getToolMemoryFileName(msg.toolData!)"
                        />
                      </div>
                    </template>
                    <template v-else-if="getToolMemoryWriteContent(msg.toolData!) !== null">
                      <div class="max-h-80 overflow-y-auto">
                        <MemoryFileDiff
                          before=""
                          :after="getToolMemoryWriteContent(msg.toolData!)!"
                          :file-name="getToolMemoryFileName(msg.toolData!)"
                        />
                      </div>
                    </template>
                    <div v-else class="max-h-80 overflow-y-auto px-3 py-2">
                      <p class="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Output</p><ToolDataDisplay :data="msg.toolData!.toolResult" :is-error="msg.toolData!.toolIsError" />
                    </div>
                  </div>
                </ChatCollapsibleCard>
              </template>
            </ToolActivityGroup>
          </template>

          <!-- Periodic task heartbeat (compact, non-collapsible progress row).
               Rendered as a subtle single line so the user can see a task
               is still making progress without the row looking like a
               completed-task card. -->
          <template v-else-if="msg.role === 'system' && msg.isTaskStatusUpdate">
            <div class="w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
              <div class="flex items-center gap-2">
                <AppIcon name="zap" class="h-3 w-3 shrink-0 opacity-60" />
                <span class="font-medium text-foreground/80">{{ msg.taskStatusUpdateName ?? 'Background Task' }}</span>
                <span class="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground/80">
                  <span v-if="typeof msg.taskStatusRuntimeMinutes === 'number'">⏱ {{ msg.taskStatusRuntimeMinutes }}min</span>
                  <span v-if="typeof msg.taskStatusToolCallCount === 'number'">• {{ msg.taskStatusToolCallCount }} tools</span>
                  <span v-if="typeof msg.taskStatusTokensUsed === 'number'">• ~{{ formatTokenCount(msg.taskStatusTokensUsed) }} tok</span>
                  <span class="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">Running</span>
                </span>
              </div>
            </div>
          </template>

          <!-- Provider stall notice. Backed by a persisted chat row, so it
               survives a reload; the same bubble flips to the resolved state
               in place when the provider recovers or the turn is aborted. -->
          <template v-else-if="msg.role === 'system' && msg.stallInfo">
            <div
              class="w-full overflow-hidden rounded-lg border px-3 py-1.5 text-xs"
              :class="msg.stallInfo.outcome === 'recovered'
                ? 'border-emerald-500/30 bg-emerald-500/5 text-muted-foreground'
                : msg.stallInfo.outcome === 'aborted'
                  ? 'border-destructive/30 bg-destructive/5 text-muted-foreground'
                  : 'border-amber-500/30 bg-amber-500/5 text-muted-foreground'"
            >
              <div class="flex items-center gap-2">
                <AppIcon
                  :name="msg.stallInfo.outcome === 'recovered' ? 'check' : msg.stallInfo.outcome === 'aborted' ? 'warning' : 'clock'"
                  class="h-3 w-3 shrink-0 opacity-70"
                />
                <span class="min-w-0 flex-1 break-words text-foreground/80">{{ msg.content }}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground/80">
                  {{ formatStallDuration(msg.stallInfo.durationMs) }}
                </span>
              </div>
            </div>
          </template>

          <!-- Terminal turn error. Backed by a persisted chat row (full
               provider text included), so the failure is still visible after a
               reload instead of the turn dying silently. -->
          <template v-else-if="msg.role === 'system' && msg.errorInfo">
            <div class="w-full overflow-hidden rounded-lg border border-destructive/40 bg-destructive/5">
              <div class="flex items-center gap-2 border-b border-destructive/20 px-3 py-1.5 text-xs">
                <AppIcon name="warning" class="h-3 w-3 shrink-0 text-destructive" />
                <span class="font-medium text-destructive">{{ $t('chat.turnError') }}</span>
                <span v-if="msg.errorInfo.attempts > 0" class="ml-auto shrink-0 text-[10px] text-muted-foreground/80">
                  {{ $t('chat.turnErrorRetried', { count: msg.errorInfo.attempts }) }}
                </span>
              </div>
              <div class="whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground/90">{{ msg.content }}</div>
              <!-- Manual retry. Answered by the backend against the persisted
                   error row, so it survives a reload and disables itself once
                   the conversation moved on. -->
              <template v-if="msg.chatAction">
                <div
                  v-if="msg.chatAction.resolution"
                  class="border-t border-destructive/20 px-3 py-2 text-xs text-muted-foreground"
                >{{ msg.chatAction.resolution }}</div>
                <div v-else class="flex flex-wrap gap-1.5 border-t border-destructive/20 p-1.5">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-md border border-primary/30 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
                    :disabled="pendingChatActions.has(msg.chatAction.messageId)"
                    @click="handleChatAction(msg.chatAction!.messageId, 'retry')"
                  >
                    <AppIcon name="refresh" class="h-3 w-3 shrink-0" />
                    {{ $t('chat.turnErrorRetry') }}
                  </button>
                </div>
              </template>
            </div>
          </template>

          <!-- Task result notification (collapsible card) -->
          <template v-else-if="msg.role === 'system' && msg.isTaskResult">
            <ChatCollapsibleCard
              icon="zap"
              :expanded="expandedInjections.has(i)"
              @toggle="toggleInjection(i)"
            >
              <template #header>
                <span class="font-medium">{{ msg.taskResultName ?? 'Background Task' }}</span>
                <span v-if="msg.taskResultDuration" class="ml-1 text-[10px] text-muted-foreground/60">({{ msg.taskResultDuration }}min)</span>
              </template>
              <template #trailing>
                <span
                  class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  :class="msg.taskResultStatus === 'failed'
                    ? 'bg-destructive/10 text-destructive'
                    : msg.taskResultStatus === 'question'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'"
                >
                  {{ msg.taskResultStatus === 'failed' ? 'Failed' : msg.taskResultStatus === 'question' ? 'Question' : 'Completed' }}
                </span>
              </template>
              <div class="max-h-60 overflow-y-auto px-3 py-2">
                <div class="prose-chat break-words text-xs text-foreground" v-html="renderMarkdown(taskResultVisibleBody(msg, i))" />
                <!-- The stream shows at most three lines; the full report
                     stays in tasks.result_summary and is fetched on demand. -->
                <template v-if="msg.taskResultTruncated && msg.taskResultTaskId">
                  <p v-if="taskReportError.get(i)" class="mt-2 text-[11px] text-destructive" role="alert">{{ $t('chat.taskResult.loadFailed') }}</p>
                  <p v-else-if="msg.taskResultFullLength" class="mt-2 text-[11px] text-muted-foreground/70">
                    {{ $t('chat.taskResult.truncated', { count: msg.taskResultFullLength }) }}
                  </p>
                  <button
                    type="button"
                    class="mt-1 inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                    :disabled="taskReportLoading.has(i)"
                    :aria-expanded="taskReports.has(i)"
                    @click="toggleTaskReport(msg, i)"
                  >
                    <AppIcon v-if="taskReportLoading.has(i)" name="loader" class="h-3 w-3 motion-safe:animate-spin" />
                    <AppIcon v-else :name="taskReports.has(i) ? 'chevronDown' : 'chevronRight'" class="h-3 w-3" />
                    {{ taskReportLoading.has(i)
                      ? $t('chat.taskResult.loading')
                      : taskReports.has(i) ? $t('chat.taskResult.hideFull') : $t('chat.taskResult.showFull') }}
                  </button>
                </template>
              </div>
            </ChatCollapsibleCard>
          </template>

          <!-- Interactive action message (e.g. an email waiting for approval).
               Buttons post to /api/chat/actions; once decided — here or in any
               other channel — they are replaced by the result line. -->
          <template v-else-if="msg.role === 'system' && msg.chatAction">
            <div class="w-full overflow-hidden rounded-lg border border-border bg-muted/30">
              <div class="whitespace-pre-wrap break-words px-3 py-2 text-xs text-foreground">{{ msg.chatAction.text }}</div>
              <div
                v-if="msg.chatAction.resolution"
                class="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground"
              >{{ msg.chatAction.resolution }}</div>
              <div v-else class="flex flex-wrap gap-1.5 border-t border-border/60 p-1.5">
                <button
                  v-for="action in msg.chatAction.actions"
                  :key="action.actionId"
                  type="button"
                  class="rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  :class="action.style === 'danger'
                    ? 'border-destructive/30 text-destructive hover:bg-destructive/10'
                    : 'border-primary/30 text-primary hover:bg-primary/10'"
                  :disabled="pendingChatActions.has(msg.chatAction.messageId)"
                  @click="handleChatAction(msg.chatAction!.messageId, action.actionId)"
                >{{ action.label }}</button>
              </div>
            </div>
          </template>

          <!-- Slash-command picker (e.g. /model). Renders the title +
               description plus a button group; clicking a button sends the
               option's verbatim slash command back to the server, which
               re-dispatches it through the registry to produce the next
               picker (or final confirmation). -->
          <template v-else-if="msg.role === 'system' && msg.picker">
            <div class="w-full overflow-hidden rounded-lg border border-border bg-muted/30">
              <div v-if="msg.picker.title || msg.picker.description" class="border-b border-border/60 px-3 py-2 text-xs">
                <p v-if="msg.picker.title" class="font-medium text-foreground">{{ msg.picker.title }}</p>
                <p v-if="msg.picker.description" class="mt-0.5 text-muted-foreground">{{ msg.picker.description }}</p>
              </div>
              <div class="flex flex-col gap-1 p-1.5">
                <button
                  v-for="opt in msg.picker.options"
                  :key="opt.command"
                  type="button"
                  class="group flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 text-left text-xs transition-colors"
                  :class="msg.pickerResolvedCommand
                    ? (opt.command === msg.pickerResolvedCommand
                        ? 'border-primary/30 bg-primary/10 text-foreground'
                        : 'cursor-not-allowed text-muted-foreground/60')
                    : 'text-foreground hover:border-border hover:bg-muted'"
                  :disabled="!!msg.pickerResolvedCommand"
                  @click="handlePickerSelect(msg, opt.command)"
                >
                  <span class="min-w-0 flex-1 truncate font-medium">{{ opt.label }}</span>
                  <span
                    v-if="opt.description"
                    class="shrink-0 truncate text-[10px] text-muted-foreground/80"
                  >{{ opt.description }}</span>
                  <span
                    v-if="opt.badge"
                    class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                    :class="opt.badge === 'active'
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : opt.badge === 'error'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-muted text-muted-foreground'"
                  >{{ opt.badge }}</span>
                  <AppIcon
                    v-if="opt.command === msg.pickerResolvedCommand"
                    name="check"
                    class="h-3 w-3 shrink-0 text-primary"
                  />
                </button>
              </div>
            </div>
          </template>

          <template v-else>
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
                  :key="`${i}-${si}`"
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
              <!-- A revision of a living view leaves ONE line in the
                   transcript, not a card: the canvas is where it is read, the
                   chat only says that it changed and why. A one-off canvas
                   keeps its card. -->
              <template v-for="artifact in msg.artifacts ?? []" :key="artifact.id">
                <button
                  v-if="artifact.viewKey"
                  type="button"
                  class="my-1 flex w-full max-w-[70ch] items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="canvas-trail-line"
                  @click="openCanvasAt(artifact)"
                >
                  <AppIcon name="dashboard" class="h-3.5 w-3.5 shrink-0" />
                  <span class="min-w-0 flex-1 truncate">
                    <span class="font-medium text-foreground">{{ artifact.title }}</span>
                    <span v-if="artifact.note"> · {{ artifact.note }}</span>
                  </span>
                  <span class="shrink-0 tabular-nums">{{ $t('chat.artifact.revisionOf', { revision: artifact.revision ?? 1, total: artifact.latestRevision ?? artifact.revision ?? 1 }) }}</span>
                </button>
                <ChatArtifact
                  v-else
                  :artifact-id="artifact.id"
                  :title="artifact.title"
                  :strand-id="artifact.strandId"
                  :view-key="artifact.viewKey"
                  :revision="artifact.revision"
                  :latest-revision="artifact.latestRevision"
                />
              </template>
              <div v-if="msg.streaming" class="mt-1.5 flex items-center gap-1"><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /><span class="h-1.5 w-1.5 animate-pulse rounded-full bg-current opacity-60" /></div>
              <div v-if="msg.timestamp && !msg.streaming" class="mt-1 flex items-center justify-end gap-1.5">
                <button
                  v-if="ttsEnabled && msg.role === 'assistant' && msg.content"
                  type="button"
                  class="inline-flex items-center justify-center rounded-md p-0.5 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
                  :title="ttsPlayingIndex === i ? $t('chat.ttsStop') : $t('chat.ttsPlay')"
                  @click.stop="handleTtsPlay(msg.content, i)"
                >
                  <AppIcon v-if="ttsLoading && ttsPlayingIndex === i" name="loader" size="sm" class="animate-spin" />
                  <AppIcon v-else-if="ttsPlayingIndex === i" name="square" size="sm" />
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
              :answered-elsewhere="answeredElsewhere(i)"
              @own-answer="handleOwnAnswer"
            />
            </div>
          </template>
        </div>
      </TranscriptState>
      <StrandActivityPanel
        v-if="!sessionError"
        class="shrink-0"
        :strand-id="boundSessionId"
        :turn-running="isStreaming"
      />
    </div>

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <button v-if="!isNearBottom" class="absolute bottom-28 right-6 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md" @click="jumpToBottom">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
    </Transition>

    <Transition enter-active-class="transition duration-200 ease-out" enter-from-class="translate-y-2 opacity-0" enter-to-class="translate-y-0 opacity-100" leave-active-class="transition duration-150 ease-in" leave-from-class="translate-y-0 opacity-100" leave-to-class="translate-y-2 opacity-0">
      <div v-if="ttsError" class="absolute bottom-24 left-1/2 z-10 w-[min(92%,32rem)] -translate-x-1/2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-md">
        <div class="flex items-start gap-2">
          <div class="flex-1">
            <div class="font-medium">{{ $t('chat.ttsErrorTitle') }}</div>
            <div class="mt-0.5 break-words text-destructive/90">{{ ttsError }}</div>
          </div>
          <button type="button" class="shrink-0 rounded p-0.5 text-destructive/70 hover:text-destructive" :title="$t('chat.ttsErrorDismiss')" @click="clearTtsError">
            <AppIcon name="x" size="sm" />
          </button>
        </div>
      </div>
    </Transition>

    <!-- What works for this strand right now: the running turn plus every
         delegated task and sub-task, recursively (SPEC 10.x). Sits directly
         above the composer so it is in view without scrolling. -->
    <TurnProgressStatus v-if="!sessionError" :strand-id="boundSessionId" />

    <div v-if="!sessionError" class="shrink-0 border-t border-border bg-background p-3">
      <!-- The turn queue is global: a thread can wait behind another persona's
           turn, so the position is shown right above the composer. -->
      <div v-if="queuePosition !== null" class="mb-2 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
        <AppIcon name="clock" class="h-3.5 w-3.5 shrink-0" />
        <span>{{ $t('threads.queuedWithPosition', { position: queuePosition }) }}</span>
      </div>
      <form class="relative flex flex-col gap-2" data-testid="composer" @submit.prevent="handleSend" @keydown="handleComposerAreaKeydown">
        <ChatSkillAutocomplete
          v-if="skillAutocomplete.active.value"
          :suggestions="skillAutocomplete.suggestions.value"
          :selected-index="skillAutocomplete.selectedIndex.value"
          @select="handleSkillSelect"
          @hover="skillAutocomplete.selectedIndex.value = $event"
        />
        <!-- Dictation: recording / transcribing / error, above the input field -->
        <DictationBar
          v-if="sttEnabled && dictationPhase !== 'idle'"
          :phase="dictationPhase"
          :elapsed-ms="dictationElapsed"
          :levels="dictationLevels"
          :error="dictationError"
          :can-retry="dictationCanRetry"
          :bars="DICTATION_LEVEL_BARS"
          @cancel="cancelDictation"
          @finish="finishDictation"
          @retry="retryDictation"
          @dismiss="dismissDictation"
        />
        <p class="sr-only" aria-live="polite">{{ dictationAnnouncement }}</p>
        <!-- Kept dictation recordings, sent with the message -->
        <div v-if="pendingAudio.length" class="flex flex-wrap gap-2">
          <ComposerAudioChip
            v-for="(item, index) in pendingAudio"
            :key="item.attachment.relativePath"
            :attachment="item.attachment"
            :index="index + 1"
            :duration-ms="item.durationMs"
            @remove="removePendingAudio(index)"
          />
        </div>
        <!-- Pending files row -->
        <div v-if="pendingFiles.length" class="flex flex-wrap gap-2">
          <div
            v-for="(file, index) in pendingFiles"
            :key="`${file.name}-${index}`"
            class="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-xs"
          >
            <span>{{ file.name }}</span>
            <button type="button" class="text-muted-foreground hover:text-foreground" @click="removePendingFile(index)">×</button>
          </div>
        </div>

        <div class="flex items-end gap-2">
          <!-- ── Composer box ────────────────────────────────────────────────
               Brain button (left, admin-only) | Textarea | Paperclip (right)
               Buttons use mb-[7px] so they sit centered against the
               single-line textarea height of 42px: (42-28)/2 = 7px -->
          <div class="flex flex-1 items-end rounded-xl border border-input bg-background px-1 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
            <!-- Thinking-level / Brain button (left inside box, admin-only) -->
            <Popover v-if="isAdmin" v-model:open="thinkingLevelPickerOpen">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="mb-[7px] flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
                  :class="thinkingBrainColorClass"
                  :disabled="thinkingLevelSaving"
                  :title="$t('chat.thinkingLevelTooltip')"
                  :aria-label="$t('chat.thinkingLevelTooltip')"
                >
                  <AppIcon
                    :name="thinkingLevelSaving ? 'loader' : 'brain'"
                    class="h-4 w-4 transition-colors"
                    :class="thinkingLevelSaving ? 'animate-spin' : ''"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-56 p-1">
                <p class="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {{ $t('settings.thinkingLevel') }}
                </p>
                <button
                  v-for="lvl in THINKING_LEVELS"
                  :key="lvl"
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  :class="currentThinkingLevel === lvl ? 'bg-accent/60 text-accent-foreground' : 'text-foreground'"
                  :disabled="thinkingLevelSaving"
                  @click="handleThinkingLevelChange(lvl)"
                >
                  <div class="flex items-center gap-2">
                    <span
                      class="h-2 w-2 shrink-0 rounded-full"
                      :class="{
                        'bg-muted-foreground': lvl === 'off',
                        'bg-foreground': lvl === 'minimal',
                        'bg-yellow-500': lvl === 'low',
                        'bg-orange-500': lvl === 'medium',
                        'bg-red-500': lvl === 'high',
                        'bg-red-600': lvl === 'xhigh',
                      }"
                    />
                    <span>{{ $t(`chat.thinkingLevelMenu.${lvl}`) }}</span>
                  </div>
                  <AppIcon v-if="currentThinkingLevel === lvl" name="check" class="h-4 w-4 text-primary" />
                </button>
              </PopoverContent>
            </Popover>

            <!-- Textarea -->
            <textarea
              ref="inputRef"
              v-model="inputText"
              class="min-h-[42px] max-h-[150px] flex-1 resize-none bg-transparent py-2.5 pr-1 text-sm outline-none placeholder:text-muted-foreground"
              :class="isAdmin ? 'pl-2' : 'pl-3'"
              :placeholder="$t('chat.placeholder')"
              rows="1"
              @keydown="handleComposerKeydown"
              @input="autoResize"
            />

            <!-- File attachment button (right inside box) -->
            <label class="mb-[7px] flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
              <input class="hidden" type="file" multiple @change="handleFileSelection">
              <AppIcon name="paperclip" class="h-4 w-4" />
            </label>
          </div>

          <!-- ── Mic button ─────────────────────────────────────────────────
               Always shown when STT is on: a dictation is inserted into the
               field (never sent), so a second dictation must stay reachable
               while text is present, on mobile too. -->
          <button
            v-if="sttEnabled"
            type="button"
            data-testid="dictation-mic"
            class="h-[42px] w-[42px] shrink-0 select-none items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:h-11 max-sm:w-11"
            :class="[
              'inline-flex',
              dictationPhase === 'recording' || dictationPhase === 'starting'
                ? 'border-destructive bg-destructive/10 text-destructive'
                : dictationPhase === 'transcribing'
                  ? 'border-primary bg-primary/10 text-primary'
                  : dictationPhase === 'error'
                    ? 'border-destructive text-destructive'
                    : 'border-input text-muted-foreground hover:bg-muted',
            ]"
            :title="micLabel"
            :aria-label="micLabel"
            :aria-pressed="dictationPhase === 'recording'"
            :disabled="dictationPhase === 'transcribing' || dictationPhase === 'starting'"
            @click="toggleDictation"
          >
            <AppIcon v-if="dictationPhase === 'transcribing'" name="loader" class="h-4 w-4 motion-safe:animate-spin" />
            <AppIcon v-else-if="dictationPhase === 'recording'" name="square" class="h-4 w-4" />
            <AppIcon v-else name="mic" class="h-4 w-4" />
          </button>

          <!-- ── Send button ─────────────────────────────────────────────────
               Mobile: icon-only square button, shown when text is present
               (or when STT is disabled — then always visible as sole action).
               Desktop (sm+): text label, always shown alongside the mic. -->
          <Button
            type="submit"
            :disabled="!hasText || connectionStatus !== 'connected'"
            class="h-[42px] w-[42px] shrink-0 rounded-xl p-0 sm:w-auto sm:px-4"
            :class="(!hasText && sttEnabled) ? 'hidden sm:inline-flex' : 'inline-flex'"
          >
            <AppIcon name="send" class="h-4 w-4 sm:hidden" />
            <span class="hidden sm:inline">{{ $t('chat.send') }}</span>
          </Button>
        </div>
      </form>
    </div>
  </div>
    <StrandCanvas :strand-id="boundSessionId" />
  </div>
</template>

<script setup lang="ts">
import TranscriptState from './content/TranscriptState.vue'
import ToolActivityGroup from './content/ToolActivityGroup.vue'
import { groupTranscript, transcriptState } from './content/transcript'
import type { ChatAttachment, ChatMessage, ToolCallData } from '~/composables/useChat'
import type { DictationResult } from '~/composables/useStt'
import { insertAtCursor, isDictationShortcut } from '~/utils/dictation'
import type { LoadableSkill } from '~/composables/useSkillAutocomplete'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from '@axiom/core/contracts'
import { useSettingsApi } from '~/api/settings'
import SecretHandleText from './SecretHandleText.vue'
import { setSecretChipTooltip } from '~/utils/secretHandles'
import StrandActivityPanel from '~/features/threads/components/StrandActivityPanel.vue'
import StrandCanvas from './StrandCanvas.vue'
import { useStrandCanvas } from '~/composables/useStrandCanvas'
import type { ArtifactRef } from '~/api/artifacts'

/*
 * The chat surface. Used in two modes:
 *   - bound to a thread (`threadSessionId` set): history is loaded for exactly
 *     that session and every send carries its id;
 *   - legacy (no props): the backend picks the session, exactly as before
 *     threads existed.
 */
const props = defineProps<{
  threadSessionId?: string | null
  threadAgentId?: string | null
}>()

defineEmits<{ back: [] }>()
const boundToThread = computed(() => !!props.threadSessionId)
const { t } = useI18n()
const { formatTimeShort } = useFormat()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const settingsApi = useSettingsApi()

/* ── Thinking level quick-switch in the composer ──
   Backed by the same `thinkingLevel` setting as the Settings page; changes are
   live-applied to the agent (see `AgentCore.setThinkingLevel`). Admin-only
   because the main agent is single-tenant — flipping this affects everyone's
   next turn. */
const THINKING_LEVELS = SETTINGS_THINKING_LEVELS
const currentThinkingLevel = ref<SettingsThinkingLevel>('off')
const thinkingLevelPickerOpen = ref(false)
const thinkingLevelSaving = ref(false)

// Brain button color encodes thinking intensity (no text label needed):
// off=gray, minimal=white, low→xhigh progressively to red
const thinkingBrainColorClass = computed(() => {
  const map: Record<SettingsThinkingLevel, string> = {
    off: 'text-muted-foreground',
    minimal: 'text-foreground',
    low: 'text-yellow-500 dark:text-yellow-400',
    medium: 'text-orange-500 dark:text-orange-400',
    high: 'text-red-500 dark:text-red-400',
    xhigh: 'text-red-600 dark:text-red-500',
  }
  return map[currentThinkingLevel.value] ?? 'text-muted-foreground'
})

async function loadThinkingLevel() {
  if (!isAdmin.value) return
  try {
    const settings = await settingsApi.getSettings()
    if (settings.thinkingLevel && (SETTINGS_THINKING_LEVELS as readonly string[]).includes(settings.thinkingLevel)) {
      currentThinkingLevel.value = settings.thinkingLevel as SettingsThinkingLevel
    }
  } catch {
    // keep default 'off' if we can't reach the endpoint
  }
}

async function handleThinkingLevelChange(level: SettingsThinkingLevel) {
  if (level === currentThinkingLevel.value) {
    thinkingLevelPickerOpen.value = false
    return
  }
  const previous = currentThinkingLevel.value
  currentThinkingLevel.value = level // optimistic
  thinkingLevelPickerOpen.value = false
  thinkingLevelSaving.value = true
  try {
    await settingsApi.updateSettings({ thinkingLevel: level })
  } catch {
    // rollback on failure
    currentThinkingLevel.value = previous
  } finally {
    thinkingLevelSaving.value = false
  }
}
const { userAvatarUrl, avatarFailed, userInitial, onAvatarError } = useUserAvatar()
const { renderMarkdown, handleCopyAsMarkdown, handleMarkdownCodeCopy } = useMarkdown()

// The markdown renderer is a module and cannot reach i18n itself, so the chip
// tooltip is installed from here and kept in sync with the active locale.
watchEffect(() => setSecretChipTooltip(t('chat.secretChipTooltip')))
const { segmentsOf } = useInteractions()
const { apiFetch } = useApi()
const clientPersonas = ref<Array<{ id: string; displayName: string; color: string | null }>>([])
const speakerPersona = computed(() => clientPersonas.value.find(p => p.id === props.threadAgentId))
const personaLabel = computed(() => speakerPersona.value?.displayName || props.threadAgentId || t('w4Content.assistant'))
const personaInitials = computed(() => personaLabel.value.slice(0, 2).toUpperCase())
const personaColor = computed(() => /^#[0-9a-f]{6}$/i.test(speakerPersona.value?.color ?? '') ? speakerPersona.value!.color! : undefined)
onMounted(async () => {
  try { clientPersonas.value = (await apiFetch<{ personas: typeof clientPersonas.value }>('/api/personas/client')).personas }
  catch { /* A readable persona id remains when the optional catalog is unavailable. */ }
})
const { isSkillLoad, getSkillName } = useSkillDetection()
function isToolSkillLoad(toolData: ToolCallData): boolean { return isSkillLoad(toolData.toolName, toolData.toolArgs) }
function getToolMemoryInfo(toolData: ToolCallData) { return detectMemoryFile(toolData.toolName, toolData.toolArgs) }
function getToolEdits(toolData: ToolCallData) { return extractEditsFromArgs(toolData.toolArgs) }
function getToolMemoryFileName(toolData: ToolCallData) { return extractMemoryFileName(toolData.toolArgs) ?? undefined }
function isEditFileTool(toolData: ToolCallData) { return toolData.toolName === 'edit_file' || toolData.toolName === 'Edit' }
function getToolMemoryWriteContent(toolData: ToolCallData) { return extractMemoryWriteContent(toolData.toolName, toolData.toolArgs) }
function hasMemoryView(toolData: ToolCallData) {
  return (isEditFileTool(toolData) && getToolEdits(toolData) && getToolMemoryInfo(toolData).isMemoryFile)
    || getToolMemoryWriteContent(toolData) !== null
}
function toolDisplayName(toolData: ToolCallData): string {
  if (isToolSkillLoad(toolData)) return `Load Skill: ${getSkillName(toolData.toolArgs)}`
  const memInfo = getToolMemoryInfo(toolData)
  if (memInfo.isMemoryFile) return memInfo.label
  return formatToolName(toolData.toolName)
}
function toolSummary(toolData: ToolCallData): string | null {
  if (isToolSkillLoad(toolData)) return null
  const memInfo = getToolMemoryInfo(toolData)
  if (memInfo.isMemoryFile) return memInfo.displayPath
  return extractMemoryRelativePath(toolData.toolArgs) ?? getToolCallSummary(toolData.toolName, toolData.toolArgs)
}
function toolIconName(toolData: ToolCallData): string {
  if (isToolSkillLoad(toolData)) return 'puzzle'
  const memInfo = getToolMemoryInfo(toolData)
  if (memInfo.isMemoryFile) return memInfo.icon
  return 'settings'
}
const filterOpen = ref(false)
const FILTER_STORAGE_KEY = 'axiom-chat-filters'

function loadFilters() {
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return null
}

function saveFilters() {
  localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
    showToolCalls: showToolCalls.value,
    showInjections: showInjections.value,
    showSessionSummaries: showSessionSummaries.value,
    showThinking: showThinking.value,
  }))
}

const savedFilters = loadFilters()
const showToolCalls = ref(savedFilters?.showToolCalls ?? true)
const showInjections = ref(savedFilters?.showInjections ?? false)
const showSessionSummaries = ref(savedFilters?.showSessionSummaries ?? false)
// Thinking blocks default to visible (but collapsed) — mirrors TaskViewer behaviour.
const showThinking = ref(savedFilters?.showThinking ?? true)

watch([showToolCalls, showInjections, showSessionSummaries, showThinking], () => saveFilters())
const expandedSummaries = ref<Set<string>>(new Set())
function toggleSummary(id: string) { const updated = new Set(expandedSummaries.value); updated.has(id) ? updated.delete(id) : updated.add(id); expandedSummaries.value = updated }

const filteredMessages = computed(() => {
  return messages.value.filter((msg) => {
    if (!showToolCalls.value && msg.role === 'tool' && msg.toolData) return false
    if (!showInjections.value && msg.role === 'system' && (msg.isTaskResult || msg.isTaskStatusUpdate)) return false
    if (!showThinking.value && msg.isThinking) return false
    return true
  })
})
const transcriptRows = computed(() => groupTranscript(filteredMessages.value))
const contentState = computed(() => transcriptState(!!historyError.value, loadingHistory.value, messages.value.length))
const expandedTools = ref<Set<string>>(new Set())
function toggleTool(toolCallId: string) { const updated = new Set(expandedTools.value); updated.has(toolCallId) ? updated.delete(toolCallId) : updated.add(toolCallId); expandedTools.value = updated }
const expandedInjections = ref<Set<number>>(new Set())
function toggleInjection(index: number) { const updated = new Set(expandedInjections.value); updated.has(index) ? updated.delete(index) : updated.add(index); expandedInjections.value = updated }
// Thinking blocks default to collapsed per-message. We keep a Set of expanded IDs
// (the DB row id when loaded from history, otherwise the array index fallback)
// mirroring how tool calls/injections/summaries are toggled.
const expandedThinking = ref<Set<string>>(new Set())
function toggleThinking(id: string) { const updated = new Set(expandedThinking.value); updated.has(id) ? updated.delete(id) : updated.add(id); expandedThinking.value = updated }
/**
 * Interactive blocks of one assistant message (SPEC 7.4c). Parsing is
 * defensive: a broken block degrades to text, it never breaks the renderer.
 */
function messageSegments(msg: ChatMessage) {
  const content = msg.content ?? ''
  const cached = segmentCache.get(content)
  if (cached) return cached
  const segments = segmentsOf(content)
  // The template asks several times per message (card? text? bubble body?);
  // parsing once per distinct content keeps that free and hands out stable
  // array identities.
  if (segmentCache.size > 200) segmentCache.clear()
  segmentCache.set(content, segments)
  return segments
}
const segmentCache = new Map<string, ReturnType<typeof segmentsOf>>()

/** The one card of an assistant message, or null (the parser allows only one). */
function interactionCard(msg: ChatMessage) {
  if (msg.role !== 'assistant') return null
  for (const segment of messageSegments(msg)) if (segment.type === 'block') return segment.block
  return null
}

/** Everything of an assistant message that stays inside the bubble. */
function messageTextSegments(msg: ChatMessage) {
  return messageSegments(msg).filter(segment => segment.type === 'text')
}

/**
 * Does the bubble carry anything at all next to the card? A message that is
 * nothing but a card gets the speaker line and the card — an empty bubble
 * above it would be one box too many.
 */
function hasBubbleBody(msg: ChatMessage): boolean {
  if (messageTextSegments(msg).some(segment => segment.text.trim().length > 0)) return true
  return !!msg.attachments?.length || !!msg.artifacts?.length || !!msg.streaming
}

/**
 * A free text answer is an ordinary user message, so it leaves no trace in
 * `interactionAnswers`. Any later user message means the question was dealt
 * with in the chat, and the card renders closed instead of inviting a second
 * answer to a turn that has long moved on.
 */
function answeredElsewhere(index: number): boolean {
  const rows = filteredMessages.value
  for (let i = index + 1; i < rows.length; i++) {
    if (rows[i]?.role === 'user') return true
  }
  return false
}

/**
 * Free text from a card. It goes out through the ordinary composer send path
 * (`useChat().sendMessage`), so the backend sees a plain user message and the
 * composer keeps whatever the user had typed there.
 */
async function handleOwnAnswer(text: string) {
  const value = text.trim()
  if (!value || connectionStatus.value !== 'connected') return
  await sendMessage(value)
}

/** Expanded full reports of task cards, keyed by message index. */
const taskReports = ref<Map<number, string>>(new Map())
const taskReportLoading = ref<Set<number>>(new Set())
const taskReportError = ref<Map<number, boolean>>(new Map())

function taskResultVisibleBody(msg: ChatMessage, index: number): string {
  const full = taskReports.value.get(index)
  if (full) return full
  const body = taskResultBody(msg.content)
  // The persisted content ends with a pointer line ("…N more characters —
  // open the task card…") for clients without this card. Here the button
  // right below says the same thing, so drop it.
  return msg.taskResultTruncated
    ? body.replace(/\n*…\d+ more characters[^\n]*$/, '').trimEnd()
    : body
}

/**
 * Fetch the full report from `GET /api/tasks/:id` on first expand. The
 * message row only ever carried the preview — this is where the rest lives.
 */
async function toggleTaskReport(msg: ChatMessage, index: number) {
  if (taskReports.value.has(index)) {
    const next = new Map(taskReports.value)
    next.delete(index)
    taskReports.value = next
    return
  }
  const taskId = msg.taskResultTaskId
  if (!taskId || taskReportLoading.value.has(index)) return

  taskReportLoading.value = new Set(taskReportLoading.value).add(index)
  const errors = new Map(taskReportError.value)
  errors.delete(index)
  taskReportError.value = errors
  try {
    const res = await apiFetch<{ task: { resultSummary?: string | null; errorMessage?: string | null } }>(`/api/tasks/${taskId}`)
    const body = res.task?.resultSummary || res.task?.errorMessage || t('chat.taskResult.empty')
    taskReports.value = new Map(taskReports.value).set(index, body)
  } catch {
    taskReportError.value = new Map(taskReportError.value).set(index, true)
  } finally {
    const loading = new Set(taskReportLoading.value)
    loading.delete(index)
    taskReportLoading.value = loading
  }
}

function taskResultBody(content: string): string {
  const lines = (content ?? '').split('\n')
  const bodyLines = lines.slice(1)
  while (bodyLines.length > 0 && bodyLines[0]!.trim() === '') bodyLines.shift()
  return bodyLines.join('\n') || content
}
// Compact token count for the heartbeat row: 12345 -> "12.3k".
function formatTokenCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}
// Stall duration badge: 45000 -> "45s", 125000 -> "2m 5s".
function formatStallDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
}
const canvas = useStrandCanvas(() => boundSessionId.value ?? null)

/** Tapping the one line opens the canvas on exactly that revision. */
function openCanvasAt(artifact: ArtifactRef): void {
  if (!artifact.viewKey) return
  canvas.open(artifact.viewKey, artifact.revision ?? undefined)
}

const {
  messages,
  connectionStatus,
  isStreaming,
  loadingHistory,
  queuePosition,
  sessionError,
  boundSessionId,
  boundAgentId,
  sessionActivity,
  connect,
  disconnect,
  sendMessage,
  newSession,
  stopTask,
  resolvePicker,
  submitChatAction,
  openThread,
  leaveThread,
  loadRecentHistory,
} = useChat()

// The strand header resolves its persona independently of history loading.
watch(() => props.threadAgentId, agentId => {
  if (boundSessionId.value === props.threadSessionId) boundAgentId.value = agentId ?? null
})

const sessionErrorText = computed(() => {
  switch (sessionError.value) {
    case 'session_not_found': return t('threads.sessionErrorNotFound')
    case 'session_agent_mismatch': return t('threads.sessionErrorAgentMismatch')
    case 'session_forbidden': return t('threads.sessionErrorForbidden')
    default: return ''
  }
})

/** Message ids with an in-flight action click, so buttons can't be double-fired. */
const pendingChatActions = ref<Set<string>>(new Set())

async function handleChatAction(messageId: string, actionId: string) {
  if (pendingChatActions.value.has(messageId)) return
  pendingChatActions.value = new Set(pendingChatActions.value).add(messageId)
  try {
    await submitChatAction(messageId, actionId)
  } finally {
    const updated = new Set(pendingChatActions.value)
    updated.delete(messageId)
    pendingChatActions.value = updated
  }
}

/**
 * Map a clicked picker option back to the position of its message inside
 * `messages.value`. We can't use the `i` from the v-for directly because
 * `filteredMessages` filters out e.g. tool calls / task injections, so its
 * indices don't line up with the underlying array.
 */
function handlePickerSelect(msg: ChatMessage, command: string) {
  const idx = messages.value.indexOf(msg)
  if (idx === -1) return
  resolvePicker(idx, command)
}
const { playingIndex: ttsPlayingIndex, loading: ttsLoading, ttsEnabled, error: ttsError, fetchTtsSettings, play: ttsPlay, stop: ttsStop, clearError: clearTtsError } = useTts()
const {
  phase: dictationPhase, error: dictationError, canRetry: dictationCanRetry, elapsedMs: dictationElapsed, levels: dictationLevels,
  sttEnabled, fetchSttSettings, start: sttStart, stop: sttStop, retry: sttRetry, cancel: sttCancel, dismiss: sttDismiss, cleanup: sttCleanup,
} = useStt()

function handleTtsPlay(content: string, index: number) {
  ttsPlay(content, index)
}
const chatStatusText = computed(() => connectionStatus.value === 'connected' ? t('chat.statusConnected') : connectionStatus.value === 'connecting' ? t('chat.statusConnecting') : t('chat.statusDisconnected'))
const inputText = ref('')
const pendingFiles = ref<File[]>([])
/** Kept dictation recordings (already stored on the server), sent with the message. */
const pendingAudio = ref<Array<{ attachment: ChatAttachment; durationMs: number }>>([])
// True when there's text or pending files — drives mic↔send swap on mobile
const hasText = computed(() => inputText.value.trim().length > 0 || pendingFiles.value.length > 0 || pendingAudio.value.length > 0)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messagesContainer = ref<HTMLDivElement | null>(null)
const historyError = ref(false)
const isNearBottom = ref(true)
const SCROLL_THRESHOLD = 120
function onMessagesScroll() { const el = messagesContainer.value; if (!el) return; isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD }
function jumpToBottom() { isNearBottom.value = true; nextTick(() => scrollToBottom()) }
// History must be in place before the socket opens: connecting attaches to a
// still-running turn and replays it, and a later history load would wipe that
// replayed tail. A failed history load must never keep the socket closed —
// chatting still works, the transcript just starts empty.
onMounted(async () => {
  await reloadHistory()
  connect()
  await Promise.all([fetchTtsSettings(), fetchSttSettings(), loadThinkingLevel()])
})
onUnmounted(() => {
  disconnect()
  if (boundToThread.value) leaveThread()
  ttsStop()
  sttCleanup()
})
watch(() => messages.value.length, () => {
  if (isNearBottom.value) nextTick(() => scrollToBottom())
  // Reset sessionResetting flag when a divider appears (session_end received)
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'divider') sessionResetting.value = false
})
watch(() => messages.value[messages.value.length - 1]?.content?.length ?? 0, () => { if (isNearBottom.value) nextTick(() => scrollToBottom()) })
/**
 * (Re)load the transcript. In thread mode this binds the chat to the thread's
 * session; in legacy mode it loads the newest page across all sessions.
 * A failed load never blocks the socket — chatting still works, the transcript
 * just starts empty and offers a retry.
 */
async function reloadHistory() {
  historyError.value = false
  try {
    if (props.threadSessionId) {
      await openThread(props.threadSessionId, props.threadAgentId ?? null)
    } else {
      await loadRecentHistory()
    }
  } catch (err) {
    console.error('[chat] history load failed:', err)
    historyError.value = true
  } finally {
    nextTick(() => scrollToBottom())
  }
}
const skillAutocomplete = useSkillAutocomplete(inputText)

function handleSkillSelect(skill: LoadableSkill) {
  skillAutocomplete.select(skill)
  inputRef.value?.focus()
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (skillAutocomplete.handleKeydown(event)) return
  if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) {
    event.preventDefault()
    void handleSend()
  }
}

async function handleSend() {
  const files = [...pendingFiles.value]
  const stored = pendingAudio.value.map(item => item.attachment)
  const text = inputText.value
  if ((!text.trim() && files.length === 0 && stored.length === 0) || connectionStatus.value !== 'connected') return
  await sendMessage(text, files, stored)
  inputText.value = ''
  pendingFiles.value = []
  pendingAudio.value = []
  if (inputRef.value) inputRef.value.style.height = 'auto'
}
const sessionResetting = ref(false)
function handleNewSession() {
  if (sessionResetting.value) return
  sessionResetting.value = true
  newSession()
}
function handleStop() { stopTask() }
function scrollToBottom() { if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight }
function autoResize() { const el = inputRef.value; if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px' }
function handleFileSelection(event: Event) { const target = event.target as HTMLInputElement; const files = Array.from(target.files || []); pendingFiles.value = [...pendingFiles.value, ...files]; target.value = '' }
function removePendingFile(index: number) { pendingFiles.value.splice(index, 1) }

// ── Drag & drop file upload ─────────────────────────────────────────
// We use a counter for dragenter/dragleave because those events bubble
// up through every child element, which would otherwise cause the overlay
// to flicker on/off whenever the cursor crosses a nested boundary.
const isDraggingFiles = ref(false)
const dragCounter = ref(0)

function dragHasFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  if (!types) return false
  // Different browsers report 'Files' in slightly different ways; a plain
  // includes check works for all of Chromium, Firefox and Safari.
  return Array.from(types).includes('Files')
}

function handleDragEnter(event: DragEvent) {
  if (!dragHasFiles(event)) return
  dragCounter.value++
  isDraggingFiles.value = true
}

function handleDragOver(event: DragEvent) {
  if (!dragHasFiles(event)) return
  // Signal to the browser that we accept this drop (shows the "copy" cursor).
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function handleDragLeave(event: DragEvent) {
  if (!dragHasFiles(event)) return
  dragCounter.value = Math.max(0, dragCounter.value - 1)
  if (dragCounter.value === 0) isDraggingFiles.value = false
}

function handleDrop(event: DragEvent) {
  dragCounter.value = 0
  isDraggingFiles.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  pendingFiles.value = [...pendingFiles.value, ...files]
}

// ── Dictation (click to start, click / Ctrl+M / Done to finish) ─────
// The phase logic is the pure reducer in utils/dictation.ts; useStt owns the
// microphone. The text goes in at the caret and is never sent automatically.
const DICTATION_LEVEL_BARS = 24
/** Caret of the textarea when the dictation started (focus moves to the bar). */
let dictationSelection: { start: number; end: number } | null = null
const dictationAnnouncement = ref('')
const micLabel = computed(() => dictationPhase.value === 'recording' ? t('chat.dictation.stop') : dictationPhase.value === 'transcribing' ? t('chat.dictation.transcribing') : t('chat.dictation.start'))

function rememberSelection() {
  const el = inputRef.value
  dictationSelection = el && typeof el.selectionStart === 'number'
    ? { start: el.selectionStart, end: el.selectionEnd ?? el.selectionStart }
    : { start: inputText.value.length, end: inputText.value.length }
}

async function startDictation() {
  rememberSelection()
  dictationAnnouncement.value = ''
  await sttStart()
}

function applyDictation(result: DictationResult | null) {
  if (!result) return
  if (result.audio) pendingAudio.value = [...pendingAudio.value, { attachment: result.audio, durationMs: result.durationMs }]
  if (!result.text) return
  const selection = dictationSelection ?? { start: inputText.value.length, end: inputText.value.length }
  const { value, caret } = insertAtCursor(inputText.value, result.text, selection.start, selection.end)
  inputText.value = value
  dictationSelection = { start: caret, end: caret }
  dictationAnnouncement.value = t('chat.dictation.inserted')
  nextTick(() => {
    const el = inputRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
    autoResize()
  })
}

async function finishDictation() {
  applyDictation(await sttStop())
}

async function retryDictation() {
  applyDictation(await sttRetry())
}

function cancelDictation() {
  sttCancel()
  dictationAnnouncement.value = t('chat.dictation.cancelled')
  nextTick(() => inputRef.value?.focus())
}

function dismissDictation() {
  sttDismiss()
  nextTick(() => inputRef.value?.focus())
}

async function toggleDictation() {
  if (dictationPhase.value === 'recording') await finishDictation()
  else if (dictationPhase.value === 'idle' || dictationPhase.value === 'error') await startDictation()
}

// Esc cancels a running recording even when the focus has left the composer.
function handleGlobalDictationEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && (dictationPhase.value === 'recording' || dictationPhase.value === 'starting')) {
    event.preventDefault()
    cancelDictation()
  }
}
watch(dictationPhase, (phase) => {
  if (typeof window === 'undefined') return
  if (phase === 'recording' || phase === 'starting') window.addEventListener('keydown', handleGlobalDictationEscape)
  else window.removeEventListener('keydown', handleGlobalDictationEscape)
})
onUnmounted(() => { if (typeof window !== 'undefined') window.removeEventListener('keydown', handleGlobalDictationEscape) })

function removePendingAudio(index: number) {
  pendingAudio.value = pendingAudio.value.filter((_, i) => i !== index)
}

/** Ctrl+M toggles, Esc cancels — only while the composer is the active area. */
function handleComposerAreaKeydown(event: KeyboardEvent) {
  if (!sttEnabled.value) return
  if (isDictationShortcut(event)) {
    event.preventDefault()
    void toggleDictation()
    return
  }
  if (event.key === 'Escape' && (dictationPhase.value === 'recording' || dictationPhase.value === 'starting')) {
    event.preventDefault()
    event.stopPropagation()
    cancelDictation()
  }
}

</script>
