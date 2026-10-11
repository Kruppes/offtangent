import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getConfigDir } from './config.js'
import {
  auditExplicitModelFor, checkAutomaticModelFor, getDataPolicyFor,
  type GateOptions, type ProviderPolicyView,
} from './data-policy.js'

export interface ModelConsentSelection {
  providerId: string
  role: string
  modelId: string
  variant: string
  fingerprint: string
}

interface ModelConsentRecord extends ModelConsentSelection {
  confirmedAt: string
}

const CONSENT_FILE = 'model-consents.json'

// Bind approval to the destination and truthful policy too, not merely a mutable provider id.
export function modelConsentSelection(
  provider: ProviderPolicyView, modelId: string, role: string, variant = '',
): ModelConsentSelection {
  const providerId = provider.id ?? ''
  const fingerprint = createHash('sha256').update(JSON.stringify([
    1, providerId, role, modelId, variant, provider.providerType ?? '',
    provider.baseUrl ?? '', getDataPolicyFor(provider, modelId),
  ])).digest('hex')
  return { providerId, role, modelId, variant, fingerprint }
}

function readConsents(): ModelConsentRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(getConfigDir(), CONSENT_FILE), 'utf-8'))
    return parsed?.version === 1 && Array.isArray(parsed.consents)
      ? parsed.consents.filter((c: ModelConsentRecord | null) => c && typeof c.providerId === 'string'
        && typeof c.role === 'string' && typeof c.modelId === 'string' && typeof c.variant === 'string'
        && typeof c.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(c.fingerprint)
        && typeof c.confirmedAt === 'string' && Number.isFinite(Date.parse(c.confirmedAt)))
      : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[model-consent] Consent file unreadable; approval ignored')
    return []
  }
}

export function hasModelConsent(selection: ModelConsentSelection): boolean {
  return !!selection.providerId && readConsents().some(c =>
    c.providerId === selection.providerId && c.role === selection.role
    && c.modelId === selection.modelId && c.variant === selection.variant
    && c.fingerprint === selection.fingerprint && typeof c.confirmedAt === 'string',
  )
}

/** Call only after an informed, explicit confirmation, never when loading configuration. */
export function confirmModelConsents(selections: readonly ModelConsentSelection[]): void {
  if (!selections.length) return
  if (selections.some(s => !s.providerId || !s.role || !s.modelId)) throw new Error('Consent requires an explicit provider, role and model')
  const dir = getConfigDir()
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, CONSENT_FILE)
  const consents = readConsents()
  for (const selection of selections) {
    if (!consents.some(c => c.fingerprint === selection.fingerprint)) {
      const { providerId, role, modelId, variant, fingerprint } = selection
      consents.push({ providerId, role, modelId, variant, fingerprint, confirmedAt: new Date().toISOString() })
    }
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, consents }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, target)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

export function checkConfiguredModelFor(
  provider: ProviderPolicyView, modelId: string, role: string,
  explicitlySelected: boolean, variant = '', options: GateOptions = {},
) {
  const automatic = checkAutomaticModelFor(provider, modelId, role, { ...options, log: false })
  // Origin/family bans are hard prohibitions, not consentable training-policy warnings.
  const hardBlocked = automatic.reason === 'blocked:region_cn' || automatic.blockedFamily !== null
  if (!hardBlocked && explicitlySelected && hasModelConsent(modelConsentSelection(provider, modelId, role, variant))) {
    return auditExplicitModelFor(provider, modelId, role, options)
  }
  return checkAutomaticModelFor(provider, modelId, role, options)
}
