<template>
  <ConfirmDialog
    :open="description !== null"
    :title="t('settings.modelConsent.warning')"
    :description="description ?? undefined"
    :confirm-label="t('settings.modelConsent.confirm')"
    :destructive="false"
    description-class="whitespace-pre-line"
    @confirm="answer(true)"
    @cancel="answer(false)"
  />
</template>

<script setup lang="ts">
const { t } = useI18n()
const { description, answer } = useModelConsentDialog()
onUnmounted(() => answer(false))
</script>
