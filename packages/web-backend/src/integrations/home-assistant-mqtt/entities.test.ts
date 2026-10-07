import { describe, expect, it } from 'vitest'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { defaults } from './config.js'
import { quotaEntities, metricEntities } from './entities.js'

const quota: ProviderQuotaContract = { kind: 'anthropic', fetchedAt: '2026-10-07T12:00:00Z', windows: [
  { key: 'five_hour', label: '5h', utilization: 80, resetsAt: '2026-10-07T15:00:00Z', resetDisplay: 'relative' },
] }
describe('HA discovery and privacy', () => {
  it('only emits present quota windows, fixed topics, timestamps and no account IDs', () => {
    const entities = quotaEntities(defaults, { 'private-account-id': quota })
    expect(entities).toHaveLength(3)
    expect(entities.map(e => e.topic)).toEqual([
      'homeassistant/sensor/offtangent/limit_anthropic_five_hour/config',
      'homeassistant/sensor/offtangent/limit_anthropic_five_hour_reset/config',
      'homeassistant/sensor/offtangent/limit_anthropic_five_hour_fetched/config',
    ])
    expect(entities[0].config).toMatchObject({ state_topic: 'offtangent/limit_anthropic_five_hour/state', unique_id: 'offtangent_limit_anthropic_five_hour', availability_topic: 'offtangent/status', expire_after: 1200 })
    expect(JSON.stringify(entities)).not.toContain('private-account-id')
    expect(quotaEntities(defaults, { x: { ...quota, windows: [] } })).toEqual([])
  })
  it('collapses multiple accounts to maximum and filters error snapshots', () => {
    const entities = quotaEntities(defaults, { a: quota, b: { ...quota, windows: [{ ...quota.windows[0], utilization: 92 }] }, c: { ...quota, error: 'secret', windows: [] } })
    expect(entities[0].state).toBe('92')
    expect(JSON.stringify(entities)).not.toContain('secret')
  })
  it('groups can be selected independently', () => {
    expect(quotaEntities({ ...defaults, groups: { ...defaults.groups, limits: false } }, { a: quota })).toEqual([])
    const data = { usage: { today_total: { tokens: 12, cost: 0.4 } }, activity: { messagesToday: 2, runningTasks: 1, failedTasksToday: 0, lastCronRun: null }, version: '0.30.0' }
    expect(metricEntities(defaults, data).map(e => e.stateTopic)).toEqual([
      'offtangent/tokens_today_total/state', 'offtangent/cost_today_total/state', 'offtangent/messages_today/state',
      'offtangent/running_tasks/state', 'offtangent/failed_tasks_today/state', 'offtangent/version/state',
    ])
    expect(metricEntities({ ...defaults, groups: { limits: false, usage: false, activity: false, status: false } }, data)).toEqual([])
  })
})
