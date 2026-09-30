<script setup lang="ts">
const { t } = useI18n()

const dateFrom = defineModel<string>('dateFrom', { default: '' })
const dateTo = defineModel<string>('dateTo', { default: '' })

const emit = defineEmits<{
  (e: 'change'): void
}>()

const open = ref(false)

const hasRange = computed(() => !!dateFrom.value || !!dateTo.value)

const displayText = computed(() => {
  if (!dateFrom.value && !dateTo.value) return t('logs.dateRange')
  if (dateFrom.value && dateTo.value) {
    if (dateFrom.value === dateTo.value) return formatDisplayDate(dateFrom.value)
    return `${formatDisplayDate(dateFrom.value)} – ${formatDisplayDate(dateTo.value)}`
  }
  if (dateFrom.value) return `${t('logs.dateRangeFrom')} ${formatDisplayDate(dateFrom.value)}`
  return `${t('logs.dateRangeUntil')} ${formatDisplayDate(dateTo.value)}`
})

function formatDisplayDate(dateStr: string): string {
  if (!dateStr) return ''
  const [year, month, day] = dateStr.split('-')
  return `${day}.${month}.${year}`
}

function clear() {
  dateFrom.value = ''
  dateTo.value = ''
  emit('change')
}

function onDateChange() {
  emit('change')
}

function setPreset(preset: string) {
  const today = new Date()
  // Format as local date (YYYY-MM-DD) — not toISOString() which converts to UTC
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

  switch (preset) {
    case 'today':
      dateFrom.value = fmt(today)
      dateTo.value = fmt(today)
      break
    case 'yesterday': {
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)
      dateFrom.value = fmt(yesterday)
      dateTo.value = fmt(yesterday)
      break
    }
    case 'last7': {
      const d = new Date(today)
      d.setDate(d.getDate() - 6)
      dateFrom.value = fmt(d)
      dateTo.value = fmt(today)
      break
    }
    case 'last30': {
      const d = new Date(today)
      d.setDate(d.getDate() - 29)
      dateFrom.value = fmt(d)
      dateTo.value = fmt(today)
      break
    }
  }
  emit('change')
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <div class="flex items-center gap-1">
        <Button variant="outline" :class="'gap-2 font-normal' + (!hasRange ? ' text-muted-foreground' : '')">
          <AppIcon name="calendar" size="sm" />
          <span class="hidden sm:inline">{{ displayText }}</span>
        </Button>
        <Button
          v-if="hasRange"
          variant="ghost"
          size="icon"
          class="text-muted-foreground hover:text-foreground"
          :aria-label="t('logs.clearDateRange')"
          @click.stop="clear"
        >
          <AppIcon name="close" size="sm" />
        </Button>
      </div>
    </PopoverTrigger>

    <PopoverContent align="end" class="w-[280px]">
      <!-- Presets -->
      <div class="flex flex-wrap gap-1.5">
        <Button
          v-for="preset in ['last7', 'last30']"
          :key="preset"
          variant="outline"
          size="sm"
          class="h-7 text-xs"
          @click="setPreset(preset)"
        >
          {{ t(`logs.preset_${preset}`) }}
        </Button>
      </div>

      <Separator />

      <!-- Custom range -->
      <div class="flex flex-col gap-2">
        <Label class="text-xs text-muted-foreground">{{ t('logs.dateFrom') }}</Label>
        <Input
          v-model="dateFrom"
          type="date"
          class="h-9"
          @change="onDateChange"
        />
      </div>
      <div class="flex flex-col gap-2">
        <Label class="text-xs text-muted-foreground">{{ t('logs.dateTo') }}</Label>
        <Input
          v-model="dateTo"
          type="date"
          class="h-9"
          @change="onDateChange"
        />
      </div>

      <!-- Clear button -->
      <Button
        v-if="hasRange"
        variant="ghost"
        size="sm"
        class="w-full text-muted-foreground"
        @click="clear"
      >
        {{ t('logs.clearDateRange') }}
      </Button>
    </PopoverContent>
  </Popover>
</template>
