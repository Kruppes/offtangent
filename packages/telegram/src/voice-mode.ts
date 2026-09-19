/**
 * Voice-mode state management for Telegram.
 *
 * Tracks per-user voice preferences:
 * - /voice command: send next response as voice (one-shot)
 * - /voice_on: enable persistent voice mode
 * - /voice_off: disable persistent voice mode
 * - Context-auto: respond with voice when incoming was voice + response is short
 *
 * State is in-memory (resets on restart). DB persistence can be added later.
 */

export interface VoiceModeState {
  /** Persistent voice toggle (via /voice_on, /voice_off) */
  toggleActive: boolean
  /** One-shot flag: send next response as voice, then reset */
  nextAsVoice: boolean
  /** Track if the last incoming message was a voice message */
  lastMessageWasVoice: boolean
  /** Timestamp of last voice-off to suppress repeated "service down" warnings */
  lastServiceWarningAt: number
}

/**
 * Manages voice-mode state per user across the Telegram bot lifecycle.
 */
export class VoiceModeManager {
  private states = new Map<string, VoiceModeState>()

  private getOrCreate(userId: string): VoiceModeState {
    const existing = this.states.get(userId)
    if (existing) return existing

    const state: VoiceModeState = {
      toggleActive: false,
      nextAsVoice: false,
      lastMessageWasVoice: false,
      lastServiceWarningAt: 0,
    }
    this.states.set(userId, state)
    return state
  }

  /** Set one-shot voice flag: next response will be voice */
  setNextAsVoice(userId: string): void {
    const state = this.getOrCreate(userId)
    state.nextAsVoice = true
  }

  /** Enable persistent voice mode */
  enableToggle(userId: string): void {
    const state = this.getOrCreate(userId)
    state.toggleActive = true
  }

  /** Disable persistent voice mode */
  disableToggle(userId: string): void {
    const state = this.getOrCreate(userId)
    state.toggleActive = false
    state.nextAsVoice = false
  }

  /** Record that the last incoming message was voice (for context-auto) */
  setLastMessageWasVoice(userId: string, wasVoice: boolean): void {
    const state = this.getOrCreate(userId)
    state.lastMessageWasVoice = wasVoice
  }

  /** Get the current voice-mode status for a user */
  getStatus(userId: string): { toggleActive: boolean; nextAsVoice: boolean } {
    const state = this.getOrCreate(userId)
    return { toggleActive: state.toggleActive, nextAsVoice: state.nextAsVoice }
  }

  /**
   * Determine if the next response should be sent as voice.
   *
   * @param userId - Telegram user ID
   * @param responseLength - Length of the response text (for context-auto threshold)
   * @param contextAutoEnabled - Whether context-auto trigger is enabled in settings
   * @returns true if the response should be a voice message
   */
  shouldSendAsVoice(userId: string, responseLength: number, contextAutoEnabled: boolean): boolean {
    const state = this.getOrCreate(userId)

    // One-shot /voice command takes priority
    if (state.nextAsVoice) {
      return true
    }

    // Persistent toggle
    if (state.toggleActive) {
      return true
    }

    // Context-auto: if last incoming was voice AND response is short enough
    if (contextAutoEnabled && state.lastMessageWasVoice && responseLength <= 500) {
      return true
    }

    return false
  }

  /**
   * Consume the one-shot flag after sending a voice response.
   * Call this AFTER successfully sending the voice note.
   */
  consumeNextAsVoice(userId: string): void {
    const state = this.getOrCreate(userId)
    state.nextAsVoice = false
  }

  /**
   * Check if we should show a service-down warning (rate-limited to once per 5 min).
   */
  shouldShowServiceWarning(userId: string): boolean {
    const state = this.getOrCreate(userId)
    const now = Date.now()
    if (now - state.lastServiceWarningAt > 5 * 60 * 1000) {
      state.lastServiceWarningAt = now
      return true
    }
    return false
  }

  /** Reset all state for a user */
  reset(userId: string): void {
    this.states.delete(userId)
  }

  /** Get number of users with any voice state */
  get size(): number {
    return this.states.size
  }
}
