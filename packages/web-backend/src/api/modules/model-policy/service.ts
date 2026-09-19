import fs from 'node:fs'
import path from 'node:path'
import {
  ensureConfigTemplates,
  getConfigDir,
  isBlockedProviderType,
  isChainRole,
  loadConfig,
  loadModelPolicyRoles,
  loadProvidersDecrypted,
  MODEL_POLICY_LEGACY_FIELDS,
  MODEL_POLICY_READ_ONLY_ROLE,
  MODEL_POLICY_ROLES,
  resolveDefaultRole,
  resolveModelPolicySpec,
  resolveRoleProvider,
} from '@axiom/core'

export class ModelPolicyValidationError extends Error {
  constructor(message: string, readonly code: string = 'invalid_model_policy') {
    super(message)
  }
}

export interface ResolvedRolePayload {
  providerId: string
  providerName: string
  modelId: string
}

export interface RolePayload {
  role: string
  /** The configured value, `''` when the role is unset. */
  value: string
  /** `role` | `legacy` | `active` — where the effective value comes from. */
  source: 'role' | 'legacy' | 'active'
  /** Legacy settings field consulted for this role, if any. */
  legacyField?: string
  /** First usable entry of the value, or null when nothing resolves. */
  resolved: ResolvedRolePayload | null
  /** Set when a configured reference does not resolve (dead pin). */
  warning?: string
}

export interface ModelPolicyPayload {
  roles: Record<string, string>
  default: (ResolvedRolePayload & { composite: string }) | null
  policy: RolePayload[]
}

export interface ResolveStep {
  step: string
  value: string | null
  taken: boolean
  reason: string
}

export interface ResolvePayload {
  role: string
  kind: string | null
  agentId: string | null
  steps: ResolveStep[]
  resolved: ResolvedRolePayload | null
}

interface SettingsShape {
  modelPolicy?: { version?: number; roles?: Record<string, unknown> }
  tasks?: { defaultProvider?: string }
  multiPersona?: { perAgentProvider?: Record<string, string> }
  [key: string]: unknown
}

const TASK_ROLE_PREFIX = 'task:'

function readSettingsRaw(): SettingsShape {
  ensureConfigTemplates()
  return loadConfig<SettingsShape>('settings.json')
}

/** Split a chain value (`a, b:0.9, c`) into its entries. */
function chainEntries(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean)
}

/** Strip a trailing confidence threshold (`:0.9`) from a chain entry. */
const THRESHOLD_SUFFIX = /:(0(?:\.\d+)?|1(?:\.0+)?)$/

function specWithoutThreshold(entry: string): string {
  const match = entry.match(THRESHOLD_SUFFIX)
  return match ? entry.slice(0, -match[0].length) : entry
}

function providerTypeOf(providerId: string): string | null {
  try {
    const file = loadProvidersDecrypted()
    return file.providers.find(p => p.id === providerId)?.providerType ?? null
  } catch {
    return null
  }
}

/** Resolve one spec and reject blocked provider types. */
function resolveOne(spec: string): { ok: true; value: ResolvedRolePayload } | { ok: false; error: string } {
  const hit = resolveModelPolicySpec(spec)
  if (!hit.ok) return { ok: false, error: hit.error }
  const type = providerTypeOf(hit.providerId)
  if (type && isBlockedProviderType(type)) {
    return { ok: false, error: `provider type "${type}" is not allowed in a model policy role` }
  }
  return { ok: true, value: { providerId: hit.providerId, providerName: hit.providerName, modelId: hit.modelId } }
}

