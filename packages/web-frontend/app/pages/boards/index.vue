<script setup lang="ts">
import { onMounted } from 'vue'
import { useBoardList } from '~/composables/useBoards'
import { plainSummary, relativeTimeKey } from '~/utils/boardFormat'

const { boards, loading, error, load } = useBoardList()
onMounted(load)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader :title="$t('boards.title')" :subtitle="$t('boards.subtitle')" own-mobile-heading />
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-24 pt-3 md:px-6 md:pb-8">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <h1 class="px-1 text-xl font-bold tracking-tight md:hidden">{{ $t('boards.title') }}</h1>
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="ghost" class="min-h-[44px]" :disabled="loading" @click="load">{{ $t('common.refresh') }}</Button>
        </div>
        <Alert v-if="error" variant="destructive" role="alert" class="flex flex-wrap items-center gap-3">
          <AlertDescription class="flex-1">{{ $t(error) }}</AlertDescription>
          <Button variant="outline" class="min-h-[44px]" :disabled="loading" @click="load">{{ $t('common.retry') }}</Button>
        </Alert>
        <div v-if="loading && !boards.length" role="status" :aria-label="$t('common.loading')" aria-busy="true" class="space-y-3">
          <div v-for="n in 3" :key="n" aria-hidden="true" class="h-20 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        </div>
        <div v-else-if="!boards.length && !error" role="status" class="rounded-lg border p-6 text-center">
          <p class="font-medium">{{ $t('boards.empty') }}</p>
          <p class="mt-2 text-sm text-muted-foreground">{{ $t('boards.emptyHint') }}</p>
        </div>
        <ul v-else class="space-y-3" :aria-busy="loading">
          <li v-for="board in boards" :key="board.key" class="rounded-lg border bg-card text-card-foreground [overflow-wrap:anywhere]">
            <NuxtLink :to="`/boards/${encodeURIComponent(board.key)}`"
              class="flex min-h-[44px] items-start gap-3 rounded-lg p-4 hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <span v-if="board.icon" class="text-2xl leading-none" aria-hidden="true">{{ board.icon }}</span>
              <AppIcon v-else name="compass" class="mt-1 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="flex flex-wrap items-center gap-2">
                  <h2 class="font-medium">{{ board.title }}</h2>
                  <span class="rounded-full bg-muted px-2 py-1 text-2xs text-muted-foreground">{{ board.kind }}</span>
                </span>
                <span v-if="board.summary" class="mt-1 line-clamp-1 block text-sm text-muted-foreground">{{ plainSummary(board.summary) }}</span>
                <span class="mt-1 block text-xs text-muted-foreground">
                  {{ $t(relativeTimeKey(board.updatedAt).key, { count: relativeTimeKey(board.updatedAt).count }) }}
                </span>
              </span>
              <AppIcon name="chevronRight" class="mt-1 shrink-0 text-muted-foreground" />
            </NuxtLink>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
