/**
 * data-policy.ts: ONE gate for every AUTOMATIC model choice.
 *
 * Two questions used to be answered in several places (a provider-type deny
 * list in `model-resolution.ts` and a copy of it in `speech-summary.ts`):
 *
 *   1. Where do the bytes of a private note go (region)?
 *   2. Does that endpoint train on them (training)?
 *
 * This module answers both once, for every path that picks a model WITHOUT a
 * human in the loop: the router chain, every role of `modelPolicy.roles`, the
 * automatic provider fallback, the spoken summary and the text-to-speech
 * voice. An EXPLICIT choice (a strand pinned by the user, a model passed to a
 * task on purpose) is never blocked — it is only written to the audit ring, so
 * the log shows what left the machine.
 *
 * Configuration:
 *
 *   providers.json › providers[].dataPolicy          { region, training }
 *   providers.json › providers[].models[].dataPolicy  per-model override
 *   settings.json  › privacy.modelGate                off | audit | enforce
 *   settings.json  › privacy.blockedModelFamilies     ["glm", "kimi", …]
 *
 * Modes (`settings.privacy.modelGate`, default `audit`):
 *
 *   off      — nothing is filtered, nothing is logged (except China, see below)
 *   audit    — every automatic choice is allowed, violations are logged
 *   enforce  — a violating choice is dropped like an unusable model is today
 *
 * China is the ONE rule that holds in every mode, because that is the
 * behaviour this instance already had before the gate existed
 * (`AUTO_FORBIDDEN_PROVIDER_TYPES`): a provider whose region is `cn` — or
 * whose provider type / name / model id gives away a Chinese endpoint — is
 * never an automatic choice. Turning the gate `off` must not silently widen
 * the old guardrail.
 *
 * `unknown` training counts as `yes` (fail closed): an endpoint that has not
 * been checked is treated as one that trains.
 *
 * Two questions are decided per MODEL, not per provider, because one endpoint
 * can serve both:
 *
 *   1. Where does it run? For Ollama the cached `/api/tags` answer decides
 *      (see `ollama-tag-cache.ts`), and it decides in both directions: a model
 *      with `remote_host` is never `local`, and a model the daemon never
 *      confirmed — no cached answer, not in the list, or an answer older than
 *      30 minutes — is `us/unknown` with the reason `blocked:hosting_unverified`
 *      instead of `local`. The name is no longer evidence FOR local, only
 *      against it (`-cloud` / `:cloud`). The warm-up in the backend keeps the
 *      cache fresh, so this only bites when the box is unreachable.
 *   2. Where does it come from? `privacy.blockedModelFamilies` (default
 *      `glm`, `kimi`) blocks a model family for every AUTOMATIC choice in
 *      EVERY mode — a Chinese-origin model stays out of the automatic paths
 *      even when it runs on the box in this room.
 */
import { loadConfig, warnConfigReadFailed } from './config.js'
import { DEFAULT_BLOCKED_MODEL_FAMILIES, normalizeBlockedFamilyList } from './contracts/settings.js'
import type {
  DataPolicyContract,
  DataRegionContract,
  DataTrainingContract,
  EffectiveDataPolicyContract,
} from './contracts/providers.js'
import { getOllamaHostingVerdict } from './ollama-tag-cache.js'
import type { OllamaHostingVerdict } from './ollama-tag-cache.js'
import { loadProviders } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'

/**
 * Where the data physically goes (`local` = a box on this network) and whether
 * the endpoint trains on it. The unions live in the API contract so the web
 * client and the gate cannot drift apart.
 */
export type DataRegion = DataRegionContract

export type DataTraining = DataTrainingContract

export const DATA_REGIONS: readonly DataRegion[] = Object.freeze(['local', 'eu', 'us', 'cn'])
export const DATA_TRAINING_VALUES: readonly DataTraining[] = Object.freeze(['no', 'yes', 'unknown'])

/**
 * The stored (or derived) policy of one provider/model pair, including where
 * the values come from: a per-model override, the provider block, or the
 * derived defaults of this module (nothing configured).
 */
