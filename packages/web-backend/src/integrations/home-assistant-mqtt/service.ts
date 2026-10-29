import fs from 'node:fs'
import path from 'node:path'
import mqtt from 'mqtt'
import type { MqttClient } from 'mqtt'
import { getConfigDir, getUsageSummary, queryUsageStats } from '@axiom/core'
import type { Database } from '@axiom/core'
import type { ProviderQuotaContract } from '@axiom/core/contracts'
import { applicationVersion, brokerPassword, readSettings } from './config.js'
import type { MqttSettings } from './config.js'
import { metricEntities, quotaEntities } from './entities.js'
import type { Entity, Metrics } from './entities.js'

export function connectionOptions(settings: MqttSettings) {
  return {
    username: settings.username || undefined, password: brokerPassword(settings),
    clientId: settings.clientId, reconnectPeriod: 1000, connectTimeout: 5000,
    will: { topic: `${settings.baseTopic}/status`, payload: 'offline', qos: 1 as const, retain: true },
  }
}
const url = (s: MqttSettings) => `${s.tls ? 'mqtts' : 'mqtt'}://${s.host}:${s.port}`
export function collectMetrics(db: Database): Metrics {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const month = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const summary = getUsageSummary(db, now)
  const usage: Metrics['usage'] = {}
  for (const period of ['today', 'month'] as const) {
    const totals = summary[period]
    usage[`${period}_total`] = { tokens: totals.totalTokens, cost: totals.estimatedCost }
    const rows = queryUsageStats(db, { groupBy: ['provider'], dateFrom: period === 'today' ? today : month, dateTo: now.toISOString() }).rows
    // Provider names may be user-configured. Publish only fixed provider families (no account IDs).
    for (const row of rows) {
      const kind = (row.provider ?? '').toLowerCase()
      if (!['anthropic', 'openai', 'openai-codex', 'gemini', 'google', 'ollama', 'mistral', 'zai', 'opencode-go', 'deepgram'].includes(kind)) continue
      const key = `${period}_${kind}`
      const old = usage[key] ?? { tokens: 0, cost: 0 }
      usage[key] = { tokens: old.tokens + row.totalTokens, cost: old.cost + row.estimatedCost }
    }
  }
  const scalar = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n
  const last = db.prepare('SELECT MAX(last_run_at) AS t FROM scheduled_tasks').get() as { t: string | null }
  return { usage, activity: {
    messagesToday: scalar("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'user' AND datetime(timestamp) >= datetime(?)", today),
    runningTasks: scalar("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'"),
    failedTasksToday: scalar("SELECT COUNT(*) AS n FROM tasks WHERE status = 'failed' AND datetime(completed_at) >= datetime(?)", today),
    lastCronRun: last.t ? new Date(last.t.replace(' ', 'T') + (/[Z+-]\d{2}:?\d{2}$/.test(last.t) || last.t.endsWith('Z') ? '' : 'Z')).toISOString() : null,
  }, version: applicationVersion }
}

