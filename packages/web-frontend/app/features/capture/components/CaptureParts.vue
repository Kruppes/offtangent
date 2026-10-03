<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CaptureResult, CapturePart } from '~/api/captures'
import { partLabel, partState, partsOf } from '../captureParts'

/**
 * The parts of a capture the backend split by topic: one row per part with
 * Keep, Move to and Undo, the original part on request, and the escape hatch
 * "Keep as one" that routes the original text as a single capture.
 */
const props = defineProps<{
  result: CaptureResult
  busy: boolean
  /** Destinations for "Move to"; the current target is filtered out per part. */
  strands: { id: string; title: string | null }[]
  titleForId?: (id?: string | null) => string | null | undefined
}>()
const emit = defineEmits<{ keep: [part: CapturePart]; move: [part: CapturePart, strandId: string]; undo: [part: CapturePart]; keepAsOne: [] }>()
const parts = computed(() => partsOf(props.result))
const moveTarget = ref<Record<number, string>>({})
const openOriginal = ref<number | null>(null)
function destination(part: CapturePart) {
  const id = part.decision.strandId ?? part.decision.createdStrandId
  return props.titleForId?.(id) || part.decision.title || null
}
function options(part: CapturePart) {
  const current = part.decision.strandId ?? part.decision.createdStrandId
  return props.strands.filter(s => s.id !== current)
}
function move(part: CapturePart) {
  const id = moveTarget.value[part.index]
  if (id) emit('move', part, id)
}
</script>

<template>
  <section class="space-y-2 rounded-lg border border-border p-3" data-testid="capture-parts" :aria-label="$t('home.parts.label', { count: parts.length })">
    <h4 class="text-sm font-semibold">{{ $t('home.parts.heading', { count: parts.length }) }}</h4>
    <ol class="space-y-2">
      <li v-for="part in parts" :key="part.index" class="space-y-2 rounded-md bg-muted p-3 [overflow-wrap:anywhere]" data-testid="capture-part">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span class="text-xs font-medium text-muted-foreground">{{ $t('home.parts.number', { n: part.index + 1 }) }}</span>
          <span class="font-medium">{{ partLabel(part) }}</span>
          <span class="rounded-full px-2 text-xs" :class="partState(part) === 'placed' ? 'bg-primary-subtle text-primary' : 'bg-muted text-muted-foreground'">{{ $t(`home.parts.state.${partState(part)}`) }}</span>
        </div>
        <p class="text-sm text-muted-foreground">
          {{ $t(part.decision.action === 'new_strand' ? 'home.parts.toNew' : 'home.parts.to') }}
          <span class="font-medium text-foreground">{{ destination(part) || $t('capture.untitled') }}</span>
        </p>
        <div class="flex flex-wrap items-end gap-2">
          <Button v-if="partState(part) === 'open'" variant="default" class="min-h-11" :disabled="busy" data-testid="part-keep" @click="emit('keep', part)">{{ $t('home.parts.keep') }}</Button>
          <Button v-if="partState(part) === 'placed'" variant="outline" class="min-h-11" :disabled="busy" data-testid="part-undo" @click="emit('undo', part)">{{ $t('home.parts.undo') }}</Button>
          <label v-if="options(part).length" class="flex min-w-0 flex-1 basis-full flex-col gap-1 text-sm sm:basis-auto sm:max-w-xs">
            <span>{{ $t('home.parts.moveTo') }}</span>
            <select v-model="moveTarget[part.index]" :disabled="busy" class="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <option value="">{{ $t('capture.chooseStrand') }}</option>
              <option v-for="s in options(part)" :key="s.id" :value="s.id">{{ s.title || $t('capture.untitled') }}</option>
            </select>
          </label>
          <Button v-if="options(part).length" variant="outline" class="min-h-11" :disabled="busy || !moveTarget[part.index]" data-testid="part-move" @click="move(part)">{{ $t('home.parts.move') }}</Button>
          <Button variant="ghost" class="min-h-11" :aria-expanded="openOriginal === part.index" :aria-controls="`original-${result.capture.id}-${part.index}`" data-testid="part-original" @click="openOriginal = openOriginal === part.index ? null : part.index">{{ $t('unsorted.original.show') }}</Button>
        </div>
        <div v-if="openOriginal === part.index" :id="`original-${result.capture.id}-${part.index}`" class="space-y-2 rounded-md border border-border bg-background p-3 text-sm" data-testid="part-original-view">
          <p class="font-medium">{{ $t('unsorted.original.part') }}</p>
          <p class="whitespace-pre-wrap">{{ part.text }}</p>
          <p v-if="part.sentenceIds.length" class="text-xs text-muted-foreground">{{ $t('unsorted.original.sentences', { list: part.sentenceIds.join(', ') }) }}</p>
          <p class="font-medium">{{ $t('unsorted.original.capture') }}</p>
          <p class="whitespace-pre-wrap text-muted-foreground">{{ result.capture.text }}</p>
        </div>
      </li>
    </ol>
    <div class="flex flex-wrap items-center gap-2 border-t border-border pt-2">
      <Button variant="outline" class="min-h-11" :disabled="busy" data-testid="keep-as-one" @click="emit('keepAsOne')">{{ $t('home.parts.keepAsOne') }}</Button>
      <span class="text-xs text-muted-foreground">{{ $t('home.parts.keepAsOneHint') }}</span>
    </div>
  </section>
</template>
