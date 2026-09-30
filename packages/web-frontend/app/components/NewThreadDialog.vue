<script setup lang="ts">
/*
 * Start a new thread: pick the persona, optionally name it. The dialog is a
 * reka-ui Dialog, so focus is trapped and Escape closes it.
 */
const props = defineProps<{
  open: boolean
  personas: string[]
  loading?: boolean
  defaultPersona?: string | null
}>()

const emit = defineEmits<{
  close: []
  submit: [payload: { agentId: string; title?: string }]
}>()

const agentId = ref('')
const title = ref('')

watch(() => props.open, (open) => {
  if (!open) return
  agentId.value = props.defaultPersona || props.personas[0] || ''
  title.value = ''
}, { immediate: true })

function onSubmit() {
  if (!agentId.value || props.loading) return
  emit('submit', { agentId: agentId.value, title: title.value.trim() || undefined })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('close')">
    <DialogContent class="w-[calc(100vw-1.5rem)] max-w-md p-0">
      <form class="flex flex-col" @submit.prevent="onSubmit">
        <DialogHeader class="px-6 pb-4 pt-6">
          <DialogTitle>{{ $t('threads.newThread') }}</DialogTitle>
          <DialogDescription>{{ $t('threads.newThreadDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4 px-6 pb-6">
          <div class="space-y-2">
            <Label>{{ $t('threads.persona') }}</Label>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="persona in personas"
                :key="persona"
                type="button"
                class="flex min-h-[44px] items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors"
                :class="persona === agentId
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border text-foreground hover:bg-accent'"
                @click="agentId = persona"
              >
                <AppIcon name="bot" class="h-4 w-4" />
                <span class="truncate">{{ persona }}</span>
              </button>
            </div>
            <p v-if="personas.length === 0" class="text-xs text-muted-foreground">
              {{ $t('threads.noPersonas') }}
            </p>
          </div>

          <div class="space-y-2">
            <Label for="new-thread-title">{{ $t('threads.titleOptional') }}</Label>
            <Input
              id="new-thread-title"
              v-model="title"
              class="min-h-[44px]"
              :placeholder="$t('threads.titlePlaceholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('threads.titleHint') }}</p>
          </div>
        </div>

        <DialogFooter class="flex flex-col-reverse gap-2 border-t border-border px-6 py-4 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" class="min-h-[44px]" @click="emit('close')">
            {{ $t('common.cancel') }}
          </Button>
          <Button type="submit" class="min-h-[44px]" :disabled="!agentId || loading">
            {{ loading ? $t('common.saving') : $t('threads.create') }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
