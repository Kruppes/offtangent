<template>
  <div
    v-if="!isAdmin"
    class="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-muted-foreground"
  >
    <AppIcon name="lock" size="xl" class="h-10 w-10" />
    <h1 class="text-xl font-semibold text-foreground">{{ $t('admin.title') }}</h1>
    <p class="text-sm">{{ $t('admin.description') }}</p>
  </div>

  <MemoryWorkspace v-else />
</template>

<script setup lang="ts">
import MemoryWorkspace from '~/features/memory/components/MemoryWorkspace.vue'

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
</script>
