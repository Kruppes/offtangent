import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { applicationVersion } from './config.js'
import type { MqttSettings } from './config.js'

export interface Entity { topic: string; stateTopic: string; state: string; config: Record<string, unknown>; attributesTopic?: string; attributes?: string }
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 64)
function sensor(s: MqttSettings, key: string, name: string, state: string, opts: Record<string, unknown> = {}): Entity {
  const id = `offtangent_${key}`
  return {
    topic: `${s.discoveryPrefix}/sensor/offtangent/${key}/config`,
    stateTopic: `${s.baseTopic}/${key}/state`, state,
    config: { name, unique_id: id, default_entity_id: `sensor.${id}`, state_topic: `${s.baseTopic}/${key}/state`,
      availability_topic: `${s.baseTopic}/status`, device: { identifiers: ['offtangent'], name: 'Offtangent', manufacturer: 'Offtangent', sw_version: applicationVersion }, ...opts },
  }
}
export function quotaEntities(s: MqttSettings, snapshot: Record<string, ProviderQuotaContract>): Entity[] {
  if (!s.groups.limits) return []
  // Multiple accounts of the same kind: publish the maximum utilization per window, never account IDs.
  const windows = new Map<string, { kind: string; label: string; utilization: number; resetsAt: string | null; fetchedAt: string }>()
  for (const quota of Object.values(snapshot)) {
    if (quota.error) continue
    for (const window of quota.windows) {
      const key = `${slug(quota.kind)}_${slug(window.key)}`
      const old = windows.get(key)
      if (!old || window.utilization > old.utilization) windows.set(key, { kind: quota.kind, label: window.label, utilization: window.utilization, resetsAt: window.resetsAt, fetchedAt: quota.fetchedAt })
    }
  }
  return [...windows].flatMap(([key, item]) => {
    const reset = item.resetsAt && !Number.isNaN(Date.parse(item.resetsAt)) ? new Date(item.resetsAt).toISOString() : null
    const attributesTopic = `${s.baseTopic}/limit_${key}/attributes`
    const percent = sensor(s, `limit_${key}`, `${item.kind} ${item.label} utilization`, String(item.utilization),
      { unit_of_measurement: '%', state_class: 'measurement', expire_after: 1200, json_attributes_topic: attributesTopic })
    percent.attributesTopic = attributesTopic
    percent.attributes = JSON.stringify({ resets_at: reset, fetched_at: item.fetchedAt })
    return [
      percent,
      ...(reset ? [sensor(s, `limit_${key}_reset`, `${item.kind} ${item.label} reset`, reset,
        { device_class: 'timestamp', expire_after: 1200 })] : []),
      sensor(s, `limit_${key}_fetched`, `${item.kind} ${item.label} fetched`, item.fetchedAt,
        { device_class: 'timestamp', expire_after: 1200 }),
    ]
  })
}
export interface Metrics {
  usage: Record<string, { tokens: number; cost: number }>
  activity: { messagesToday: number; runningTasks: number; failedTasksToday: number; lastCronRun: string | null }
  version: string
}
export function metricEntities(s: MqttSettings, metrics: Metrics): Entity[] {
  const result: Entity[] = []
  if (s.groups.usage) for (const [key, item] of Object.entries(metrics.usage)) {
    const safe = slug(key)
    result.push(sensor(s, `tokens_${safe}`, `${key} tokens`, String(item.tokens), { unit_of_measurement: 'tokens', state_class: 'measurement' }))
    result.push(sensor(s, `cost_${safe}`, `${key} cost`, String(item.cost), { device_class: 'monetary', unit_of_measurement: 'USD', state_class: 'measurement' }))
  }
  if (s.groups.activity) {
    result.push(sensor(s, 'messages_today', 'Messages today', String(metrics.activity.messagesToday), { state_class: 'measurement' }))
    result.push(sensor(s, 'running_tasks', 'Running tasks', String(metrics.activity.runningTasks), { state_class: 'measurement' }))
    result.push(sensor(s, 'failed_tasks_today', 'Failed tasks today', String(metrics.activity.failedTasksToday), { state_class: 'measurement' }))
    if (metrics.activity.lastCronRun) result.push(sensor(s, 'last_cron_run', 'Last cronjob run', metrics.activity.lastCronRun, { device_class: 'timestamp' }))
  }
  if (s.groups.status) result.push(sensor(s, 'version', 'Version', metrics.version, { entity_category: 'diagnostic' }))
  return result
}
