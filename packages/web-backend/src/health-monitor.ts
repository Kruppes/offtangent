import type { Database, ProviderConfig, ProviderHealthCheckResult, ProviderHealthStatus, OperatingMode } from '@axiom/core'
import {
  DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
  getActiveProvider,
  getProviderDefaultModel,
  performProviderHealthCheck,
  logHealthCheck,
  updateProviderStatus,
  ensureConfigTemplates,
  loadConfig,
  ProviderManager,
} from '@axiom/core'

interface TelegramConfig {
  enabled: boolean
  botToken: string
  adminUserIds: number[]
}

interface HealthMonitorNotificationToggles {
  healthyToDegraded: boolean
  degradedToHealthy: boolean
  degradedToDown: boolean
  healthyToDown: boolean
  downToFallback: boolean
  fallbackToHealthy: boolean
}

const DEFAULT_NOTIFICATION_TOGGLES: HealthMonitorNotificationToggles = {
  healthyToDegraded: false,
  degradedToHealthy: false,
  degradedToDown: true,
  healthyToDown: true,
  downToFallback: true,
  fallbackToHealthy: true,
}

type NotificationTransition = keyof HealthMonitorNotificationToggles

interface HealthMonitorSettings {
  enabled: boolean
  intervalMinutes: number
  fallbackTrigger: 'down' | 'degraded'
  failuresBeforeFallback: number
  recoveryCheckIntervalMinutes: number
  successesBeforeRecovery: number
  notifications: HealthMonitorNotificationToggles
}

export interface HealthMonitorSnapshot {
  agentStatus: 'running' | 'stopped'
  enabled: boolean
  intervalMinutes: number
  operatingMode: OperatingMode
  activeProvider: {
    id: string
    name: string
    type: string
    model: string
    status: ProviderHealthStatus
  } | null
  primaryProvider: {
    id: string
    name: string
    type: string
    model: string
    lastHealthStatus: ProviderHealthStatus | null
  } | null
  fallbackProvider: {
    id: string
    name: string
    type: string
    model: string
  } | null
  lastCheck: ProviderHealthCheckResult | null
}

export interface HealthMonitorServiceOptions {
  db: Database
  providerManager?: ProviderManager | null
  fetchImpl?: typeof fetch
  now?: () => Date
  /**
   * Timeout for the single cold-start retry that runs when a health check
   * failed with a pure timeout (see checkProviderWithColdStartRetry).
   * Defaults to max(60s, 2× the provider's effective health-check timeout).
   * Exposed mainly so tests can keep the retry fast.
   */
  coldStartRetryTimeoutMs?: number
}

export class HealthMonitorService {
  private db: Database
  private providerManager: ProviderManager | null
  private fetchImpl: typeof fetch
  private now: () => Date
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: HealthMonitorSettings
  private lastCheck: ProviderHealthCheckResult | null = null
  private activeProviderId: string | null = null
  private checkInFlight: Promise<ProviderHealthCheckResult> | null = null
  private primaryLastHealthStatus: ProviderHealthStatus | null = null
  private coldStartRetryTimeoutMs: number | undefined

  constructor(options: HealthMonitorServiceOptions) {
    this.db = options.db
    this.providerManager = options.providerManager ?? null
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.coldStartRetryTimeoutMs = options.coldStartRetryTimeoutMs
    this.settings = this.loadHealthMonitorSettings()
  }

