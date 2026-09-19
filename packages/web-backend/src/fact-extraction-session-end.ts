import {
  buildModel,
  extractAndStoreFacts,
  getActiveProvider,
  getProviderDefaultModel,
  getApiKeyForProvider,
  loadConfig,
  loadProvidersDecrypted,
  parseProviderModelId,
  resolveRoleSpec,
  sessionKindProducesFacts,
} from '@axiom/core'
import type { Database, ProviderConfig } from '@axiom/core'

export interface FactExtractionSettings {
  enabled: boolean
  providerId: string
  minSessionMessages: number
}

interface SessionHistoryProvider {
  getSessionManager(): {
    buildConversationHistory(
      sessionId: string,
      options?: { includeDescendants?: boolean; includeToolResults?: boolean },
    ): string | null
  }
}

interface SessionRow {
  user_id: number | null
  session_user: string | null
  message_count: number
  agent_id: string | null
  type: string | null
}

interface FactExtractionDeps {
  loadSettings: () => { factExtraction?: Partial<FactExtractionSettings> }
  loadProvidersDecrypted: typeof loadProvidersDecrypted
  getActiveProvider: typeof getActiveProvider
  buildModel: typeof buildModel
  getApiKeyForProvider: typeof getApiKeyForProvider
  extractAndStoreFacts: typeof extractAndStoreFacts
  console: Pick<typeof console, 'log' | 'warn' | 'error'>
}

interface TriggerFactExtractionOptions {
  db: Database
  agentCore: SessionHistoryProvider | null
  userId: string
  sessionId: string
  deps?: Partial<FactExtractionDeps>
}

const DEFAULT_FACT_EXTRACTION_SETTINGS: FactExtractionSettings = {
  enabled: true,
  providerId: '',
  minSessionMessages: 3,
}

const defaultDeps: FactExtractionDeps = {
  loadSettings: () => loadConfig<{ factExtraction?: Partial<FactExtractionSettings> }>('settings.json'),
  loadProvidersDecrypted,
  getActiveProvider,
  buildModel,
  getApiKeyForProvider,
  extractAndStoreFacts,
  console,
}

function parseStrictNumericUserId(value: string | null | undefined): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const numericUserId = Number.parseInt(trimmed, 10)
  return Number.isSafeInteger(numericUserId) ? numericUserId : null
}

function getFactExtractionSettings(
  loadSettings: typeof defaultDeps.loadSettings,
): FactExtractionSettings {
  try {
    const merged = {
      ...DEFAULT_FACT_EXTRACTION_SETTINGS,
      ...(loadSettings().factExtraction ?? {}),
    }
    // modelPolicy.roles.factExtraction wins over the legacy
    // `factExtraction.providerId` field (ADR 2026-09-13, read-through).
    return { ...merged, providerId: resolveRoleSpec('factExtraction', merged.providerId) }
  } catch {
    return { ...DEFAULT_FACT_EXTRACTION_SETTINGS }
  }
}

export async function resolveFactExtractionExecutionContext(
  settings: FactExtractionSettings,
  deps: Partial<FactExtractionDeps> = {},
): Promise<{ provider: ProviderConfig; model: ReturnType<typeof buildModel>; apiKey: string } | null> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  let provider: ProviderConfig | null = null

  let modelId: string | undefined

  if (settings.providerId) {
    const parsed = parseProviderModelId(settings.providerId)
    if (parsed.providerId) {
      const providers = resolvedDeps.loadProvidersDecrypted()
      provider = providers.providers.find(candidate => candidate.id === parsed.providerId) ?? null
      modelId = parsed.modelId

      if (!provider) {
        resolvedDeps.console.warn(
          `[fact-extraction] Configured provider '${parsed.providerId}' not found, using active provider`,
        )
      }
    }
  }

  provider = provider ?? resolvedDeps.getActiveProvider()
  if (!provider) return null

  const resolvedModelId = modelId ?? getProviderDefaultModel(provider)

  return {
    provider,
    model: resolvedDeps.buildModel(provider, resolvedModelId),
    apiKey: await resolvedDeps.getApiKeyForProvider(provider),
  }
}

export function triggerFactExtractionForSessionEnd(options: TriggerFactExtractionOptions): boolean {
  const { db, agentCore, userId, sessionId } = options
  const deps = { ...defaultDeps, ...(options.deps ?? {}) }
  const settings = getFactExtractionSettings(deps.loadSettings)

  if (!agentCore || !settings.enabled) {
    return false
  }

  const sessionRow = db.prepare(
    'SELECT user_id, session_user, message_count, agent_id, type FROM sessions WHERE id = ?'
  ).get(sessionId) as SessionRow | undefined

  if (!sessionRow || sessionRow.message_count < settings.minSessionMessages) {
    return false
  }

  // SPEC 11.4 gate 1: only interactive sessions produce durable facts.
  // Task, heartbeat, consolidation and cronjob sessions never reach the
  // extractor, whatever ended them.
  if (!sessionKindProducesFacts(sessionRow.type ?? 'interactive')) {
    deps.console.log(`[fact-extraction] Skipping session ${sessionId}: kind ${sessionRow.type} produces no durable facts`)
    return false
  }

  const numericUserId = sessionRow.user_id
    ?? parseStrictNumericUserId(sessionRow.session_user)
    ?? parseStrictNumericUserId(userId)
  if (numericUserId === null) {
    deps.console.warn(`[fact-extraction] Skipping session ${sessionId}: no numeric user ID available`)
    return false
  }

  // Own messages only: descendant task sessions are part of the summary
  // but not of the fact base (gate 1 again, on the transcript side). Tool
  // rows stay out as before.
  const conversationHistory = agentCore.getSessionManager().buildConversationHistory(sessionId, { includeDescendants: false })

  if (!conversationHistory) {
    return false
  }

  void (async () => {
    try {
      const executionContext = await resolveFactExtractionExecutionContext(settings, deps)
      if (!executionContext) {
        deps.console.warn(`[fact-extraction] No provider available for session ${sessionId}`)
        return
      }

      const result = await deps.extractAndStoreFacts(
        db,
        numericUserId,
        sessionId,
        conversationHistory,
        executionContext.model,
        executionContext.apiKey,
        executionContext.provider,
        // Scope extracted facts to the session's persona. Without this every
        // fact landed under agent_id='main' and Warren/Bob session knowledge
        // was injected into main conversations (multi-persona bleeding).
        sessionRow.agent_id ?? 'main',
        sessionRow.type ?? 'interactive',
      )

      deps.console.log(`[fact-extraction] Session ${sessionId}: ${result.stored} new facts`)
    } catch (err) {
      deps.console.error(`[fact-extraction] Failed for session ${sessionId}:`, err)
    }
  })()

  return true
}
