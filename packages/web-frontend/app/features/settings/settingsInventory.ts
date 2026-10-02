/**
 * Settings inventory, before and after the W5c split.
 *
 * Every form control of the old single-page tab set (origin/main before W5c)
 * with the tab it lived in, the area it lives in now and the endpoint it
 * feeds. `settingsInventory.test.ts` parses the current SettingsWorkspace.vue
 * and fails if any control is missing, sits in another area or if a control
 * appears that the inventory does not know about.
 *
 * `field` is the element id; controls without an id are keyed by their
 * binding. The shared form saves as a whole via PUT /api/settings.
 */
export interface InventoryRow {
  field: string
  binding: string | null
  before: string
  after: string
  endpoint: string
}

export const SETTINGS_INVENTORY: ReadonlyArray<InventoryRow> = [
  { field: "multi-persona-enabled", binding: "form.multiPersona.enabled", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "multi-persona-default-agent", binding: "form.multiPersona.defaultAgentId", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "language-select", binding: "form.language", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "timezone-select", binding: "form.timezone", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "active-provider", binding: "activeProviderModelValue", before: 'agent', after: 'agent', endpoint: 'POST /api/providers/:id/activate' },
  { field: "thinking-level", binding: "form.thinkingLevel", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "upload-retention", binding: "form.uploads.retentionDays", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "now-set-max", binding: "form.offtangent.nowSetMax", before: 'agent', after: 'now', endpoint: 'PUT /api/settings' },
  { field: "now-set-mode", binding: "form.offtangent.nowSetMode", before: 'agent', after: 'now', endpoint: 'PUT /api/settings' },
  { field: "attention-max-age", binding: "form.offtangent.attentionMaxAgeHours", before: 'agent', after: 'now', endpoint: 'PUT /api/settings' },
  { field: "quick-mode-model", binding: "quickModeModelValue", before: 'agent', after: 'capture', endpoint: 'PUT /api/settings' },
  { field: "quick-mode-thinking", binding: "form.captureModes.quick.thinkingLevel", before: 'agent', after: 'capture', endpoint: 'PUT /api/settings' },
  { field: "quick-mode-style", binding: "form.captureModes.quick.styleHint", before: 'agent', after: 'capture', endpoint: 'PUT /api/settings' },
  { field: "quick-mode-strand", binding: "form.captureModes.quick.strandTitle", before: 'agent', after: 'capture', endpoint: 'PUT /api/settings' },
  { field: "capture-source-puck", binding: "form.captureSources.puck.styleHint", before: 'agent', after: 'capture', endpoint: 'PUT /api/settings' },
  { field: "retry-enabled", binding: "form.retry.enabled", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "retry-max-retries", binding: "form.retry.maxRetries", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "retry-base-delay", binding: "form.retry.baseDelayMs", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "watchdog-warn", binding: "form.watchdog.stallWarnMs", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "watchdog-abort", binding: "form.watchdog.stallAbortMs", before: 'agent', after: 'agent', endpoint: 'PUT /api/settings' },
  { field: "session-timeout", binding: "form.sessionTimeoutMinutes", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "session-summary-provider", binding: "form.sessionSummaryProviderId", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "fact-extraction-enabled", binding: "form.factExtraction.enabled", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "fact-extraction-provider", binding: "form.factExtraction.providerId", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "fact-extraction-min-messages", binding: "form.factExtraction.minSessionMessages", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "consolidation-enabled", binding: "form.memoryConsolidation.enabled", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "consolidation-hour", binding: "form.memoryConsolidation.runAtHour", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "consolidation-days", binding: "form.memoryConsolidation.lookbackDays", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "consolidation-provider", binding: "form.memoryConsolidation.providerId", before: 'memory', after: 'memory', endpoint: 'PUT /api/settings' },
  { field: "heartbeat-enabled", binding: "form.agentHeartbeat.enabled", before: 'agentHeartbeat', after: 'agentHeartbeat', endpoint: 'PUT /api/settings' },
  { field: "heartbeat-interval", binding: "form.agentHeartbeat.intervalMinutes", before: 'agentHeartbeat', after: 'agentHeartbeat', endpoint: 'PUT /api/settings' },
  { field: "heartbeat-night-enabled", binding: "form.agentHeartbeat.nightMode.enabled", before: 'agentHeartbeat', after: 'agentHeartbeat', endpoint: 'PUT /api/settings' },
  { field: "heartbeat-night-start", binding: "form.agentHeartbeat.nightMode.startHour", before: 'agentHeartbeat', after: 'agentHeartbeat', endpoint: 'PUT /api/settings' },
  { field: "heartbeat-night-end", binding: "form.agentHeartbeat.nightMode.endHour", before: 'agentHeartbeat', after: 'agentHeartbeat', endpoint: 'PUT /api/settings' },
  { field: "health-monitor-enabled", binding: "form.healthMonitor.enabled", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "health-monitor-interval", binding: "form.healthMonitorIntervalMinutes", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "fallback-trigger", binding: "form.healthMonitor.fallbackTrigger", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "failures-before-fallback", binding: "form.healthMonitor.failuresBeforeFallback", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "recovery-check-interval", binding: "form.healthMonitor.recoveryCheckIntervalMinutes", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "successes-before-recovery", binding: "form.healthMonitor.successesBeforeRecovery", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "form.healthMonitor.notifications[toggle.key]", binding: "form.healthMonitor.notifications[toggle.key]", before: 'healthMonitor', after: 'healthMonitor', endpoint: 'PUT /api/settings' },
  { field: "telegram-enabled", binding: "form.telegram.enabled", before: 'telegram', after: 'telegram', endpoint: 'PUT /api/settings' },
  { field: "telegram-token", binding: "form.telegram.botToken", before: 'telegram', after: 'telegram', endpoint: 'PUT /api/settings' },
  { field: "batching-delay", binding: "form.telegram.batchingDelayMs", before: 'telegram', after: 'telegram', endpoint: 'PUT /api/settings' },
  { field: "telegram-send-voice-reply", binding: "form.telegram.sendVoiceReply", before: 'telegram', after: 'telegram', endpoint: 'PUT /api/settings' },
  { field: "telegram-send-stall-warnings", binding: "form.telegram.sendStallWarnings", before: 'telegram', after: 'telegram', endpoint: 'PUT /api/settings' },
  { field: "tasks-default-provider", binding: "form.tasks.defaultProvider", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "tasks-max-duration", binding: "form.tasks.maxDurationMinutes", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "tasks-telegram-delivery", binding: "form.tasks.telegramDelivery", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "background-thinking-level", binding: "form.tasks.backgroundThinkingLevel", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "loop-detection-enabled", binding: "form.tasks.loopDetection.enabled", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "loop-detection-method", binding: "form.tasks.loopDetection.method", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "loop-max-failures", binding: "form.tasks.loopDetection.maxConsecutiveFailures", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "loop-smart-provider", binding: "form.tasks.loopDetection.smartProvider", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "loop-smart-interval", binding: "form.tasks.loopDetection.smartCheckInterval", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "status-updates-enabled", binding: "form.tasks.statusUpdates.enabled", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "status-update-interval", binding: "form.tasks.statusUpdates.intervalMinutes", before: 'tasks', after: 'tasks', endpoint: 'PUT /api/settings' },
  { field: "tts-enabled", binding: "form.tts.enabled", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-provider", binding: "ttsProviderComposite", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-openai-model", binding: "form.tts.openaiModel", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-openai-voice", binding: "form.tts.openaiVoice", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-openai-instructions", binding: "form.tts.openaiInstructions", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-deepgram-api-key", binding: "form.tts.deepgramApiKey", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-deepgram-model", binding: "form.tts.deepgramModel", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "mistralSpeaker", binding: "mistralSpeaker", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "mistralMood", binding: "mistralMood", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-gemini-model", binding: "form.tts.geminiModel", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-gemini-voice", binding: "form.tts.geminiVoice", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-gemini-style", binding: "form.tts.geminiStyle", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "tts-preview-text", binding: "ttsPreviewText", before: 'tts', after: 'tts', endpoint: 'POST /api/tts/preview' },
  { field: "tts-format", binding: "form.tts.responseFormat", before: 'tts', after: 'tts', endpoint: 'PUT /api/settings' },
  { field: "stt-enabled", binding: "form.stt.enabled", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-provider", binding: "sttProviderComposite", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-whisper-url", binding: "form.stt.whisperUrl", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-openai-model", binding: "form.stt.openaiModel", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-ollama-model", binding: "form.stt.ollamaModel", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-deepgram-api-key", binding: "form.stt.deepgramApiKey", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-deepgram-model", binding: "form.stt.deepgramModel", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-deepgram-language", binding: "form.stt.deepgramLanguage", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-rewrite-enabled", binding: "form.stt.rewrite.enabled", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "stt-rewrite-provider", binding: "form.stt.rewrite.providerId", before: 'stt', after: 'stt', endpoint: 'PUT /api/settings' },
  { field: "secretEdits[secret.key]", binding: "secretEdits[secret.key]", before: 'secrets', after: 'secrets', endpoint: 'PUT /api/secrets' },
  { field: "new-secret-key", binding: "newSecretKey", before: 'secrets', after: 'secrets', endpoint: 'PUT /api/secrets' },
  { field: "new-secret-value", binding: "newSecretValue", before: 'secrets', after: 'secrets', endpoint: 'PUT /api/secrets' },
]

/**
 * Whole panels that bring their own fields and API, embedded per area. The
 * test checks the tag sits inside the area's block.
 */
export const SETTINGS_PANELS: ReadonlyArray<{ tag: string, before: string, after: string, endpoint: string }> = [
  { tag: 'EmailAccountsWorkspace', before: 'email', after: 'email', endpoint: '/api/email/*' },
  { tag: 'ModelPolicyPanel', before: 'models', after: 'models', endpoint: 'GET/PUT /api/model-policy' },
  { tag: 'SecretHandlesPanel', before: 'secretHandles', after: 'secretHandles', endpoint: '/api/secrets/handles' },
  { tag: 'VoiceNotePanel', before: 'tts', after: 'tts', endpoint: 'PUT /api/settings (tts.voiceNote)' },
]

/** Controls added by W5c (they did not exist before). */
export const SETTINGS_ADDED: ReadonlyArray<{ field: string, area: string, endpoint: string, component: string }> = [
  { field: 'theme-mode', area: 'appearance', endpoint: 'localStorage offtangent-color-mode', component: 'SettingsAppearance' },
  { field: 'voice-replies-enabled', area: 'tts', endpoint: 'GET/PUT /api/speech/voice-replies', component: 'SettingsVoiceReplies' },
  { field: 'settings-search', area: 'overview', endpoint: '-', component: 'SettingsOverview' },
]

export interface ExtractedControl {
  section: string
  tag: string
  id: string | null
  binding: string | null
}

const CONTROL_TAG = /<(Input|Switch|SelectTrigger|textarea|input|Select)\b([^>]*)>/g
const BLOCK_START = /v-(?:else-)?if="activeSection === '([A-Za-z]+)'"/g

/**
 * Pull every bound form control out of a settings template, grouped by the
 * `activeSection === '<id>'` block it sits in. A `<Select>` followed by its
 * `<SelectTrigger>` collapses into one control (binding from the Select, id
 * from the trigger), like the inventory lists it.
 */
export function extractSectionControls(source: string): ExtractedControl[] {
  const scriptAt = source.indexOf('<script')
  const template = scriptAt >= 0 ? source.slice(0, scriptAt) : source
  const marks: Array<{ section: string, at: number }> = []
  for (const match of template.matchAll(BLOCK_START)) marks.push({ section: match[1]!, at: match.index! })
  const raw: ExtractedControl[] = []
  marks.forEach((mark, index) => {
    const block = template.slice(mark.at, index + 1 < marks.length ? marks[index + 1]!.at : template.length)
    for (const match of block.matchAll(CONTROL_TAG)) {
      const attrs = match[2]!
      const id = attrs.match(/\sid="([^"]+)"/)?.[1] ?? null
      const binding = attrs.match(/v-model(?::checked)?(?:\.number)?="([^"]+)"/)?.[1]
        ?? attrs.match(/:(?:model-value|checked)="([^"]+)"/)?.[1]
        ?? null
      if (!id && !binding) continue
      if (match[1] === 'Select' && !binding) continue
      raw.push({ section: mark.section, tag: match[1]!, id, binding })
    }
  })
  const controls: ExtractedControl[] = []
  for (let i = 0; i < raw.length; i++) {
    const control = raw[i]!
    const next = raw[i + 1]
    if (control.tag === 'Select' && next?.tag === 'SelectTrigger' && next.section === control.section) {
      controls.push({ ...control, id: next.id })
      i++
      continue
    }
    controls.push(control)
  }
  return controls
}

