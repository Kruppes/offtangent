<template>
  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.status')" class="w-full md:w-[160px]">
  <Select v-model="status" @update:model-value="$emit('change')">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('tasks.filters.allStatuses') }}</SelectItem>
      <SelectItem value="running">{{ $t('tasks.status.running') }}</SelectItem>
      <SelectItem value="paused">{{ $t('tasks.status.paused') }}</SelectItem>
      <SelectItem value="completed">{{ $t('tasks.status.completed') }}</SelectItem>
      <SelectItem value="failed">{{ $t('tasks.status.failed') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.trigger')" class="w-full md:w-[160px]">
  <Select v-model="triggerType" @update:model-value="$emit('change')">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('tasks.filters.allTriggers') }}</SelectItem>
      <SelectItem value="user">{{ $t('tasks.trigger.user') }}</SelectItem>
      <SelectItem value="agent">{{ $t('tasks.trigger.agent') }}</SelectItem>
      <SelectItem value="cronjob">{{ $t('tasks.trigger.cronjob') }}</SelectItem>
      <SelectItem value="heartbeat">{{ $t('tasks.trigger.heartbeat') }}</SelectItem>
      <SelectItem value="consolidation">{{ $t('tasks.trigger.consolidation') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.provider')" class="w-full md:w-[240px]">
  <Select v-model="providerFilter" @update:model-value="$emit('change')">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('tasks.filters.allProviders') }}</SelectItem>
      <SelectItem v-if="hasDefaultProviderOption" :value="TASK_DEFAULT_PROVIDER_FILTER">
        {{ $t('tasks.filters.defaultProvider') }}
      </SelectItem>
      <SelectItem
        v-for="option in providerModelOptions"
        :key="option.value"
        :value="option.value"
      >
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <div class="flex items-center gap-2">
    <Label :for="fromDateId" class="w-10 text-xs font-medium text-muted-foreground md:w-auto">{{ $t('tasks.filters.fromDate') }}</Label>
    <Input
      :id="fromDateId"
      v-model="createdFrom"
      type="date"
      class="flex-1 md:w-[145px] md:flex-none"
      @change="$emit('change')"
    />
  </div>

  <div class="flex items-center gap-2">
    <Label :for="toDateId" class="w-10 text-xs font-medium text-muted-foreground md:w-auto">{{ $t('tasks.filters.toDate') }}</Label>
    <Input
      :id="toDateId"
      v-model="createdTo"
      type="date"
      class="flex-1 md:w-[145px] md:flex-none"
      @change="$emit('change')"
    />
  </div>
</template>

<script setup lang="ts">
import { useId } from 'vue'
import { TASK_DEFAULT_PROVIDER_FILTER } from '~/features/tasks/composables/useTasksList'

const fromDateId = useId()
const toDateId = useId()

defineProps<{
  hasDefaultProviderOption: boolean
  providerModelOptions: { value: string; label: string }[]
}>()

defineEmits<{
  change: []
}>()

const status = defineModel<string>('status', { required: true })
const triggerType = defineModel<string>('triggerType', { required: true })
const providerFilter = defineModel<string>('providerFilter', { required: true })
const createdFrom = defineModel<string>('createdFrom', { required: true })
const createdTo = defineModel<string>('createdTo', { required: true })
</script>
