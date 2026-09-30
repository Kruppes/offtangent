<template>
  <div v-if="data === null || data === undefined" class="text-muted-foreground">—</div>

  <!-- Flat object: show as key-value table -->
  <div v-else-if="isFlatObject(data)" class="space-y-1">
    <div
      v-for="(value, key) in (data as Record<string, unknown>)"
      :key="String(key)"
      class="flex gap-2"
    >
      <span class="shrink-0 font-medium text-muted-foreground">{{ key }}:</span>
      <span
        class="min-w-0 whitespace-pre-wrap break-all"
        :class="isError ? 'text-destructive' : 'text-foreground'"
      >{{ formatValue(value) }}</span>
    </div>
  </div>

  <!-- String content -->
  <pre
    v-else-if="typeof data === 'string'"
    class="whitespace-pre-wrap break-all"
    :class="isError ? 'text-destructive' : 'text-foreground'"
  >{{ data }}</pre>

  <!-- Complex object: formatted JSON -->
  <pre
    v-else
    class="whitespace-pre-wrap break-all"
    :class="isError ? 'text-destructive' : 'text-foreground'"
  >{{ formatJson(data) }}</pre>
</template>

<script setup lang="ts">
const props = defineProps<{
  data: unknown
  isError?: boolean
}>()

function isFlatObject(data: unknown): data is Record<string, string | number | boolean | null> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  return Object.values(data as Record<string, unknown>).every(
    v => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function formatJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2)
  } catch {
    return String(data)
  }
}
</script>