/** Section of the block a tag (e.g. a panel component) sits in. */
export function sectionOfTag(source: string, tag: string): string | null {
  const scriptAt = source.indexOf('<script')
  const template = scriptAt >= 0 ? source.slice(0, scriptAt) : source
  const at = template.search(new RegExp(`<${tag}\\b`))
  if (at < 0) return null
  // The tag may carry the `v-else-if` itself, so marks up to its closing `>` count.
  const tagEnd = template.indexOf('>', at)
  let section: string | null = null
  for (const match of template.matchAll(BLOCK_START)) {
    if (match.index! > tagEnd) break
    section = match[1]!
  }
  return section
}

export interface InventoryCheck {
  missing: InventoryRow[]
  moved: Array<{ row: InventoryRow, found: string }>
  unknown: ExtractedControl[]
}

/** Compare the inventory with what a template actually contains. */
export function checkInventory(rows: ReadonlyArray<InventoryRow>, controls: ReadonlyArray<ExtractedControl>): InventoryCheck {
  const key = (c: { id: string | null, binding: string | null }) => c.id ?? c.binding ?? ''
  const byKey = new Map(controls.map(control => [key(control), control]))
  const known = new Set(rows.map(row => row.field))
  const missing: InventoryRow[] = []
  const moved: Array<{ row: InventoryRow, found: string }> = []
  for (const row of rows) {
    const control = byKey.get(row.field)
    if (!control) missing.push(row)
    else if (control.section !== row.after) moved.push({ row, found: control.section })
    else if (row.binding !== null && control.binding !== row.binding) missing.push(row)
  }
  const unknown = controls.filter(control => !known.has(key(control)))
  return { missing, moved, unknown }
}
