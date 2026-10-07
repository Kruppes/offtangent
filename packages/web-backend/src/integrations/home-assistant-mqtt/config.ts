import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getConfigDir, loadConfig, resolveSecret, sealSecret } from '@axiom/core'

export interface MqttSettings {
  enabled: boolean
  host: string
  port: number
  tls: boolean
  username: string
  passwordSecret: string
  clientId: string
  discoveryPrefix: string
  baseTopic: string
  intervalSeconds: number
  groups: { limits: boolean; usage: boolean; activity: boolean; status: boolean }
}
export const defaults: MqttSettings = {
  enabled: false, host: '', port: 1883, tls: false, username: '', passwordSecret: '',
  clientId: 'offtangent', discoveryPrefix: 'homeassistant', baseTopic: 'offtangent',
  intervalSeconds: 60, groups: { limits: true, usage: true, activity: true, status: true },
}
const segment = /^[a-zA-Z0-9_-]+$/
// No URI schemes, userinfo, paths, query strings or topic wildcards in a broker hostname.
const hostname = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*|\[[0-9a-fA-F:]+\])$/
export const applicationVersion = (() => {
  try { return (JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version }
  catch { return 'unknown' }
})()
function configFile(): string { return path.join(getConfigDir(), 'settings.json') }
export function readSettings(): MqttSettings {
  ensureConfigTemplates()
  const raw = (loadConfig<Record<string, unknown>>('settings.json').homeAssistantMqtt ?? {}) as Partial<MqttSettings>
  return { ...defaults, ...raw, groups: { ...defaults.groups, ...raw.groups } }
}
export function publicSettings(settings = readSettings()) {
  const { passwordSecret, ...safe } = settings
  return { ...safe, passwordSet: !!passwordSecret && !!resolveSecret(passwordSecret) }
}
export function brokerPassword(settings: MqttSettings): string | undefined {
  return settings.passwordSecret ? resolveSecret(settings.passwordSecret) ?? undefined : undefined
}
export function validateUpdate(input: unknown, old = readSettings()): MqttSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid MQTT settings')
  const body = input as Record<string, unknown>
  const keys = ['enabled', 'host', 'port', 'tls', 'username', 'password', 'clearPassword', 'clientId', 'discoveryPrefix', 'baseTopic', 'intervalSeconds', 'groups']
  if (Object.keys(body).some(k => !keys.includes(k))) throw new Error('Unknown MQTT setting')
  const next: MqttSettings = { ...old, groups: { ...old.groups } }
  for (const key of ['enabled', 'tls'] as const) {
    if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') throw new Error(`Invalid ${key}`); next[key] = body[key] }
  }
  for (const key of ['host', 'username', 'clientId', 'discoveryPrefix', 'baseTopic'] as const) {
    if (body[key] !== undefined) { if (typeof body[key] !== 'string') throw new Error(`Invalid ${key}`); next[key] = body[key].trim() }
  }
  if ((next.host && !hostname.test(next.host)) || next.host.length > 253 || next.username.length > 256 || !segment.test(next.clientId) || next.clientId.length > 80 ||
      !segment.test(next.discoveryPrefix) || !segment.test(next.baseTopic)) throw new Error('Invalid MQTT host, client ID or topic')
  for (const [key, min, max] of [['port', 1, 65535], ['intervalSeconds', 10, 3600]] as const) {
    if (body[key] !== undefined) { if (!Number.isInteger(body[key]) || (body[key] as number) < min || (body[key] as number) > max) throw new Error(`Invalid ${key}`); next[key] = body[key] as number }
  }
  if (body.groups !== undefined) {
    if (!body.groups || typeof body.groups !== 'object' || Array.isArray(body.groups) || Object.keys(body.groups).some(k => !(k in next.groups))) throw new Error('Invalid groups')
    for (const key of Object.keys(next.groups) as Array<keyof MqttSettings['groups']>) {
      const value = (body.groups as Record<string, unknown>)[key]
      if (value !== undefined) { if (typeof value !== 'boolean') throw new Error('Invalid group'); next.groups[key] = value }
    }
  }
  if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length > 1024)) throw new Error('Invalid password')
  if (body.clearPassword !== undefined && typeof body.clearPassword !== 'boolean') throw new Error('Invalid clearPassword')
  if (next.enabled && !next.host) throw new Error('Broker host required when enabled')
  return next
}
export function saveSettings(next: MqttSettings, input: Record<string, unknown>): MqttSettings {
  // Seal before changing settings.json; never persist plaintext.
  if (typeof input.password === 'string' && input.password) next.passwordSecret = sealSecret(input.password, 'mqtt-password', 'settings')
  else if (input.clearPassword === true) next.passwordSecret = ''
  const file = configFile()
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  raw.homeAssistantMqtt = next
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  return next
}
