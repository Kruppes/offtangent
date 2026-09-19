import { EventEmitter } from 'node:events'
import type { ProviderConfig } from './provider-config.js'

export type OperatingMode = 'normal' | 'fallback'

export interface ProviderManagerEvents {
  'mode:fallback': []
  'mode:normal': []
}

/**
 * Central coordinator for provider switching.
 * Holds primary + fallback provider references and maintains operating mode.
 */
export class ProviderManager extends EventEmitter {
  private mode: OperatingMode = 'normal'
  private primaryProvider: ProviderConfig | null
  private fallbackProvider: ProviderConfig | null
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0

  constructor(primary: ProviderConfig | null, fallback: ProviderConfig | null = null) {
    super()
    this.primaryProvider = primary
    this.fallbackProvider = fallback
  }

  /**
   * Switch to fallback mode. No-op if already in fallback or no fallback configured.
   */
  swapToFallback(): void {
    if (this.mode === 'fallback') return
    if (!this.fallbackProvider) return

    this.mode = 'fallback'
    this.emit('mode:fallback')
  }

  /**
   * Switch back to normal (primary) mode. No-op if already in normal mode.
   */
  swapToPrimary(): void {
    if (this.mode === 'normal') return

    this.mode = 'normal'
    this.emit('mode:normal')
  }

  /**
   * Returns the effective provider config based on current operating mode.
   * In fallback mode, returns the fallback provider; otherwise returns the primary.
   */
  getEffectiveProvider(): ProviderConfig | null {
    if (this.mode === 'fallback' && this.fallbackProvider) {
      return this.fallbackProvider
    }
    return this.primaryProvider
  }

  /**
   * Returns the current operating mode.
   */
  getOperatingMode(): OperatingMode {
    return this.mode
  }

  /**
   * Returns the primary provider config.
   */
  getPrimaryProvider(): ProviderConfig | null {
    return this.primaryProvider
  }

  /**
   * Returns the fallback provider config.
   */
  getFallbackProvider(): ProviderConfig | null {
    return this.fallbackProvider
  }

  /**
   * Update the primary provider reference.
   */
  setPrimaryProvider(provider: ProviderConfig | null): void {
    this.primaryProvider = provider
  }

  /**
   * Update the fallback provider reference.
   */
  setFallbackProvider(provider: ProviderConfig | null): void {
    this.fallbackProvider = provider
  }

  /**
   * Reset to normal mode and clear all counters.
   * Called when admin manually changes the active provider.
   */
  reset(): void {
    this.mode = 'normal'
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
  }

  /**
   * Get the consecutive failure count.
   */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures
  }

  /**
   * Increment the consecutive failure count.
   */
  incrementFailures(): void {
    this.consecutiveFailures++
    this.consecutiveSuccesses = 0
  }

  /**
   * Get the consecutive success count.
   */
  getConsecutiveSuccesses(): number {
    return this.consecutiveSuccesses
  }

  /**
   * Increment the consecutive success count.
   */
  incrementSuccesses(): void {
    this.consecutiveSuccesses++
    this.consecutiveFailures = 0
  }

  /**
   * Reset failure and success counters without changing mode.
   * Used by the backend health monitor after fallback/recovery transitions.
   */
  // fallow-ignore-next-line unused-class-member
  resetCounters(): void {
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
  }
}