function describeRole(role: string, settings: SettingsShape): RolePayload {
  const hit = resolveRoleProvider(role, settings)
  if (!hit) {
    return {
      role,
      value: '',
      source: 'active',
      ...(MODEL_POLICY_LEGACY_FIELDS[role] ? { legacyField: MODEL_POLICY_LEGACY_FIELDS[role] } : {}),
      resolved: null,
    }
  }
  const entries = isChainRole(role) ? chainEntries(hit.spec) : [hit.spec]
  const errors: string[] = []
  for (const entry of entries) {
    const attempt = resolveOne(specWithoutThreshold(entry))
    if (attempt.ok) {
      return {
        role,
        value: hit.spec,
        source: hit.source,
        ...(hit.legacyField ? { legacyField: hit.legacyField } : {}),
        resolved: attempt.value,
        ...(errors.length > 0 ? { warning: errors.join('; ') } : {}),
      }
    }
    errors.push(`"${entry}": ${attempt.error}`)
  }
  return {
    role,
    value: hit.spec,
    source: hit.source,
    ...(hit.legacyField ? { legacyField: hit.legacyField } : {}),
    resolved: null,
    warning: errors.join('; ') || 'no entry resolved',
  }
}

export interface ModelPolicyService {
  read: () => ModelPolicyPayload
  update: (payload: Record<string, unknown>) => ModelPolicyPayload
  resolve: (query: { role?: string; kind?: string; agentId?: string }) => ResolvePayload
}

