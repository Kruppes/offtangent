<template>
  <div class="flex flex-1 flex-col gap-4 overflow-y-auto min-h-0">
    <Alert v-if="error" variant="destructive" class="shrink-0">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <div class="flex shrink-0 items-center justify-between gap-3">
      <p class="text-sm text-muted-foreground">{{ $t('memory.statsDescription') }}</p>
      <Select v-model="selectedDays" @update:model-value="loadStats">
        <SelectTrigger class="w-[180px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="1">{{ $t('memory.statsPeriod24h') }}</SelectItem>
          <SelectItem value="7">{{ $t('memory.statsPeriod7d') }}</SelectItem>
          <SelectItem value="30">{{ $t('memory.statsPeriod30d') }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div v-if="loading && !stats" class="flex items-center justify-center py-16 text-sm text-muted-foreground">
      {{ $t('memory.loading') }}
    </div>

    <template v-else-if="stats">
      <!-- File reads -->
      <section class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="border-b border-border px-4 py-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('memory.statsFileReadsTitle') }}</h3>
        </div>

        <div v-if="stats.fileReads.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
          {{ $t('memory.statsFileReadsEmpty') }}
        </div>
        <div v-else class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead>{{ $t('memory.statsColumnFile') }}</TableHead>
                <TableHead class="w-32 text-right">{{ $t('memory.statsColumnReads') }}</TableHead>
                <TableHead class="w-48">{{ $t('memory.statsColumnLastRead') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="entry in stats.fileReads" :key="entry.path">
                <TableCell class="font-mono text-sm">{{ entry.path }}</TableCell>
                <TableCell class="text-right text-sm tabular-nums">{{ entry.count }}</TableCell>
                <TableCell class="whitespace-nowrap text-sm text-muted-foreground">
                  {{ formatDateTime(entry.lastReadAt) }}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      <!-- Fact searches -->
      <section class="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div class="border-b border-border px-4 py-3">
          <h3 class="text-sm font-semibold text-foreground">{{ $t('memory.statsSearchesTitle') }}</h3>
        </div>

        <div v-if="stats.searches.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
          {{ $t('memory.statsSearchesEmpty') }}
        </div>
        <div v-else class="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow class="hover:bg-transparent">
                <TableHead class="w-48">{{ $t('memory.statsColumnDate') }}</TableHead>
                <TableHead>{{ $t('memory.statsColumnQuery') }}</TableHead>
                <TableHead class="w-32 text-right">{{ $t('memory.statsColumnResults') }}</TableHead>
                <TableHead class="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="search in stats.searches" :key="search.id">
                <TableRow
                  :class="search.facts.length > 0 ? 'cursor-pointer' : ''"
                  @click="toggleExpanded(search)"
                >
                  <TableCell class="whitespace-nowrap text-sm text-muted-foreground">
                    {{ formatDateTime(search.timestamp) }}
                  </TableCell>
                  <TableCell class="text-sm">{{ search.query }}</TableCell>
                  <TableCell class="text-right text-sm tabular-nums">{{ search.resultCount }}</TableCell>
                  <TableCell class="text-right">
                    <AppIcon
                      v-if="search.facts.length > 0"
                      name="chevronDown"
                      class="h-4 w-4 text-muted-foreground transition-transform"
                      :class="expandedIds.has(search.id) ? 'rotate-180' : ''"
                    />
                  </TableCell>
                </TableRow>
                <TableRow v-if="expandedIds.has(search.id)" class="hover:bg-transparent">
                  <TableCell colspan="4" class="bg-muted/40 px-6 py-3">
                    <ul class="flex flex-col gap-2">
                      <li v-for="(fact, index) in search.facts" :key="index" class="text-sm">
                        <span class="text-foreground">{{ fact.content }}</span>
                        <span class="ml-2 text-xs text-muted-foreground">
                          [{{ fact.source }}] {{ formatDateTime(fact.timestamp) }}
                        </span>
                      </li>
                    </ul>
                  </TableCell>
                </TableRow>
              </template>
            </TableBody>
          </Table>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { MemorySearchStat, MemoryUsageStats } from '~/api/memory'
import { useMemoryApi } from '~/api/memory'

const memoryApi = useMemoryApi()
const { formatDateTime } = useFormat()

const loading = ref(false)
const error = ref<string | null>(null)
const stats = ref<MemoryUsageStats | null>(null)
const selectedDays = ref('7')
const expandedIds = ref(new Set<number>())

onMounted(loadStats)

async function loadStats() {
  loading.value = true
  error.value = null
  expandedIds.value = new Set()

  try {
    stats.value = await memoryApi.getUsageStats(Number(selectedDays.value))
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

function toggleExpanded(search: MemorySearchStat) {
  if (search.facts.length === 0) return

  const next = new Set(expandedIds.value)
  if (next.has(search.id)) {
    next.delete(search.id)
  } else {
    next.add(search.id)
  }
  expandedIds.value = next
}
</script>
