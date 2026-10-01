<template>
    <!-- A revision of a living view leaves ONE line in the
         transcript, not a card: the canvas is where it is read, the
         chat only says that it changed and why. A one-off canvas
         keeps its card. -->
    <template v-for="artifact in artifacts" :key="artifact.id">
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
</template>

<script setup lang="ts">
import type { ArtifactRef } from '~/api/artifacts'
import { useChatView } from '~/composables/chat/chatViewContext'

/** The canvases a message produced: a card for a one-off, one trail line per living-view revision. */
defineProps<{ artifacts: ArtifactRef[] }>()

const { openCanvasAt } = useChatView()
</script>
