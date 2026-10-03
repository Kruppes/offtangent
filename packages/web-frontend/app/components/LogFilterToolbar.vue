<script setup lang="ts">
const { t } = useI18n()

const searchQuery = defineModel<string>('search', { required: true })
const selectedSessionType = defineModel<'' | 'main' | 'task'>('sessionType', { required: true })
const selectedToolName = defineModel<string>('toolName', { required: true })
const dateFrom = defineModel<string>('dateFrom', { required: true })
const dateTo = defineModel<string>('dateTo', { required: true })

defineProps<{
  toolNames: string[]
}>()

const emit = defineEmits<{
  (e: 'search'): void
  (e: 'apply'): void
}>()
</script>

<template>
  <div class="flex-shrink-0 border-b border-border px-5 py-4">
    <div class="flex flex-wrap items-end gap-2">
      <LabeledField v-slot="{ id }" :label="t('logs.searchLabel')" class="min-w-[180px] flex-1 sm:flex-none">
        <Input
          :id="id"
          v-model="searchQuery"
          type="text"
          :placeholder="t('logs.searchPlaceholder')"
          @input="emit('search')"
        />
      </LabeledField>

      <LabeledField v-slot="{ id }" :label="t('aria.filterBy.source')" class="w-[150px]">
      <Select v-model="selectedSessionType" @update:model-value="emit('apply')">
        <SelectTrigger :id="id">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{{ t('logs.allSources') }}</SelectItem>
          <SelectItem value="main">{{ t('logs.sourceMainAgent') }}</SelectItem>
          <SelectItem value="task">{{ t('logs.sourceTasks') }}</SelectItem>
        </SelectContent>
      </Select>
      </LabeledField>

      <LabeledField v-slot="{ id }" :label="t('aria.filterBy.tool')" class="w-[150px]">
      <Select v-model="selectedToolName" @update:model-value="emit('apply')">
        <SelectTrigger :id="id">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">{{ t('logs.allTools') }}</SelectItem>
          <SelectItem v-for="name in toolNames" :key="name" :value="name">{{ name }}</SelectItem>
        </SelectContent>
      </Select>
      </LabeledField>

      <DateRangePicker
        v-model:date-from="dateFrom"
        v-model:date-to="dateTo"
        @change="emit('apply')"
      />
    </div>
  </div>
</template>