export type DataPolicy = EffectiveDataPolicyContract

/** What a provider config may carry. Both fields are optional. */
export type DataPolicyInput = DataPolicyContract

export const MODEL_GATE_MODES = Object.freeze(['off', 'audit', 'enforce'] as const)

export type ModelGateMode = (typeof MODEL_GATE_MODES)[number]

export const DEFAULT_MODEL_GATE_MODE: ModelGateMode = 'audit'

/** How a model was chosen. Only `automatic` can be blocked. */
export type ModelChoiceKind = 'automatic' | 'explicit'

export interface GateDecision {
  /** May this choice be used? In `audit` only a China hit says no. */
  allowed: boolean
  /** Machine-readable reason, e.g. `ok:local` or `blocked:training_yes`. */
  reason: string
  policy: DataPolicy
  mode: ModelGateMode
  /** Would the policy allow this choice, regardless of the current mode? */
  policyAllows: boolean
  /** Which entry of `privacy.blockedModelFamilies` matched, if any. */
  blockedFamily?: string | null
}

/**
 * Provider types that must never become a silent automatic choice. Kept as the
 * derived `cn` region of this module; the set stays exported because it is the
 * historical name of the rule. `zai-coding-plan` is the historical spelling,
 * `zai-coding` the id in the `ProviderType` union; both are listed so neither
 * spelling slips through.
 */
export const CN_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'zai', 'zai-coding', 'zai-coding-plan', 'moonshot', 'kimi', 'kimi-coding',
])

/**
 * Belt and braces: a renamed PROVIDER that gives itself away. Model ids are
 * NOT matched here — model origin is the job of the configurable family list
 * (`privacy.blockedModelFamilies`), which blocks in every mode.
 */
const CN_NAME = /(moonshot|kimi|z\.?ai|glm)/i

/**
 * Vendor markers that only ever appear in a Chinese endpoint's MODEL id and
 * are not model families a user might run locally (`glm`/`kimi` weights are —
 * they are covered by the family list instead).
 */
const CN_MODEL_ID = /(moonshot|z\.?ai)/i

/**
 * Hosts that are a Chinese endpoint regardless of the provider type. Z.AI and
 * Moonshot are commonly configured as a generic `openai-completions` provider,
 * so a type-only check would file them as `us/unknown`.
 */
const CN_HOST = /(^|\.)(z\.ai|bigmodel\.cn|zhipuai\.cn|moonshot\.ai|moonshot\.cn|deepseek\.com|qwen\.ai|aliyuncs\.com)$/i

/** Provider types that can be a box on this network. */
const LOCAL_CAPABLE_TYPES: ReadonlySet<string> = new Set([
  'ollama', 'ollama-local', 'openai-compatible',
])

/**
 * Provider types whose daemon can tell us per model where it runs, so for them
 * "local" has to be PROVEN (T1c). Everything else in
 * {@link LOCAL_CAPABLE_TYPES} keeps the old heuristic — an `openai-compatible`
 * endpoint has no `/api/tags`, see the open points of the docs.
 */
const TAG_VERIFIABLE_TYPES: ReadonlySet<string> = new Set(['ollama', 'ollama-local'])

/**
 * Ollama's hosted models carry this marker in their id, in both spellings the
 * registry uses (`qwen3-coder:480b-cloud`, `kimi-k2.5:cloud`). A model that
 * carries it is proxied to ollama.com even when the provider itself is a box
 * on this network, so it is never `local`.
 */
const CLOUD_MODEL_MARKERS = ['-cloud', ':cloud'] as const

/**
 * Is this base URL a host on the private network (RFC1918, loopback, CGNAT,
 * link-local, `.local`/`.lan`, or a bare hostname without a dot)? A public
 * DNS name or public IP is NOT local, even for an Ollama provider.
 */
