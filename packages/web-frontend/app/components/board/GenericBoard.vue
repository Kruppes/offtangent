<script setup lang="ts">
import { computed, ref } from 'vue'
import { renderSafeMarkdown } from '~/composables/useMarkdown'

const props = defineProps<{ summary: string | null; payload: unknown; kind: string }>()
const open = ref(false)
const pretty = computed(() => {
  try {
    return JSON.stringify(props.payload, null, 2) ?? ''
  } catch {
    return ''
  }
})
const isEmpty = computed(() => !props.summary && (!pretty.value || pretty.value === '{}'))
</script>

<template>
  <div class="flex flex-col gap-4 [overflow-wrap:anywhere]">
    <p role="status" class="measure text-sm text-muted-foreground">{{ $t('boards.unknownKind', { kind }) }}</p>
    <p v-if="isEmpty" class="rounded-lg border p-6 text-center text-muted-foreground">{{ $t('boards.emptyPayload') }}</p>
    <!-- eslint-disable-next-line vue/no-v-html -- renderSafeMarkdown escapes raw HTML and drops non-http(s) links. -->
    <div v-if="summary" class="prose-chat measure break-words text-sm" v-html="renderSafeMarkdown(summary)" />
    <section v-if="pretty && pretty !== '{}'" class="rounded-lg border bg-card text-card-foreground">
      <button type="button" class="flex min-h-[44px] w-full items-center gap-2 px-4 text-left text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        :aria-expanded="open" aria-controls="board-raw-json" @click="open = !open">
        <AppIcon :name="open ? 'chevronDown' : 'chevronRight'" />{{ $t('boards.rawData') }}
      </button>
      <pre v-show="open" id="board-raw-json" class="max-h-96 overflow-auto px-4 pb-4 font-mono text-xs leading-5">{{ pretty }}</pre>
    </section>
  </div>
</template>
