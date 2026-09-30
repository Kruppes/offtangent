<template>
  <Dialog :open="open" @update:open="(v: boolean) => { if (!v) emit('cancel') }">
    <DialogContent class="max-h-[90dvh] max-w-sm overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>

      <DialogFooter>
        <Button class="min-h-11 min-w-11" variant="outline" :disabled="loading" @click="emit('cancel')">
          {{ resolvedCancelLabel }}
        </Button>
        <Button class="min-h-11 min-w-11" :variant="destructive ? 'destructive' : 'default'" :disabled="loading" @click="emit('confirm')">
          <span
            v-if="loading"
            class="mr-1 h-4 w-4 animate-spin rounded-full border-2"
            :class="destructive
              ? 'border-destructive-foreground/30 border-t-destructive-foreground'
              : 'border-primary-foreground/30 border-t-primary-foreground'"
            aria-hidden="true"
          />
          {{ resolvedConfirmLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
const { t } = useI18n()

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  loading?: boolean
}>(), {
  destructive: true,
  loading: false,
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const resolvedConfirmLabel = computed(() => props.confirmLabel ?? t('common.confirm'))
const resolvedCancelLabel = computed(() => props.cancelLabel ?? t('common.cancel'))
</script>
