<script setup lang="ts">
/*
 * Legacy chat: no thread binding, the backend resolves the session exactly as
 * it did before threads existed. Kept so nothing that relied on the old
 * single-conversation view breaks.
 */
const router = useRouter()
</script>

<template>
  <ChatView @back="router.push('/')" />
</template>
