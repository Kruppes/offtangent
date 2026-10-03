<template>
  <LabeledField v-slot="{ id }" :label="$t('cronjobs.filters.searchLabel')" class="w-full md:w-[220px]">
    <Input
      :id="id"
      v-model="search"
      type="search"
      :placeholder="$t('cronjobs.filters.search')"
    />
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.state')" class="w-full md:w-[140px]">
  <Select v-model="enabled">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allStates') }}</SelectItem>
      <SelectItem value="enabled">{{ $t('cronjobs.filters.enabled') }}</SelectItem>
      <SelectItem value="disabled">{{ $t('cronjobs.filters.disabled') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.action')" class="w-full md:w-[140px]">
  <Select v-model="actionType">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allActions') }}</SelectItem>
      <SelectItem value="task">{{ $t('cronjobs.actionTypeTask') }}</SelectItem>
      <SelectItem value="injection">{{ $t('cronjobs.actionTypeInjection') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.provider')" class="w-full md:w-[220px]">
  <Select v-model="provider">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allProviders') }}</SelectItem>
      <SelectItem v-if="hasDefaultProviderOption" :value="CRONJOB_DEFAULT_PROVIDER_FILTER">
        {{ $t('cronjobs.defaultProvider') }}
      </SelectItem>
      <SelectItem v-for="option in providerOptions" :key="option.value" :value="option.value">
        {{ option.label }}
      </SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.lastRun')" class="w-full md:w-[160px]">
  <Select v-model="lastRunStatus">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allLastRuns') }}</SelectItem>
      <SelectItem value="running">{{ $t('tasks.status.running') }}</SelectItem>
      <SelectItem value="completed">{{ $t('tasks.status.completed') }}</SelectItem>
      <SelectItem value="failed">{{ $t('tasks.status.failed') }}</SelectItem>
      <SelectItem :value="CRONJOB_NEVER_RAN_FILTER">{{ $t('cronjobs.filters.neverRan') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>

  <LabeledField v-slot="{ id }" :label="$t('aria.filterBy.schedule')" class="w-full md:w-[160px]">
  <Select v-model="scheduleType">
    <SelectTrigger :id="id">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allSchedules') }}</SelectItem>
      <SelectItem value="recurring">{{ $t('cronjobs.filters.recurring') }}</SelectItem>
      <SelectItem value="fixedDate">{{ $t('cronjobs.filters.fixedDate') }}</SelectItem>
    </SelectContent>
  </Select>
  </LabeledField>
</template>

<script setup lang="ts">
import {
  CRONJOB_DEFAULT_PROVIDER_FILTER,
  CRONJOB_NEVER_RAN_FILTER,
  type CronjobEnabledFilter,
} from '~/features/cronjobs/composables/useCronjobFilters'

defineProps<{
  hasDefaultProviderOption: boolean
  providerOptions: { value: string; label: string }[]
}>()

const search = defineModel<string>('search', { required: true })
const enabled = defineModel<CronjobEnabledFilter>('enabled', { required: true })
const actionType = defineModel<string>('actionType', { required: true })
const provider = defineModel<string>('provider', { required: true })
const lastRunStatus = defineModel<string>('lastRunStatus', { required: true })
const scheduleType = defineModel<string>('scheduleType', { required: true })
</script>
