<script setup lang="ts">
import { computed, ref } from 'vue'
import type { CaptureResult, ApplyCaptureInput } from '~/api/captures'
const props = defineProps<{ result: CaptureResult; busy: boolean; strandTitle?: string | null; titleForId?: (id?: string | null) => string | null | undefined }>()
const newTitle = ref('')
const review = computed(() => ['needs_review', 'unsorted', 'failed'].includes(props.result.capture.status) || props.result.decision.confidence < .7)
const confidence = computed(() => Math.max(0, Math.min(100, Math.round(props.result.decision.confidence * 100))))
defineEmits<{ undo: []; apply: [body: ApplyCaptureInput]; dismiss: [] }>()
</script>
<template>
  <article class="rounded-xl border bg-card p-4 space-y-3 break-words" data-testid="decision">
    <p class="text-sm font-medium">{{ $t(`capture.status.${result.capture.status}`) }}</p>
    <p v-if="review" data-testid="review-band" class="rounded-md border-l-4 border-primary bg-muted p-3 font-medium">{{ $t('capture.reviewRequired') }}</p>
    <blockquote class="whitespace-pre-wrap text-sm" data-testid="capture-excerpt">{{ result.capture.text.slice(0, 400) }}{{ result.capture.text.length > 400 ? '…' : '' }}</blockquote>
    <time :datetime="result.capture.createdAt" class="text-sm text-muted-foreground">{{ new Date(result.capture.createdAt).toLocaleString() }}</time>
    <p v-if="result.capture.attachments.length" class="text-sm text-muted-foreground">{{ $t('capture.attachmentCount', { count: result.capture.attachments.length }) }} · {{ result.capture.attachments.map(a => a.originalName).join(', ') }}</p>
    <h3 class="font-semibold">{{ strandTitle || result.decision.title || result.capture.text.slice(0, 80) }}</h3>
    <p v-if="result.decision.strandId && result.decision.strandId !== result.capture.strandId" class="text-sm text-muted-foreground">{{ $t('capture.proposedDestination') }} {{ titleForId?.(result.decision.strandId) || result.decision.title || $t('capture.untitled') }}</p>
    <p>{{ $t(`capture.action.${result.decision.action}`) }} · {{ $t('capture.confidence', { value: Math.round(result.decision.confidence * 100) }) }}</p>
    <div role="progressbar" :aria-label="$t('capture.confidenceLabel')" :aria-valuenow="confidence" :aria-valuemin="0" :aria-valuemax="100" class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full bg-primary" :style="{ width: confidence + '%' }" /></div>
    <p class="text-sm text-muted-foreground">{{ result.decision.rationale.slice(0, 240) }}{{ result.decision.rationale.length > 240 ? '…' : '' }}</p>
    <div class="flex flex-wrap gap-2">
      <NuxtLink v-if="result.capture.strandId" :to="`/strands/${encodeURIComponent(result.capture.strandId)}`" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 inline-flex min-h-11 items-center rounded-md border px-3">{{ $t('capture.openStrand') }}</NuxtLink>
      <Button variant="outline" v-if="['applied', 'confirmed'].includes(result.decision.state) || result.capture.status === 'dismissed'" class="min-h-11 min-w-11 rounded-md border px-3" :disabled="busy" @click="$emit('undo')">{{ $t(result.capture.status === 'dismissed' ? 'capture.restore' : 'capture.undo') }}</Button>
      <Button variant="outline" v-if="['unsorted', 'needs_review', 'failed'].includes(result.capture.status)" class="min-h-11 rounded-md bg-primary px-3 text-primary-foreground" :disabled="busy" @click="$emit('apply', { decisionId: result.decision.id })">{{ $t('capture.apply') }}</Button>
      <Button variant="outline" v-if="['unsorted', 'failed'].includes(result.capture.status)" class="min-h-11 rounded-md border px-3" :disabled="busy" @click="$emit('dismiss')">{{ $t('capture.discard') }}</Button>
    </div>
    <details v-if="result.decision.alternatives.length" :open="result.decision.confidence < .7">
      <summary class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-11 cursor-pointer py-3">{{ $t('capture.alternatives') }}</summary>
      <div v-for="(alternative, index) in result.decision.alternatives" :key="index" class="mt-2 rounded-md border p-3">
        <p>{{ titleForId?.(alternative.strandId) || alternative.title || alternative.strandId || $t('capture.action.new_strand') }} · {{ $t(`capture.action.${alternative.action}`) }} · {{ Math.round(alternative.confidence * 100) }}%</p>
        <p class="text-sm text-muted-foreground">{{ alternative.reason }}</p>
        <Button variant="outline" class="mt-2 min-h-11 rounded-md border px-3" :disabled="busy" @click="$emit('apply', { decisionId: result.decision.id, action: alternative.action, ...(alternative.strandId ? { strandId: alternative.strandId } : {}), ...(alternative.title ? { title: alternative.title } : {}) })">{{ $t('capture.choose') }}</Button>
      </div>
    </details>
    <form v-if="review" class="space-y-2 rounded-md border p-3" @submit.prevent="$emit('apply', { decisionId: result.decision.id, action: 'new_strand', title: newTitle.trim() })">
      <label class="block">{{ $t('capture.newStrandTitle') }}<input v-model="newTitle" type="text" required maxlength="200" :disabled="busy" class="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3" /></label>
      <Button type="submit" variant="outline" class="min-h-11" :disabled="busy || !newTitle.trim()">{{ $t('capture.fileNew') }}</Button>
    </form>
  </article>
</template>
