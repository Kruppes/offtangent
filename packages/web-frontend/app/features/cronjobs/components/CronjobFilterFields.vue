<template>
  <Input
    v-model="search"
    type="search"
    class="w-full md:w-[220px]"
    :placeholder="$t('cronjobs.filters.search')"
    :aria-label="$t('cronjobs.filters.search')"
  />

  <Select v-model="enabled">
    <SelectTrigger class="w-full md:w-[140px]">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allStates') }}</SelectItem>
      <SelectItem value="enabled">{{ $t('cronjobs.filters.enabled') }}</SelectItem>
      <SelectItem value="disabled">{{ $t('cronjobs.filters.disabled') }}</SelectItem>
    </SelectContent>
  </Select>

  <Select v-model="actionType">
    <SelectTrigger class="w-full md:w-[140px]">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allActions') }}</SelectItem>
      <SelectItem value="task">{{ $t('cronjobs.actionTypeTask') }}</SelectItem>
      <SelectItem value="injection">{{ $t('cronjobs.actionTypeInjection') }}</SelectItem>
    </SelectContent>
  </Select>

  <Select v-model="provider">
    <SelectTrigger class="w-full md:w-[220px]">
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

  <Select v-model="lastRunStatus">
    <SelectTrigger class="w-full md:w-[160px]">
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

  <Select v-model="scheduleType">
    <SelectTrigger class="w-full md:w-[160px]">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="">{{ $t('cronjobs.filters.allSchedules') }}</SelectItem>
      <SelectItem value="recurring">{{ $t('cronjobs.filters.recurring') }}</SelectItem>
      <SelectItem value="fixedDate">{{ $t('cronjobs.filters.fixedDate') }}</SelectItem>
    </SelectContent>
  </Select>
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
