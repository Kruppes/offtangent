<script setup lang="ts">
const editorId = useId()
const props = defineProps<{
  modelValue: string
  saving?: boolean
  filePath?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'save'): void
}>()

const { t } = useI18n()

const content = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})
</script>

<template>
  <div class="flex flex-1 flex-col overflow-auto min-h-0">
    <!-- Editor with optional file path header -->
    <div class="flex flex-1 flex-col overflow-auto min-h-0 rounded-xl border border-border bg-card" :class="filePath ? '' : 'contents'">
      <!-- File path bar -->
      <div v-if="filePath" class="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <AppIcon name="file" class="h-3.5 w-3.5 text-muted-foreground" />
        <label :for="editorId" class="font-mono text-xs text-muted-foreground">{{ filePath }}</label>
      </div>

      <!-- Editor -->
      <textarea
        :id="editorId"
        v-model="content"
        :placeholder="t('memory.editorPlaceholder')"
        spellcheck="false"
        class="w-full flex-1 min-h-0 resize-none p-4 font-mono text-sm text-foreground placeholder:text-muted-foreground leading-6 focus:outline-none transition-colors overflow-y-auto"
        :class="filePath ? 'bg-transparent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring' : 'rounded-xl border border-border bg-card focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background'"
      />
    </div>

    <!-- Footer -->
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 pt-3">
      <div class="flex flex-wrap items-center gap-2">
        <slot name="footerActions" />
      </div>

      <Button :disabled="saving" @click="$emit('save')">
        <span
          v-if="saving"
          class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-transparent border-t-current"
          aria-hidden="true"
        />
        {{ t('memory.save') }}
      </Button>
    </div>
  </div>
</template>
