<script setup lang="ts">
import type { ModelSelection, SelectableModel } from '~/api/models'

const props = defineProps<{
  open: boolean
  models: SelectableModel[]
  pinned: ModelSelection | null
  loading?: boolean
  error?: string | null
  saving?: boolean
}>()
const emit = defineEmits<{ close: []; retry: []; select: [selection: ModelSelection | null] }>()
const grouped = computed(() => {
  const groups: Record<string, SelectableModel[]> = {}
  for (const model of props.models) (groups[model.providerName] ??= []).push(model)
  return Object.entries(groups)
})
function quotaLine(model: SelectableModel) {
  if (!model.quota) return ''
  if (model.quota.error) return model.quota.error
  return model.quota.windows.map(window => `${window.label}: ${window.utilization}%${window.resetsAt ? ` · Reset ${new Date(window.resetsAt).toLocaleString()}` : ''}`).join(' · ')
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('close')">
    <DialogContent class="w-[calc(100vw-1rem)] max-w-lg p-0">
      <DialogHeader class="px-5 pb-3 pt-5">
        <DialogTitle>{{ $t('threads.modelPickerTitle') }}</DialogTitle>
        <DialogDescription>{{ $t('threads.modelPickerDescription') }}</DialogDescription>
      </DialogHeader>
      <div class="max-h-[70vh] overflow-y-auto px-3 pb-4 sm:px-5">
        <div v-if="loading" class="space-y-3" aria-busy="true">
          <Skeleton v-for="index in 4" :key="index" class="h-14 w-full" />
        </div>
        <div v-else-if="error" class="rounded-lg border border-destructive/30 p-4 text-sm">
          <p class="text-destructive">{{ error }}</p>
          <Button class="mt-3 min-h-11" variant="outline" @click="emit('retry')">{{ $t('threads.retry') }}</Button>
        </div>
        <div v-else-if="models.length === 0" class="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          {{ $t('threads.noModelsConfigured') }}
          <NuxtLink to="/providers" class="mt-3 block font-medium text-primary underline">{{ $t('threads.openProviderSettings') }}</NuxtLink>
        </div>
        <div v-else class="space-y-5">
          <button
            type="button"
            class="flex min-h-11 w-full items-center rounded-lg border px-3 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            :class="!pinned ? 'border-primary bg-primary/5' : 'border-border'"
            :disabled="saving"
            @click="emit('select', null)"
          >
            {{ $t('threads.useDefaultModel') }}
          </button>
          <section v-for="([provider, entries]) in grouped" :key="provider">
            <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ provider }}</h3>
            <div class="space-y-2">
              <button
                v-for="model in entries"
                :key="`${model.providerId}:${model.modelId}`"
                type="button"
                class="flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :class="model.selectable ? 'hover:bg-muted' : 'cursor-not-allowed opacity-45'"
                :disabled="!model.selectable || saving"
                :title="model.unavailableReason || undefined"
                @click="emit('select', model)"
              >
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ model.displayName }}</span>
                  <span v-if="quotaLine(model)" class="block truncate text-xs text-muted-foreground">{{ quotaLine(model) }}</span>
                </span>
                <Badge :variant="model.status === 'error' ? 'destructive' : 'muted'">{{ model.status }}</Badge>
              </button>
            </div>
          </section>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
