<template>
  <div class="flex h-full flex-col overflow-hidden">
    <PageHeader :title="$t('email.title')" :subtitle="$t('email.sentLogSubtitle')" />

    <div class="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden p-6">
      <EmailSendLogWorkspace />
    </div>
  </div>
</template>

<script setup lang="ts">
import EmailSendLogWorkspace from './EmailSendLogWorkspace.vue'
</script>
