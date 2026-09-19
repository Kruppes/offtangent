import type { Ref } from 'vue'
import type { Cronjob } from '~/composables/useCronjobs'
import type { ProviderModelSource } from '~/utils/providerModelOptions'
import { formatCronjobProvider } from '../utils/providerValue'
import { getCronjobScheduleType } from '../utils/scheduleType'

export const CRONJOB_DEFAULT_PROVIDER_FILTER = '__default__'
export const CRONJOB_NEVER_RAN_FILTER = '__never__'

export type CronjobEnabledFilter = '' | 'enabled' | 'disabled'

const DEFAULT_FILTERS = {
  search: '',
  provider: '',
  actionType: '',
  enabled: 'enabled' as CronjobEnabledFilter,
  lastRunStatus: '',
  scheduleType: '',
}

type CronjobFilters = typeof DEFAULT_FILTERS
type CronjobPredicate = (cj: Cronjob) => boolean

function matchesSearch(cj: Cronjob, query: string): boolean {
  const haystack = [cj.name, cj.prompt, ...(cj.attachedSkills ?? [])].join('\n').toLowerCase()
  return haystack.includes(query)
}

function matchesLastRunStatus(cj: Cronjob, filter: string): boolean {
  if (filter === CRONJOB_NEVER_RAN_FILTER) return !cj.lastRunAt
  return cj.lastRunStatus === filter
}

function matchesProvider(cj: Cronjob, filter: string): boolean {
  if (cj.actionType !== 'task') return false
  if (filter === CRONJOB_DEFAULT_PROVIDER_FILTER) return !cj.provider
  return cj.provider === filter
}

const PREDICATE_FACTORIES: Array<(filters: CronjobFilters) => CronjobPredicate | null> = [
  ({ enabled }) => enabled ? cj => cj.enabled === (enabled === 'enabled') : null,
  ({ actionType }) => actionType ? cj => cj.actionType === actionType : null,
  ({ provider }) => provider ? cj => matchesProvider(cj, provider) : null,
  ({ lastRunStatus }) => lastRunStatus ? cj => matchesLastRunStatus(cj, lastRunStatus) : null,
  ({ scheduleType }) => scheduleType ? cj => getCronjobScheduleType(cj.schedule) === scheduleType : null,
  ({ search }) => {
    const query = search.trim().toLowerCase()
    return query ? cj => matchesSearch(cj, query) : null
  },
]

function buildPredicates(filters: CronjobFilters): CronjobPredicate[] {
  return PREDICATE_FACTORIES.flatMap(factory => factory(filters) ?? [])
}

export function useCronjobFilters(cronjobs: Ref<Cronjob[]>, providers: Ref<ProviderModelSource[]>) {
  const filters = reactive({ ...DEFAULT_FILTERS })

  const activeFilterCount = computed(() =>
    (Object.keys(DEFAULT_FILTERS) as Array<keyof typeof DEFAULT_FILTERS>)
      .filter(key => filters[key] !== DEFAULT_FILTERS[key])
      .length,
  )

  const hasDefaultProviderOption = computed(() =>
    cronjobs.value.some(cj => cj.actionType === 'task' && !cj.provider),
  )

  const providerOptions = computed(() => {
    const values = new Set<string>()
    for (const cj of cronjobs.value) {
      if (cj.actionType === 'task' && cj.provider) values.add(cj.provider)
    }
    return [...values]
      .map(value => ({ value, label: formatCronjobProvider(value, providers.value) }))
      .sort((a, b) => a.label.localeCompare(b.label))
  })

  const filteredCronjobs = computed(() => {
    const predicates = buildPredicates(filters)
    return cronjobs.value.filter(cj => predicates.every(matches => matches(cj)))
  })

  function resetFilters() {
    Object.assign(filters, DEFAULT_FILTERS)
  }

  return {
    filters,
    activeFilterCount,
    hasDefaultProviderOption,
    providerOptions,
    filteredCronjobs,
    resetFilters,
  }
}
