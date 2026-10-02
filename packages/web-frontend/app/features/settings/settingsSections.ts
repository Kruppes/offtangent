/**
 * Settings information architecture (W5c): which areas exist, how they are
 * grouped (everyday vs. system), how a URL maps onto an area and how the
 * overview search finds a setting by its name.
 *
 * Everything here is pure so it can be tested without mounting the settings
 * page. Labels are i18n keys; the caller passes a translate function.
 */

export type SettingsGroupId = 'everyday' | 'system'

/**
 * How an area saves:
 * - `form`: fields of the shared settings form, saved together via the header button (PUT /api/settings)
 * - `own`: the area brings its own save flow (secrets, email, model policy, handles)
 * - `instant`: every control saves on change (device preferences, per-user switches)
 * - `link`: the area lives on its own page; the overview links there
 */
export type SettingsSaveKind = 'form' | 'own' | 'instant' | 'link'

export interface SettingsSection {
  id: string
  group: SettingsGroupId
  icon: string
  labelKey: string
  descriptionKey: string
  save: SettingsSaveKind
  /** Target page for `link` areas. */
  to?: string
  /**
   * Names of the settings inside the area (i18n keys of their labels), so the
   * overview search finds "Timezone" and lands on the right area.
   */
  fieldKeys: string[]
}

export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId, labelKey: string, descriptionKey: string }> = [
  { id: 'everyday', labelKey: 'settings.groups.everyday', descriptionKey: 'settings.groups.everydayDescription' },
  { id: 'system', labelKey: 'settings.groups.system', descriptionKey: 'settings.groups.systemDescription' },
]

export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  // ── Everyday ──
  {
    id: 'appearance', group: 'everyday', icon: 'sun', save: 'instant',
    labelKey: 'settings.sections.appearance', descriptionKey: 'settings.sections.appearanceDescription',
    fieldKeys: ['settings.appearance.theme', 'settings.appearance.modes.auto', 'settings.appearance.modes.light', 'settings.appearance.modes.dark'],
  },
  {
    id: 'now', group: 'everyday', icon: 'zap', save: 'form',
    labelKey: 'settings.sections.now', descriptionKey: 'settings.sections.nowDescription',
    fieldKeys: ['settings.nowSetMax', 'settings.nowSetMode', 'settings.attentionSection', 'settings.attentionMaxAge'],
  },
  {
    id: 'capture', group: 'everyday', icon: 'inbox', save: 'form',
    labelKey: 'settings.sections.capture', descriptionKey: 'settings.sections.captureDescription',
    fieldKeys: [
      'settings.quickModeSection', 'settings.quickModeModel', 'settings.quickModeThinkingLevel',
      'settings.quickModeStyleHint', 'settings.quickModeStrandTitle', 'settings.puckStyleHint',
    ],
  },
  {
    id: 'tts', group: 'everyday', icon: 'volume', save: 'form',
    labelKey: 'settings.ttsTitle', descriptionKey: 'settings.sections.ttsDescription',
    fieldKeys: ['settings.voiceReplies.label', 'settings.ttsEnabled', 'settings.ttsProvider', 'settings.ttsResponseFormat', 'settings.voiceNote.title'],
  },
  {
    id: 'stt', group: 'everyday', icon: 'mic', save: 'form',
    labelKey: 'settings.sttTitle', descriptionKey: 'settings.sections.sttDescription',
    fieldKeys: ['settings.sttEnabled', 'settings.sttProvider', 'settings.sttRewriteEnabled'],
  },
  // ── System ──
  {
    id: 'agent', group: 'system', icon: 'bot', save: 'form',
    labelKey: 'settings.tabs.agent', descriptionKey: 'settings.sections.agentDescription',
    fieldKeys: [
      'settings.agentRulesTitle', 'settings.multiPersonaTitle', 'settings.language', 'settings.timezone',
      'settings.activeProvider', 'settings.thinkingLevel', 'settings.uploadRetention', 'settings.resilienceSection',
    ],
  },
  {
    id: 'models', group: 'system', icon: 'sparkles', save: 'own',
    labelKey: 'settings.tabs.models', descriptionKey: 'settings.tabs.modelsDescription',
    fieldKeys: ['settings.sections.providersLink'],
  },
  {
    id: 'memory', group: 'system', icon: 'brain', save: 'form',
    labelKey: 'settings.tabs.memory', descriptionKey: 'settings.tabs.memoryDescription',
    fieldKeys: ['settings.sessionTimeout', 'settings.sessionSection', 'settings.factExtractionSection', 'settings.consolidationSection'],
  },
  {
    id: 'agentHeartbeat', group: 'system', icon: 'activity', save: 'form',
    labelKey: 'settings.tabs.agentHeartbeat', descriptionKey: 'settings.tabs.agentHeartbeatDescription',
    fieldKeys: ['settings.agentHeartbeatEnabled', 'settings.agentHeartbeatInterval', 'settings.agentHeartbeatNightMode', 'settings.heartbeatTasksTitle'],
  },
  {
    id: 'healthMonitor', group: 'system', icon: 'shield', save: 'form',
    labelKey: 'settings.tabs.healthMonitor', descriptionKey: 'settings.tabs.healthMonitorDescription',
    fieldKeys: ['settings.healthMonitorEnabled', 'settings.healthMonitorFallbackTrigger'],
  },
  {
    id: 'tasks', group: 'system', icon: 'tasks', save: 'form',
    labelKey: 'settings.tabs.tasks', descriptionKey: 'settings.tabs.tasksDescription',
    fieldKeys: ['settings.tasksDefaultProvider', 'settings.tasksMaxDuration', 'settings.tasksLoopDetection'],
  },
  {
    id: 'telegram', group: 'system', icon: 'send', save: 'form',
    labelKey: 'settings.tabs.telegram', descriptionKey: 'settings.tabs.telegramDescription',
    fieldKeys: ['settings.telegramEnabled', 'settings.telegramBotToken', 'settings.telegramUsers'],
  },
  {
    id: 'email', group: 'system', icon: 'mail', save: 'own',
    labelKey: 'settings.tabs.email', descriptionKey: 'settings.tabs.emailDescription',
    fieldKeys: [],
  },
  {
    id: 'secrets', group: 'system', icon: 'key', save: 'own',
    labelKey: 'settings.tabs.secrets', descriptionKey: 'settings.tabs.secretsDescription',
    fieldKeys: [],
  },
  {
    id: 'secretHandles', group: 'system', icon: 'lock', save: 'own',
    labelKey: 'settings.tabs.secretHandles', descriptionKey: 'settings.tabs.secretHandlesDescription',
    fieldKeys: [],
  },
  {
    id: 'logs', group: 'system', icon: 'logs', save: 'link', to: '/logs',
    labelKey: 'settings.sections.logs', descriptionKey: 'settings.sections.logsDescription',
    fieldKeys: [],
  },
  {
    id: 'usage', group: 'system', icon: 'dashboard', save: 'link', to: '/usage',
    labelKey: 'settings.sections.usage', descriptionKey: 'settings.sections.usageDescription',
    fieldKeys: [],
  },
]