export function isPrivateHostUrl(baseUrl: string | undefined | null): boolean {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return false
  let host: string
  try {
    host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (!host) return false
  host = host.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true
  if (host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal') || host.endsWith('.home')) return true
  if (/^127\./.test(host)) return true
  if (/^10\./.test(host)) return true
  if (/^192\.168\./.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true
  if (/^169\.254\./.test(host)) return true
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  // A bare hostname without a dot can only be resolved inside this network.
  if (!host.includes('.') && !/^\d+$/.test(host)) return true
  return false
}

function normalizeRegion(value: unknown): DataRegion | null {
  return typeof value === 'string' && (DATA_REGIONS as readonly string[]).includes(value)
    ? (value as DataRegion)
    : null
}

function normalizeTraining(value: unknown): DataTraining | null {
  return typeof value === 'string' && (DATA_TRAINING_VALUES as readonly string[]).includes(value)
    ? (value as DataTraining)
    : null
}

/** Normalize an untrusted `dataPolicy` object; unknown values are dropped. */
export function normalizeDataPolicyInput(value: unknown): { region?: DataRegion; training?: DataTraining } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const region = normalizeRegion(raw.region)
  const training = normalizeTraining(raw.training)
  if (!region && !training) return null
  return { ...(region ? { region } : {}), ...(training ? { training } : {}) }
}

/**
 * The shape the gate needs from a provider. Deliberately narrower than
 * {@link ProviderConfig} so a caller that only holds a resolution record (e.g.
 * `model-resolution.ts`) can use the same function.
 */
export interface ProviderPolicyView {
  id?: string
  name?: string
  providerType?: string
  baseUrl?: string
  dataPolicy?: DataPolicyInput
  models?: ReadonlyArray<{ id: string; dataPolicy?: DataPolicyInput }>
}

function hostOf(baseUrl: string | undefined | null): string {
  const raw = (baseUrl ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function looksChinese(provider: ProviderPolicyView, modelId?: string): boolean {
  if (provider.providerType && CN_PROVIDER_TYPES.has(provider.providerType)) return true
  if (provider.name && CN_NAME.test(provider.name)) return true
  if (modelId && CN_MODEL_ID.test(modelId)) return true
  const host = hostOf(provider.baseUrl)
  if (host && CN_HOST.test(host)) return true
  return false
}

/**
 * Does this model leave the box? `true` = yes (cached `remote_host`, or a cloud
 * name marker), `false` = no.
 *
 * The cached `/api/tags` answer wins: it is what the daemon itself says about
 * the model. Only when nothing is cached for this endpoint/model does the name
 * decide, because `kimi-k2.5:cloud` must not read as local just because the
 * provider points at a private IP.
 */
export function isRemoteHostedModel(provider: ProviderPolicyView, modelId?: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  const cloudName = CLOUD_MODEL_MARKERS.some(marker => id.toLowerCase().includes(marker))
  if (cloudName) return true
  return tagVerdict(provider, id) === 'remote'
}

/** The cached hosting answer of this provider/model pair. */
function tagVerdict(provider: ProviderPolicyView, modelId: string): OllamaHostingVerdict {
  return getOllamaHostingVerdict(
    { providerId: provider.id ?? null, baseUrl: provider.baseUrl ?? null },
    modelId,
  )
}

/**
 * T1c: does this pair LOOK local (Ollama type on a private host, no cloud
 * marker) while the daemon never confirmed it? Then the derived policy is
 * `us/unknown` and the gate reports `blocked:hosting_unverified` instead of
 * the generic `blocked:training_unknown`, so the audit log says what is
 * actually missing: a reachable `/api/tags`.
 */
export function isHostingUnverified(provider: ProviderPolicyView, modelId?: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  if (!provider.providerType || !TAG_VERIFIABLE_TYPES.has(provider.providerType)) return false
  if (!isPrivateHostUrl(provider.baseUrl)) return false
  if (CLOUD_MODEL_MARKERS.some(marker => id.toLowerCase().includes(marker))) return false
  return tagVerdict(provider, id) === 'unverified'
}

/**
 * D6: what a provider/model pair is assumed to be when nothing is configured.
 *
 * For an Ollama provider WITH a model id, `local` has to be proven by a fresh
 * `/api/tags` answer (T1c). Without a model id the question is about the
 * endpoint, not a model, and the private-host answer stands — that is the
 * provider badge in the UI; every gate call passes a model id.
 */
export function deriveDataPolicy(provider: ProviderPolicyView, modelId?: string): DataPolicy {
  if (looksChinese(provider, modelId)) return { region: 'cn', training: 'unknown', source: 'derived' }
  const localCapable = provider.providerType ? LOCAL_CAPABLE_TYPES.has(provider.providerType) : false
  if (!localCapable || !isPrivateHostUrl(provider.baseUrl)) {
    return { region: 'us', training: 'unknown', source: 'derived' }
  }
  const id = (modelId ?? '').trim()
  if (id && TAG_VERIFIABLE_TYPES.has(provider.providerType ?? '')) {
    // Fail closed: only a daemon that listed this model without a
    // `remote_host` makes it local. `unverified` and `remote` are both us/unknown.
    return tagVerdict(provider, id) === 'local' && !isRemoteHostedModel(provider, id)
      ? { region: 'local', training: 'no', source: 'derived' }
      : { region: 'us', training: 'unknown', source: 'derived' }
  }
  if (!isRemoteHostedModel(provider, id)) {
    return { region: 'local', training: 'no', source: 'derived' }
  }
  // Proxied through Ollama Cloud (or any other hosted endpoint): fail closed.
  return { region: 'us', training: 'unknown', source: 'derived' }
}

/**
 * The effective policy of one provider/model pair:
 * per-model override › provider block › derived default.
 *
 * A partially configured block (only a region, only a training value) is
 * completed from the derived default, so half an answer never reads as `no`
 * training by accident.
 */
export function getDataPolicyFor(provider: ProviderPolicyView, modelId?: string): DataPolicy {
  const derived = deriveDataPolicy(provider, modelId)
  const providerLevel = normalizeDataPolicyInput(provider.dataPolicy)
  const modelEntry = modelId
    ? provider.models?.find(m => m.id?.toLowerCase() === modelId.toLowerCase())
    : undefined
  const modelLevel = normalizeDataPolicyInput(modelEntry?.dataPolicy)

  const region = modelLevel?.region ?? providerLevel?.region ?? derived.region
  const training = modelLevel?.training ?? providerLevel?.training ?? derived.training
  const source: DataPolicy['source'] = modelLevel ? 'model' : providerLevel ? 'provider' : 'derived'
  return { region, training, source }
}

/** Read `providers.json` without decrypting keys. Never throws. */
function loadProviderViews(): ProviderConfig[] {
  try {
    return loadProviders().providers
  } catch (err) {
    warnConfigReadFailed('providers.json', err)
    return []
  }
}

/**
 * The effective policy of a provider id (as stored in `providers.json`).
 * An unknown provider id is the most pessimistic answer we can give.
 */
export function getDataPolicy(providerId: string, modelId?: string): DataPolicy {
  const provider = loadProviderViews().find(p => p.id === providerId)
  if (!provider) return { region: 'us', training: 'unknown', source: 'derived' }
  return getDataPolicyFor(provider as ProviderPolicyView, modelId)
}

/**
 * The ONE place that answers "may this model see raw private connector data?"
 * (plan 2026-09-26, P2). True only when all three hold:
 *
 *   1. the effective region is `local`,
 *   2. the model is not remote-hosted (Ollama `-cloud` / `:cloud`, or a cached
 *      `remote_host` from `/api/tags`),
 *   3. the hosting is not unverified (no fresh `/api/tags` answer for it).
 *
 * Everything unknown is false — an unknown provider id, an empty model id, a
 * cold tag cache. The gate (`checkAutomaticModelFor`) answers a different, more
 * permissive question ("is this an acceptable automatic choice?"): an EU model
 * that does not train passes there and must not pass here.
 *
 * A fourth condition is structural and cannot be configured away: the provider
 * must point at a PRIVATE host (`isPrivateHostUrl`). An explicit
 * `dataPolicy.region = 'local'` is an operator statement about their network,
 * and it is still honoured for everything else — but it must not be able to
 * declare `https://api.example-cloud.com` a local box and thereby ship raw
 * mailbox content to a public endpoint. A provider WITHOUT a base URL is not
 * strictly local either: it then talks to its vendor default, which is remote
 * by definition.
 */
export function isStrictlyLocalModelFor(provider: ProviderPolicyView, modelId: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  if (!isPrivateHostUrl(provider.baseUrl)) return false
  if (isRemoteHostedModel(provider, id)) return false
  if (isHostingUnverified(provider, id)) return false
  return getDataPolicyFor(provider, id).region === 'local'
}

/** Same question, resolving the provider id against `providers.json`. */
export function isStrictlyLocalModel(providerId: string, modelId: string): boolean {
  const id = (providerId ?? '').trim()
  if (!id) return false
  const provider = loadProviderViews().find(p => p.id === id)
  if (!provider) return false
  return isStrictlyLocalModelFor(provider as ProviderPolicyView, modelId)
}

interface PrivacyBlock {
  privacy?: { modelGate?: unknown; blockedModelFamilies?: unknown }
}

/**
 * Model families that are never an AUTOMATIC choice, in every mode. Prefix
 * match on the model id without its namespace, case-insensitive:
 * `glm` blocks `glm-4.7-flash:latest` and `library/glm-ocr:latest`.
 *
 * Qwen is deliberately NOT on this list (local Qwen weights are allowed).
 */
export { DEFAULT_BLOCKED_MODEL_FAMILIES }

/**
 * Normalize an untrusted `blockedModelFamilies` value. One implementation,
 * shared with the settings contract and the API schema.
 */
export const normalizeBlockedModelFamilies = normalizeBlockedFamilyList

/** `settings.privacy.blockedModelFamilies`, the default when absent or garbage. */
export function loadBlockedModelFamilies(settings?: PrivacyBlock): string[] {
  let source = settings
  if (!source) {
    try {
      source = loadConfig<PrivacyBlock>('settings.json')
    } catch (err) {
      warnConfigReadFailed('settings.json', err)
      return [...DEFAULT_BLOCKED_MODEL_FAMILIES]
    }
  }
  return normalizeBlockedFamilyList(source.privacy?.blockedModelFamilies)
}

/**
 * The model id without its registry namespace: `library/glm-ocr:latest` and
 * `some-org/GLM-4.7` both reduce to the part the family prefix is matched on.
 */
export function modelIdWithoutNamespace(modelId: string): string {
  const id = (modelId ?? '').trim().toLowerCase()
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/**
 * Which blocked family this model belongs to, or `null`. Prefix match on the
 * namespace-free id, so `kimi-k2.5:cloud` hits `kimi` while `qwen3.8:27b-mlx`
 * hits nothing.
 */
export function blockedModelFamily(modelId: string, families?: readonly string[]): string | null {
  const id = modelIdWithoutNamespace(modelId)
  if (!id) return null
  const list = families ?? loadBlockedModelFamilies()
  for (const family of list) {
    if (family && id.startsWith(family)) return family
  }
  return null
}

/** `settings.privacy.modelGate`, `audit` when absent or garbage. */
export function loadModelGateMode(settings?: PrivacyBlock): ModelGateMode {
  let source = settings
  if (!source) {
    try {
      source = loadConfig<PrivacyBlock>('settings.json')
    } catch (err) {
      warnConfigReadFailed('settings.json', err)
      return DEFAULT_MODEL_GATE_MODE
    }
  }
  const raw = source.privacy?.modelGate
  return typeof raw === 'string' && (MODEL_GATE_MODES as readonly string[]).includes(raw)
    ? (raw as ModelGateMode)
    : DEFAULT_MODEL_GATE_MODE
}

// ── Audit ring ────────────────────────────────────────────────────────

export interface ModelGateAuditEntry {
  /** ISO timestamp of the FIRST occurrence in this dedupe window. */
  at: string
  /** Last occurrence, set as soon as the entry repeats. */
  lastAt?: string
  role: string
  providerId: string
  modelId: string
  reason: string
  policy: DataPolicy
  mode: ModelGateMode
  kind: ModelChoiceKind
  /** Was the choice dropped (`enforce`) or only recorded? */
  blocked: boolean
  /** How often this exact combination occurred inside the dedupe window. */
  count: number
}

/** How many entries the in-memory ring keeps. */
export const MODEL_GATE_AUDIT_LIMIT = 200

/**
 * How long the same (role, provider, model, reason) is folded into ONE entry.
 * A router call per capture must not push everything else out of the ring.
 */
export const MODEL_GATE_AUDIT_DEDUPE_MS = 60_000

const auditRing: ModelGateAuditEntry[] = []

function recordAudit(entry: Omit<ModelGateAuditEntry, 'at' | 'count'>, now = Date.now()): void {
  const key = `${entry.kind}|${entry.role}|${entry.providerId}|${entry.modelId}|${entry.reason}|${entry.mode}`
  for (let i = auditRing.length - 1; i >= 0; i--) {
    const existing = auditRing[i]!
    const existingKey = `${existing.kind}|${existing.role}|${existing.providerId}|${existing.modelId}|${existing.reason}|${existing.mode}`
    if (existingKey !== key) continue
    const seen = Date.parse(existing.lastAt ?? existing.at)
    if (Number.isFinite(seen) && now - seen <= MODEL_GATE_AUDIT_DEDUPE_MS) {
      existing.count += 1
      existing.lastAt = new Date(now).toISOString()
      return
    }
    break
  }
  auditRing.push({ ...entry, at: new Date(now).toISOString(), count: 1 })
  while (auditRing.length > MODEL_GATE_AUDIT_LIMIT) auditRing.shift()
}

/** Newest first. Read by the admin-only audit endpoint. */
export function listModelGateAudit(limit = MODEL_GATE_AUDIT_LIMIT): ModelGateAuditEntry[] {
  const slice = auditRing.slice(-Math.max(0, Math.min(limit, MODEL_GATE_AUDIT_LIMIT)))
  return slice.reverse().map(entry => ({ ...entry, policy: { ...entry.policy } }))
}

/** Test hook and admin reset: forget every recorded entry. */
export function resetModelGateAudit(): void {
  auditRing.length = 0
}

// ── The gate ──────────────────────────────────────────────────────────

export interface GateOptions {
  /** Override the configured mode (tests, and the settings preview UI). */
  mode?: ModelGateMode
  /** Override `privacy.blockedModelFamilies` (tests, preview). */
  blockedFamilies?: readonly string[]
  /** `false` turns the audit entry off (used by the pure re-checks). */
  log?: boolean
  /** Wall clock, for deterministic dedupe tests. */
  now?: number
}

/** Does the POLICY allow this pair, independent of the mode? */
export function policyAllows(policy: DataPolicy): boolean {
  if (policy.region === 'local') return true
  if (policy.region === 'cn') return false
  return policy.training === 'no'
}

function reasonFor(policy: DataPolicy): string {
  if (policy.region === 'cn') return 'blocked:region_cn'
  if (policy.region === 'local') return 'ok:local'
  if (policy.training === 'no') return `ok:training_no:${policy.region}`
  return policy.training === 'unknown' ? 'blocked:training_unknown' : 'blocked:training_yes'
}

/**
 * The reason of a BLOCKING decision. A pair that would be local if the daemon
 * had answered gets its own reason, so the audit log distinguishes "endpoint
 * may train" from "we could not verify where this runs" (T1c).
 */
function blockedReasonFor(policy: DataPolicy, provider: ProviderPolicyView, modelId: string): string {
  const generic = reasonFor(policy)
  if (!generic.startsWith('blocked:')) return generic
  if (policy.region === 'cn') return generic
  if (policy.source !== 'derived') return generic
  return isHostingUnverified(provider, modelId) ? 'blocked:hosting_unverified' : generic
}

/**
 * The ONE gate every automatic model choice passes through.
 *
 * Allowed when the region is `local`, or the endpoint does not train and is
 * not in China. `unknown` training is treated as `yes`.
 *
 * @param role which automatic path is asking (`router`, `summary`, `tts`, …)
 */
export function checkAutomaticModelFor(
  provider: ProviderPolicyView,
  modelId: string,
  role: string,
  options: GateOptions = {},
): GateDecision {
  const policy = getDataPolicyFor(provider, modelId)
  const mode = options.mode ?? loadModelGateMode()
  const allows = policyAllows(policy)
  const reason = blockedReasonFor(policy, provider, modelId)
  const isChina = policy.region === 'cn' || looksChinese(provider, modelId)
  const family = blockedModelFamily(modelId, options.blockedFamilies)

  // China and a blocked model family stay forbidden in EVERY mode: the first
  // is the pre-gate behaviour, the second is an origin decision that does not
  // become acceptable because the weights happen to run in this room.
  const hardBlocked = isChina || family !== null
  const allowed = hardBlocked ? false : mode === 'enforce' ? allows : true
  const decision: GateDecision = {
    allowed,
    reason: isChina ? 'blocked:region_cn' : family ? `blocked:family:${family}` : reason,
    policy: isChina ? { ...policy, region: 'cn' } : policy,
    mode,
    policyAllows: allows && !hardBlocked,
    blockedFamily: family,
  }

  const shouldLog = options.log !== false && mode !== 'off' && !decision.policyAllows
  if (shouldLog) {
    recordAudit({
      role,
      providerId: provider.id ?? '',
      modelId,
      reason: decision.reason,
      policy: decision.policy,
      mode,
      kind: 'automatic',
      blocked: !allowed,
    }, options.now)
  }
  return decision
}

/** Same gate, resolving the provider id against `providers.json`. */
export function checkAutomaticModel(
  providerId: string,
  modelId: string,
  role: string,
  options: GateOptions = {},
): GateDecision {
  const provider = loadProviderViews().find(p => p.id === providerId)
  const view: ProviderPolicyView = provider
    ? (provider as ProviderPolicyView)
    : { id: providerId, providerType: undefined, baseUrl: undefined }
  return checkAutomaticModelFor({ ...view, id: providerId }, modelId, role, options)
}

/**
 * An EXPLICIT choice (user-pinned strand model, a model handed to a task on
 * purpose). Never blocked — D7 — but written to the audit ring so the log
 * shows every endpoint that saw data.
 */
export function auditExplicitModelFor(
  provider: ProviderPolicyView,
  modelId: string,
  role: string,
  options: GateOptions = {},
): GateDecision {
  const providerId = provider.id ?? ''
  const policy = getDataPolicyFor(provider, modelId)
  const mode = options.mode ?? loadModelGateMode()
  const family = blockedModelFamily(modelId, options.blockedFamilies)
  const allows = policyAllows(policy) && family === null
  const reason = family ? `blocked:family:${family}` : blockedReasonFor(policy, provider, modelId)
  if (options.log !== false && mode !== 'off' && !allows) {
    recordAudit({
      role,
      providerId,
      modelId,
      reason,
      policy,
      mode,
      kind: 'explicit',
      blocked: false,
    }, options.now)
  }
  return { allowed: true, reason, policy, mode, policyAllows: allows, blockedFamily: family }
}

/** Same as {@link auditExplicitModelFor}, resolving the id against `providers.json`. */
export function auditExplicitModel(
  providerId: string,
  modelId: string,
  role: string,
  options: GateOptions = {},
): GateDecision {
  const provider = loadProviderViews().find(p => p.id === providerId)
  const view: ProviderPolicyView = { ...(provider as ProviderPolicyView | undefined ?? {}), id: providerId }
  return auditExplicitModelFor(view, modelId, role, options)
}