  start(): void {
    if (this.running) return
    this.settings = this.loadHealthMonitorSettings()
    if (!this.settings.enabled) return
    this.running = true
    this.scheduleNext(0)
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  setProviderManager(providerManager: ProviderManager | null): void {
    this.providerManager = providerManager
  }

  restart(options: { resetState?: boolean } = {}): void {
    if (options.resetState) {
      this.lastCheck = null
      this.activeProviderId = null
      this.primaryLastHealthStatus = null
      if (this.providerManager) {
        this.providerManager.reset()
      }
    }

    this.settings = this.loadHealthMonitorSettings()

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    if (!this.settings.enabled) {
      this.running = false
      return
    }

    if (!this.running) {
      this.running = true
    }

    this.scheduleNext(0)
  }

  async runNow(): Promise<ProviderHealthCheckResult> {
    if (this.checkInFlight) {
      return this.checkInFlight
    }

    this.checkInFlight = this.executeCheck().finally(() => {
      this.checkInFlight = null
      if (this.running) {
        const intervalMs = this.getCurrentIntervalMs()
        this.scheduleNext(intervalMs)
      }
    })

    return this.checkInFlight
  }

  getSnapshot(): HealthMonitorSnapshot {
    const mode = this.providerManager?.getOperatingMode() ?? 'normal'
    const provider = getActiveProvider()

    // Build primary provider info
    let primaryProvider: HealthMonitorSnapshot['primaryProvider'] = null
    const primary = this.providerManager?.getPrimaryProvider()
    if (primary) {
      primaryProvider = {
        id: primary.id,
        name: primary.name,
        type: primary.providerType,
        model: getProviderDefaultModel(primary),
        lastHealthStatus: this.primaryLastHealthStatus,
      }
    }

    // Build fallback provider info
    let fallbackProvider: HealthMonitorSnapshot['fallbackProvider'] = null
    const fallback = this.providerManager?.getFallbackProvider()
    if (fallback) {
      fallbackProvider = {
        id: fallback.id,
        name: fallback.name,
        type: fallback.providerType,
        model: getProviderDefaultModel(fallback),
      }
    }

    return {
      agentStatus: this.running ? 'running' : 'stopped',
      enabled: this.settings.enabled,
      intervalMinutes: this.settings.intervalMinutes,
      operatingMode: mode,
      activeProvider: provider
        ? {
            id: provider.id,
            name: provider.name,
            type: provider.providerType,
            model: getProviderDefaultModel(provider),
            status: this.lastCheck?.providerId === provider.id
              ? this.lastCheck.status
              : 'unconfigured',
          }
        : null,
      primaryProvider,
      fallbackProvider,
      lastCheck: this.lastCheck,
    }
  }

  private getCurrentIntervalMs(): number {
    const mode = this.providerManager?.getOperatingMode() ?? 'normal'
    if (mode === 'fallback') {
      return this.settings.recoveryCheckIntervalMinutes * 60 * 1000
    }
    return this.settings.intervalMinutes * 60 * 1000
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    this.timer = setTimeout(() => {
      // Background tick: swallow errors so a closed DB or transient failure
      // during a scheduled run never surfaces as an unhandled rejection.
      this.runNow().catch((err) => {
        console.error('[axiom] Health monitor background check failed:', err)
      })
    }, Math.max(0, delayMs))

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  private async executeCheck(): Promise<ProviderHealthCheckResult> {
    const mode = this.providerManager?.getOperatingMode() ?? 'normal'

    // In fallback mode, check the PRIMARY provider for recovery
    if (mode === 'fallback' && this.providerManager) {
      return this.executeRecoveryCheck()
    }

    // Normal mode: check active provider
    return this.executeNormalCheck()
  }

  /**
   * Runs a health check and, when the result is `down` caused purely by the
   * hard timeout (result.isTimeout), retries ONCE with a longer timeout
   * before anything is recorded. Rationale: a local model cold start (Ollama
   * VRAM eviction + reload) can exceed the regular timeout exactly once —
   * after the retry the model is loaded. A cold provider must neither be
   * marked `down`/`error` nor feed the failure counter that triggers the
   * fallback swap. Real outages (HTTP 401/5xx, connection refused) do not
   * produce timeouts and keep the exact pre-existing single-check behavior;
   * a genuinely hanging provider still fails the retry and is recorded as
   * down within the same check cycle.
   */
  private async checkProviderWithColdStartRetry(
    provider: ProviderConfig | null,
  ): Promise<ProviderHealthCheckResult> {
    const result = await performProviderHealthCheck(provider, {
      fetchImpl: this.fetchImpl,
    })

    if (!provider || result.status !== 'down' || result.isTimeout !== true) {
      return result
    }

    const baseTimeoutMs = provider.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
    const retryTimeoutMs = this.coldStartRetryTimeoutMs ?? Math.max(60_000, baseTimeoutMs * 2)
    console.warn(
      `[axiom] Health check for provider "${provider.name}" timed out after ${baseTimeoutMs}ms `
      + `— retrying once with ${retryTimeoutMs}ms cold-start grace before recording a failure`,
    )

    return performProviderHealthCheck(provider, {
      fetchImpl: this.fetchImpl,
      timeoutMs: retryTimeoutMs,
    })
  }

  private async executeNormalCheck(): Promise<ProviderHealthCheckResult> {
    const provider = getActiveProvider()

    if (provider?.id !== this.activeProviderId) {
      this.activeProviderId = provider?.id ?? null
      this.lastCheck = null
    }

    const previousStatus = this.lastCheck?.status ?? null
    const result = await this.checkProviderWithColdStartRetry(provider)

    result.checkedAt = this.now().toISOString()

    logHealthCheck(this.db, {
      timestamp: result.checkedAt,
      provider: result.providerName,
      status: result.status,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    })

    if (provider) {
      updateProviderStatus(provider.id, result.status === 'down' ? 'error' : 'connected')
    }

    // Track primary health status in normal mode
    if (provider) {
      this.primaryLastHealthStatus = result.status
    }

    this.lastCheck = result

    // Count failures and trigger fallback if threshold reached
    let justSwappedToFallback = false
    if (this.providerManager && provider) {
      const isFailure = this.isFailureStatus(result.status)
      if (isFailure) {
        this.providerManager.incrementFailures()
        if (this.providerManager.getConsecutiveFailures() >= this.settings.failuresBeforeFallback) {
          this.providerManager.swapToFallback()
          // Reset counters after mode change
          this.providerManager.resetCounters()
          justSwappedToFallback = true
        }
      } else {
        // Reset failure counter on success
        this.providerManager.resetCounters()
      }
    }

    // Send notifications based on status transition
    await this.evaluateAndNotify(previousStatus, result.status, provider, result)

    // Send downToFallback notification only on the actual transition
    if (justSwappedToFallback && this.providerManager) {
      const fallback = this.providerManager.getFallbackProvider()
      await this.sendTransitionAlert('downToFallback', provider, result, fallback ?? undefined)
    }

    return result
  }

  private async executeRecoveryCheck(): Promise<ProviderHealthCheckResult> {
    const primary = this.providerManager!.getPrimaryProvider()

    const previousStatus = this.lastCheck?.status ?? null
    const result = await this.checkProviderWithColdStartRetry(primary)

    result.checkedAt = this.now().toISOString()

    logHealthCheck(this.db, {
      timestamp: result.checkedAt,
      provider: result.providerName,
      status: result.status,
      latencyMs: result.latencyMs,
      errorMessage: result.errorMessage,
    })

    if (primary) {
      updateProviderStatus(primary.id, result.status === 'down' ? 'error' : 'connected')
    }

    // Track primary health status
    this.primaryLastHealthStatus = result.status

    this.lastCheck = result

    // Count consecutive successes for recovery
    let justRecovered = false
    if (result.status === 'healthy') {
      this.providerManager!.incrementSuccesses()
      if (this.providerManager!.getConsecutiveSuccesses() >= this.settings.successesBeforeRecovery) {
        this.providerManager!.swapToPrimary()
        // Reset counters after mode change
        this.providerManager!.resetCounters()
        justRecovered = true
      }
    } else {
      // Reset success counter on any non-healthy check
      this.providerManager!.resetCounters()
    }

    // Notifications for recovery checks (only status transitions, not fallback/recovery mode changes)
    await this.evaluateAndNotify(previousStatus, result.status, primary, result)

    // Send fallbackToHealthy notification only on the actual transition back to primary
    if (justRecovered) {
      await this.sendTransitionAlert('fallbackToHealthy', primary, result)
    }

    return result
  }

  private isFailureStatus(status: ProviderHealthStatus): boolean {
    if (status === 'down') return true
    if (this.settings.fallbackTrigger === 'degraded' && status === 'degraded') return true
    return false
  }

  private loadHealthMonitorSettings(): HealthMonitorSettings {
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{
        healthMonitor?: Partial<HealthMonitorSettings>
        healthMonitorIntervalMinutes?: number
      }>('settings.json')

      const healthMonitor = settings.healthMonitor

      if (healthMonitor) {
        const intervalMinutes = healthMonitor.intervalMinutes ?? 5
        return {
          enabled: healthMonitor.enabled ?? true,
          intervalMinutes: Number.isFinite(intervalMinutes) && intervalMinutes >= 1 ? intervalMinutes : 5,
          fallbackTrigger: healthMonitor.fallbackTrigger === 'degraded' ? 'degraded' : 'down',
          failuresBeforeFallback: this.safePositiveInt(healthMonitor.failuresBeforeFallback, 1),
          recoveryCheckIntervalMinutes: this.safePositiveNumber(healthMonitor.recoveryCheckIntervalMinutes, 1),
          successesBeforeRecovery: this.safePositiveInt(healthMonitor.successesBeforeRecovery, 3),
          notifications: { ...DEFAULT_NOTIFICATION_TOGGLES, ...healthMonitor.notifications },
        }
      }

      // Fallback: read top-level healthMonitorIntervalMinutes
      const topLevelInterval = settings.healthMonitorIntervalMinutes ?? 5
      return {
        enabled: true,
        intervalMinutes: Number.isFinite(topLevelInterval) && topLevelInterval >= 1 ? topLevelInterval : 5,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
        notifications: { ...DEFAULT_NOTIFICATION_TOGGLES },
      }
    } catch {
      return {
        enabled: true,
        intervalMinutes: 5,
        fallbackTrigger: 'down',
        failuresBeforeFallback: 1,
        recoveryCheckIntervalMinutes: 1,
        successesBeforeRecovery: 3,
        notifications: { ...DEFAULT_NOTIFICATION_TOGGLES },
      }
    }
  }

  private safePositiveInt(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && Number.isInteger(value) && value >= 1 ? value : defaultValue
  }

  private safePositiveNumber(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && value >= 0.1 ? value : defaultValue
  }

  private loadTelegramConfig(): TelegramConfig | null {
    try {
      ensureConfigTemplates()
      const config = loadConfig<TelegramConfig>('telegram.json')
      return config
    } catch {
      return null
    }
  }

  private getAdminTelegramIds(): number[] {
    const config = this.loadTelegramConfig()
    const configuredIds = config?.adminUserIds ?? []
    const dbIds = (this.db.prepare(
      `SELECT telegram_id
       FROM users
       WHERE role = 'admin' AND telegram_id IS NOT NULL AND trim(telegram_id) != ''`
    ).all() as Array<{ telegram_id: string }>).map((row) => Number.parseInt(row.telegram_id, 10))

    return Array.from(new Set([...configuredIds, ...dbIds].filter((id) => Number.isFinite(id))))
  }

  private resolveTransition(
    previousStatus: ProviderHealthStatus | null,
    currentStatus: ProviderHealthStatus,
  ): NotificationTransition | null {
    if ((previousStatus === 'healthy' || previousStatus === null) && currentStatus === 'degraded') return 'healthyToDegraded'
    if (previousStatus === 'degraded' && currentStatus === 'healthy') return 'degradedToHealthy'
    if (previousStatus === 'degraded' && currentStatus === 'down') return 'degradedToDown'
    if ((previousStatus === 'healthy' || previousStatus === null) && currentStatus === 'down') return 'healthyToDown'
    return null
  }

  private async evaluateAndNotify(
    previousStatus: ProviderHealthStatus | null,
    currentStatus: ProviderHealthStatus,
    provider: ProviderConfig | null,
    result: ProviderHealthCheckResult,
  ): Promise<void> {
    const transition = this.resolveTransition(previousStatus, currentStatus)
    if (transition) {
      await this.sendTransitionAlert(transition, provider, result)
    }
  }

  private getTransitionMessage(
    transition: NotificationTransition,
    provider: ProviderConfig | null,
    result: ProviderHealthCheckResult,
    fallbackProvider?: ProviderConfig,
  ): string {
    const messages: Record<NotificationTransition, { emoji: string; title: string }> = {
      healthyToDegraded: { emoji: '⚠️', title: 'Offtangent provider is degraded' },
      degradedToHealthy: { emoji: '✅', title: 'Offtangent provider recovered from degraded' },
      degradedToDown: { emoji: '🚨', title: 'Offtangent provider is down' },
      healthyToDown: { emoji: '🚨', title: 'Offtangent provider is down' },
      downToFallback: { emoji: '🔄', title: 'Offtangent switched to fallback provider' },
      fallbackToHealthy: { emoji: '✅', title: 'Offtangent primary provider restored' },
    }

    const { emoji, title } = messages[transition]
    const lines = [
      `${emoji} ${title}`,
      `Provider: ${provider?.name ?? 'Not configured'}`,
      `Model: ${(provider ? getProviderDefaultModel(provider) : '') || '—'}`,
      `Status: ${result.status}`,
      `Checked at: ${result.checkedAt}`,
    ]

    if (transition === 'downToFallback' && fallbackProvider) {
      lines.push(`Fallback: ${fallbackProvider.name} (${getProviderDefaultModel(fallbackProvider)})`)
    }

    if (transition === 'fallbackToHealthy') {
      lines.push('Primary provider is back online')
    }

    if (result.latencyMs !== null) {
      lines.push(`Latency: ${result.latencyMs}ms`)
    }

    if (result.errorMessage) {
      lines.push(`Error: ${result.errorMessage}`)
    }

    return lines.join('\n')
  }

  private async sendTransitionAlert(
    transition: NotificationTransition,
    provider: ProviderConfig | null,
    result: ProviderHealthCheckResult,
    fallbackProvider?: ProviderConfig,
  ): Promise<void> {
    if (!this.settings.notifications[transition]) {
      return
    }

    const telegram = this.loadTelegramConfig()
    if (!telegram?.enabled || !telegram.botToken) {
      return
    }

    const adminIds = this.getAdminTelegramIds()
    if (adminIds.length === 0) {
      return
    }

    const text = this.getTransitionMessage(transition, provider, result, fallbackProvider)

    await Promise.all(adminIds.map(async (chatId) => {
      try {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')
          console.error(`[axiom] Failed to send Telegram health alert to ${chatId}: ${response.status} ${body}`)
        }
      } catch (err) {
        console.error(`[axiom] Failed to send Telegram health alert to ${chatId}:`, err)
      }
    }))
  }
}