export function createModelPolicyService(): ModelPolicyService {
  function read(): ModelPolicyPayload {
    const settings = readSettingsRaw()
    const roles = loadModelPolicyRoles(settings)
    const known = new Set([...MODEL_POLICY_ROLES, ...Object.keys(roles)])
    return {
      roles,
      default: resolveDefaultRole(),
      policy: [...known].map(role => describeRole(role, settings)),
    }
  }

  function validateRoles(input: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [role, raw] of Object.entries(input)) {
      if (role === MODEL_POLICY_READ_ONLY_ROLE) {
        throw new ModelPolicyValidationError(
          'The default role is derived from the active provider and cannot be written here.',
          'default_is_read_only',
        )
      }
      if (raw === null || raw === undefined) continue
      if (typeof raw !== 'string') {
        throw new ModelPolicyValidationError(`Role "${role}" must be a string.`, 'invalid_role_value')
      }
      const value = raw.trim()
      if (!value) continue // empty means "unset" — the role is dropped
      const entries = chainEntries(value)
      if (!isChainRole(role) && entries.length > 1) {
        throw new ModelPolicyValidationError(
          `Role "${role}" takes exactly one entry, got ${entries.length}.`,
          'chain_not_allowed',
        )
      }
      for (const entry of entries) {
        const attempt = resolveOne(specWithoutThreshold(entry))
        if (!attempt.ok) {
          throw new ModelPolicyValidationError(
            `Role "${role}" entry "${entry}" is not usable: ${attempt.error}`,
            'unresolvable_reference',
          )
        }
      }
      out[role] = value
    }
    return out
  }

  /**
   * Write ONLY the `modelPolicy` block. Same read-mutate-write path as
   * `PUT /api/settings` (read the raw file, touch one key, write it back), so
   * every other setting survives byte-for-byte.
   */
  function update(payload: Record<string, unknown>): ModelPolicyPayload {
    const rolesInput = payload.roles
    if (rolesInput === undefined || rolesInput === null || typeof rolesInput !== 'object' || Array.isArray(rolesInput)) {
      throw new ModelPolicyValidationError('Body must be { roles: { <role>: "<providerId>:<modelId>" } }.', 'invalid_body')
    }
    if ('default' in payload) {
      throw new ModelPolicyValidationError(
        'The default role is derived from the active provider and cannot be written here.',
        'default_is_read_only',
      )
    }
    const roles = validateRoles(rolesInput as Record<string, unknown>)

    ensureConfigTemplates()
    const settingsPath = path.join(getConfigDir(), 'settings.json')
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as SettingsShape
    const previous = settings.modelPolicy ?? {}
    settings.modelPolicy = { ...previous, version: previous.version ?? 1, roles }
    const tmp = `${settingsPath}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    fs.renameSync(tmp, settingsPath)

    return read()
  }

  function resolve(query: { role?: string; kind?: string; agentId?: string }): ResolvePayload {
    const role = (query.role ?? '').trim()
    if (!role) throw new ModelPolicyValidationError('Query parameter "role" is required.', 'role_required')
    const kind = (query.kind ?? '').trim() || null
    const agentId = (query.agentId ?? '').trim() || null
    const settings = readSettingsRaw()
    const roles = loadModelPolicyRoles(settings)
    const steps: ResolveStep[] = []
    let resolved: ResolvedRolePayload | null = null

    const consider = (step: string, value: string | null, note: string): boolean => {
      if (!value) {
        steps.push({ step, value: null, taken: false, reason: note || 'not configured' })
        return false
      }
      if (resolved) {
        steps.push({ step, value, taken: false, reason: 'a stronger step already decided' })
        return false
      }
      const attempt = resolveOne(specWithoutThreshold(value))
      if (attempt.ok) {
        resolved = attempt.value
        steps.push({ step, value, taken: true, reason: note || 'used' })
        return true
      }
      steps.push({ step, value, taken: false, reason: attempt.error })
      return false
    }

    const isTaskRole = role.startsWith(TASK_ROLE_PREFIX) || kind !== null
    if (isTaskRole) {
      const effectiveKind = kind ?? (role.startsWith(TASK_ROLE_PREFIX) ? role.slice(TASK_ROLE_PREFIX.length) : null)
      steps.push({
        step: 'explicit (create_task provider/model)',
        value: null,
        taken: false,
        reason: 'a call argument, not configuration — not visible from here',
      })
      steps.push({
        step: 'parent task provider',
        value: null,
        taken: false,
        reason: 'only set while running inside a task',
      })
      const personaSpec = agentId ? settings.multiPersona?.perAgentProvider?.[agentId] ?? null : null
      consider(`persona multiPersona.perAgentProvider["${agentId ?? ''}"]`, personaSpec, agentId ? '' : 'no agentId given')
      if (effectiveKind) {
        consider(`modelPolicy.roles["task:${effectiveKind}"]`, roles[`task:${effectiveKind}`] ?? null, '')
      }
      const taskDefault = settings.tasks?.defaultProvider ?? null
      consider('tasks.defaultProvider', taskDefault, '')
      if (!taskDefault) {
        consider('modelPolicy.roles["task:default"]', roles['task:default'] ?? null, '')
      } else {
        steps.push({
          step: 'modelPolicy.roles["task:default"]',
          value: roles['task:default'] ?? null,
          taken: false,
          reason: 'only consulted when tasks.defaultProvider is empty',
        })
      }
    } else if (isChainRole(role)) {
      const value = roles[role] ?? ''
      if (!value) {
        steps.push({ step: `modelPolicy.roles["${role}"]`, value: null, taken: false, reason: 'not configured' })
      }
      for (const entry of chainEntries(value)) {
        consider(`chain entry "${entry}"`, entry, '')
      }
    } else {
      consider(`modelPolicy.roles["${role}"]`, roles[role] ?? null, '')
      const legacyField = MODEL_POLICY_LEGACY_FIELDS[role]
      if (legacyField) {
        const hit = resolveRoleProvider(role, settings)
        const legacyValue = hit && hit.source === 'legacy' ? hit.spec : null
        consider(`legacy ${legacyField}`, legacyValue, legacyValue ? '' : 'not configured')
      }
    }

    if (!resolved) {
      const active = resolveDefaultRole()
      if (active) {
        resolved = { providerId: active.providerId, providerName: active.providerName, modelId: active.modelId }
        steps.push({ step: 'active provider (default role)', value: active.composite, taken: true, reason: 'used' })
      } else {
        steps.push({ step: 'active provider (default role)', value: null, taken: false, reason: 'no active provider' })
      }
    } else {
      steps.push({
        step: 'active provider (default role)',
        value: resolveDefaultRole()?.composite ?? null,
        taken: false,
        reason: 'a stronger step already decided',
      })
    }

    return { role, kind, agentId, steps, resolved }
  }

  return { read, update, resolve }
}