/** MQTT transport; no client is created when disabled. */
export class HomeAssistantMqttService {
  private client: MqttClient | null = null
  private settings = readSettings()
  private snapshot: Record<string, ProviderQuotaContract> = {}
  private quotaReceived = false
  private closing: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setInterval> | null = null
  private published = new Set<string>()
  private status: 'off' | 'connecting' | 'connected' | 'error' = 'off'
  private generation = 0
  private loggedError = false
  private reportError() {
    this.status = 'error'
    if (!this.loggedError) console.warn('[mqtt] Connection or publish failed (details withheld)')
    this.loggedError = true
  }
  private publication: Promise<void> = Promise.resolve()
  private enqueuePublish(): void {
    this.publication = this.publication.then(() => this.publishCurrent()).catch(() => this.reportError())
  }
  constructor(private db: Database) { this.published = this.readManifest() }
  getStatus() { return { status: this.status } }
  private manifestPath() { return path.join(getConfigDir(), 'mqtt-discovery-topics.json') }
  private readManifest(): Set<string> {
    try { const data: unknown = JSON.parse(fs.readFileSync(this.manifestPath(), 'utf8')); return new Set(Array.isArray(data) ? data.filter((s): s is string => typeof s === 'string') : []) }
    catch { return new Set() }
  }
  private saveManifest() { fs.writeFileSync(this.manifestPath(), JSON.stringify([...this.published]), { mode: 0o600 }) }
  start() { this.apply(readSettings()) }
  apply(next: MqttSettings) {
    const old = this.settings
    this.settings = next
    const gen = ++this.generation
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const previous = this.client
    this.client = null
    this.status = next.enabled ? 'connecting' : 'off'
    // Serialize teardown and startup: a rapid second apply must not create a
    // second connection with the same client ID before the first has ended.
    this.closing = this.closing.then(async () => {
      if (previous) {
        let closed = false
        try {
          await this.publication
          if (previous.connected) {
            if ((old.enabled && !next.enabled) || old.discoveryPrefix !== next.discoveryPrefix || old.baseTopic !== next.baseTopic) {
              await this.clearRemoved(previous, new Set())
            }
            await this.publish(previous, `${old.baseTopic}/status`, 'offline')
          }
        } catch { this.reportError() }
        finally { closed = await this.disconnect(previous) }
        if (!closed) { this.reportError(); return }
      }
      if (next.enabled && gen === this.generation) this.connect(next, gen)
    }).catch(() => this.reportError())
  }
  private disconnect(client: MqttClient): Promise<boolean> {
    return new Promise(resolve => {
      let done = false
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(!client.connected) }
      const timer = setTimeout(finish, 5000)
      try { client.end(true, finish) } catch { finish() }
    })
  }
  private connect(next: MqttSettings, gen: number) {
    try {
      const client = mqtt.connect(url(next), connectionOptions(next))
      this.client = client
      client.on('connect', () => {
        if (gen !== this.generation) return
        this.status = 'connected'
        // One line per failure episode: the warning above said "failed", so a
        // later successful (re)connect says so too, once, then re-arms both.
        if (this.loggedError) console.log('[mqtt] connected (recovered)')
        this.loggedError = false
        client.publish(`${next.baseTopic}/status`, 'online', { qos: 1, retain: true })
        client.options.reconnectPeriod = 1000
        this.enqueuePublish()
      })
      client.on('error', () => { if (gen === this.generation) this.reportError() }) // no raw broker errors/credentials in logs
      client.on('offline', () => { if (gen === this.generation) this.status = 'connecting' })
      client.on('reconnect', () => { client.options.reconnectPeriod = Math.min(60_000, (client.options.reconnectPeriod ?? 1000) * 2) })
      this.timer = setInterval(() => this.enqueuePublish(), next.intervalSeconds * 1000)
      this.timer.unref?.()
    } catch { this.reportError() }
  }
  onQuota(snapshot: Record<string, ProviderQuotaContract>) {
    this.snapshot = snapshot
    this.quotaReceived = true
    if (this.client?.connected) this.enqueuePublish()
  }
  private publish(client: MqttClient, topic: string, payload: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MQTT publish timeout')), 5000)
      try {
        client.publish(topic, payload, { qos: 1, retain: true }, err => {
          clearTimeout(timer)
          if (err) reject(err)
          else resolve()
        })
      } catch (err) { clearTimeout(timer); reject(err) }
    })
  }
  private async clearRemoved(client: MqttClient, keep: Set<string>) {
    if (!client.connected) return
    for (const topic of [...this.published]) {
      if (keep.has(topic)) continue
      await this.publish(client, topic, '')
      this.published.delete(topic)
      this.saveManifest()
    }
  }
  private async publishCurrent() {
    const client = this.client
    if (!client?.connected) return
    const config = this.settings
    let entities: Entity[] = quotaEntities(config, this.snapshot)
    entities = entities.concat(metricEntities(config, collectMetrics(this.db)))
    const keep = new Set(entities.map(e => e.topic))
    // No quota callback yet: a fresh process does not know which retained
    // limit entities are still valid. Keep them until the first real snapshot.
    if (!this.quotaReceived && config.groups.limits) for (const topic of this.published) {
      if (topic.startsWith(`${config.discoveryPrefix}/sensor/offtangent/limit_`)) keep.add(topic)
    }
    await this.clearRemoved(client, keep)
    for (const entity of entities) {
      if (client !== this.client) return
      await this.publish(client, entity.topic, JSON.stringify(entity.config))
      this.published.add(entity.topic)
      if (entity.attributesTopic && entity.attributes) await this.publish(client, entity.attributesTopic, entity.attributes)
      await this.publish(client, entity.stateTopic, entity.state)
    }
    this.saveManifest()
  }
  async stop() {
    ++this.generation
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const previous = this.client
    this.client = null
    this.status = 'off'
    this.closing = this.closing.then(async () => {
      if (!previous) return
      try {
        await this.publication
        if (previous.connected) await this.publish(previous, `${this.settings.baseTopic}/status`, 'offline')
      } catch { this.reportError() }
      finally { if (!(await this.disconnect(previous))) this.reportError() }
    }).catch(() => this.reportError())
    await this.closing
  }
  async test(settings = readSettings()): Promise<boolean> {
    if (!settings.host) return false
    return new Promise(resolve => {
      const suffix = Math.random().toString(36).slice(2, 10)
      const topic = `${settings.baseTopic}/test/${suffix}/status`
      const client = mqtt.connect(url(settings), { ...connectionOptions(settings), clientId: `${settings.clientId}-test-${suffix}`, reconnectPeriod: 0, connectTimeout: 4000 })
      const timer = setTimeout(() => finish(false), 6000)
      let done = false
      const finish = (ok: boolean) => { if (done) return; done = true; clearTimeout(timer); client.end(true); resolve(ok) }
      client.once('connect', () => { if (done) return; client.publish(topic, 'online', { qos: 1, retain: true }, err => {
        if (done) return
        if (err) { finish(false); return }
        client.publish(topic, '', { qos: 1, retain: true }, clearError => finish(!clearError))
      }) })
      client.on('error', () => finish(false))
    })
  }
}