const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map(section => [section.id, section]))

export function findSection(id: string | null | undefined): SettingsSection | null {
  if (!id) return null
  return SECTION_BY_ID.get(id) ?? null
}

/** Areas rendered inside the settings page (link areas leave it). */
export function isRoutableSection(id: string | null | undefined): boolean {
  const section = findSection(id)
  return !!section && section.save !== 'link'
}

/** Path of an area; link areas point at their own page. */
export function sectionPath(section: SettingsSection): string {
  return section.save === 'link' && section.to ? section.to : `/settings/${section.id}`
}

/**
 * Old deep links used `/settings?tab=<id>`. Every old tab id is still an area
 * id, so the redirect keeps the id; an unknown tab lands on the overview.
 */
export function legacyTabRedirect(query: Record<string, unknown>): string | null {
  const raw = query.tab
  const tab = Array.isArray(raw) ? raw[0] : raw
  if (typeof tab !== 'string' || tab === '') return null
  return isRoutableSection(tab) ? `/settings/${tab}` : '/settings'
}

/** The header save button belongs to the shared form only. */
export function showsFormSave(id: string | null | undefined): boolean {
  return findSection(id)?.save === 'form'
}

export interface SettingsGroupView {
  id: SettingsGroupId
  labelKey: string
  descriptionKey: string
  sections: SettingsSection[]
}

export function groupSections(sections: ReadonlyArray<SettingsSection> = SETTINGS_SECTIONS): SettingsGroupView[] {
  return SETTINGS_GROUPS.map(group => ({
    ...group,
    sections: sections.filter(section => section.group === group.id),
  })).filter(group => group.sections.length > 0)
}

/** Lowercase, strip accents, collapse whitespace — "Zeitzone " matches "zeitzone". */
export function normalizeSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export interface SettingsSearchHit {
  section: SettingsSection
  /** Translated name of the area. */
  label: string
  /** Translated setting names inside the area that matched (empty = the area itself matched). */
  matches: string[]
}

/**
 * Search over area names, descriptions and the names of the settings inside.
 * Every whitespace-separated term must occur (AND). An empty query returns
 * every area without matches, in declaration order. Areas whose own name
 * matches come first, then areas with a matching setting, then the rest.
 */
export function searchSettings(
  query: string,
  translate: (key: string) => string,
  sections: ReadonlyArray<SettingsSection> = SETTINGS_SECTIONS,
): SettingsSearchHit[] {
  const terms = normalizeSearch(query).split(' ').filter(Boolean)
  const ranked: Array<SettingsSearchHit & { rank: number, order: number }> = []
  sections.forEach((section, order) => {
    const label = translate(section.labelKey)
    if (terms.length === 0) {
      ranked.push({ section, label, matches: [], rank: 0, order })
      return
    }
    const name = normalizeSearch(label)
    const head = normalizeSearch(`${label} ${translate(section.descriptionKey)}`)
    const fieldNames = section.fieldKeys.map(key => translate(key))
    const matches = fieldNames.filter(field => terms.every(term => normalizeSearch(field).includes(term)))
    const all = `${head} ${normalizeSearch(fieldNames.join(' '))}`
    // Rank: the area's own name (0), a setting name (1), anything else (2).
    let rank: number
    if (terms.every(term => name.includes(term))) rank = 0
    else if (matches.length > 0) rank = 1
    else if (terms.every(term => all.includes(term))) rank = 2
    else return
    ranked.push({ section, label, matches: rank === 0 ? [] : matches, rank, order })
  })
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ section, label, matches }) => ({ section, label, matches }))
}
