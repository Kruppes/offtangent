import fs from 'node:fs'
import path from 'node:path'
import { ensureConfigTemplates, getDefaultTimezone, loadConfig } from './config.js'
import type { Task } from './task-store.js'
import type { ProviderConfig } from './provider-config.js'
import { getProviderDefaultModel } from './provider-config.js'
import type { TaskRuntimeTaskBoundary } from './task-runtime.js'

export interface AgentHeartbeatNightMode {
  enabled: boolean
  startHour: number
  endHour: number
}

export interface AgentHeartbeatSettings {
  enabled: boolean
  intervalMinutes: number
  nightMode: AgentHeartbeatNightMode
}

export const DEFAULT_AGENT_HEARTBEAT_SETTINGS: AgentHeartbeatSettings = {
  enabled: false,
  intervalMinutes: 60,
  nightMode: {
    enabled: true,
    startHour: 23,
    endHour: 8,
  },
}

const HEARTBEAT_PROMPT = `Read /data/config/HEARTBEAT.md. Execute the tasks defined there.
If you have something important to report to the user, use task injection.
If nothing needs attention, complete silently.`

type HeartbeatTaskRuntime = Pick<TaskRuntimeTaskBoundary, 'create' | 'start'>

export interface AgentHeartbeatServiceOptions {
  taskRuntime: HeartbeatTaskRuntime
  getDefaultProvider: () => ProviderConfig | null
  /** Override for testing — returns the current time */
  now?: () => Date
  /** Override for testing — returns the configured timezone */
  getTimezone?: () => string
}

/**
 * Returns true if the HEARTBEAT.md content contains only blank lines,
 * ATX headings (`# ...`), and empty checkbox list items (`- [ ]`).
 * Any other content is considered "actionable".
 */
export function isHeartbeatContentEffectivelyEmpty(content: string): boolean {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (/^#{1,6}\s/.test(trimmed) || /^#{1,6}$/.test(trimmed)) continue
    if (/^-\s*\[\s*\]\s*$/.test(trimmed)) continue
    if (/^<!--.*-->$/.test(trimmed)) continue
    return false
  }
  return true
}

export class AgentHeartbeatService {
  private taskRuntime: HeartbeatTaskRuntime
  private getDefaultProvider: () => ProviderConfig | null
  private nowFn: () => Date
  private getTimezoneFn: () => string
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private settings: AgentHeartbeatSettings = { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

  constructor(options: AgentHeartbeatServiceOptions) {
    if (!options.taskRuntime) {
      throw new Error('AgentHeartbeatService requires taskRuntime')
    }

    this.taskRuntime = options.taskRuntime
    this.getDefaultProvider = options.getDefaultProvider
    this.nowFn = options.now ?? (() => new Date())
    this.getTimezoneFn = options.getTimezone ?? (() => this.loadTimezone())
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.settings = this.loadSettings()
    if (this.settings.enabled) {
      this.scheduleNext()
    }
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  restart(): void {
    this.stop()
    this.running = true
    this.settings = this.loadSettings()
    if (this.settings.enabled) {
      this.scheduleNext()
    }
  }

  getSettings(): AgentHeartbeatSettings {
    return { ...this.settings }
  }

  /**
   * Check if the current time falls within the night mode window.
   * Handles midnight-crossing correctly (e.g. startHour=23, endHour=8 means 23:00→08:00 is night).
   */
  isNightMode(
    now?: Date,
    timezone?: string,
    settings?: AgentHeartbeatSettings,
  ): boolean {
    const s = settings ?? this.settings
    if (!s.nightMode.enabled) return false

    const currentTime = now ?? this.nowFn()
    const tz = timezone ?? this.getTimezoneFn()

    // Get the current hour in the configured timezone
    let currentHour: number
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hour12: false,
      })
      currentHour = parseInt(formatter.format(currentTime), 10)
      // Intl can return 24 for midnight in some locales
      if (currentHour === 24) currentHour = 0
    } catch {
      // Fallback to UTC if timezone is invalid
      currentHour = currentTime.getUTCHours()
    }

    const { startHour, endHour } = s.nightMode

    if (startHour <= endHour) {
      // Non-crossing: e.g. 8→17 means hours 8,9,...,16 are night
      return currentHour >= startHour && currentHour < endHour
    } else {
      // Midnight-crossing: e.g. 23→8 means hours 23,0,1,...,7 are night
      return currentHour >= startHour || currentHour < endHour
    }
  }

  /**
   * Execute the heartbeat: create a background task that reads HEARTBEAT.md
   */
  async executeHeartbeat(): Promise<string | null> {
    // Check night mode
    if (this.isNightMode()) {
      console.log('[axiom] Agent heartbeat skipped: night mode active')
      return null
    }

    // Pre-flight: read HEARTBEAT.md and skip if no actionable content
    const heartbeatPath = path.join(process.env.DATA_DIR ?? '/data', 'config', 'HEARTBEAT.md')
    try {
      const content = fs.readFileSync(heartbeatPath, 'utf-8')
      if (isHeartbeatContentEffectivelyEmpty(content)) {
        console.log('[axiom] Agent heartbeat skipped: HEARTBEAT.md has no actionable content')
        return null
      }
    } catch {
      // File doesn't exist or can't be read — skip heartbeat
      console.log('[axiom] Agent heartbeat skipped: HEARTBEAT.md not found or unreadable')
      return null
    }

    const provider = this.getDefaultProvider()
    if (!provider) {
      console.warn('[axiom] Agent heartbeat skipped: no provider available')
      return null
    }

    // Create a task — sessionId is created by the TaskRunner via
    // SessionManager (with type='heartbeat') when the task starts.
    // Heartbeat runs never accept an explicit model override, so they always
    // use the configured task default.
    const task: Task = this.taskRuntime.create({
      name: 'Agent Heartbeat',
      prompt: HEARTBEAT_PROMPT,
      triggerType: 'heartbeat',
      triggerSourceId: 'agent-heartbeat',
      provider: provider.name,
      model: getProviderDefaultModel(provider),
      isDefaultModel: true,
    })

    try {
      await this.taskRuntime.start(task, provider)
      console.log(`[axiom] Agent heartbeat task started: ${task.id}`)
      return task.id
    } catch (err) {
      console.error('[axiom] Agent heartbeat task failed to start:', err)
      return null
    }
  }

  private scheduleNext(): void {
    if (!this.running || !this.settings.enabled) return

    if (this.timer) {
      clearTimeout(this.timer)
    }

    const intervalMs = this.settings.intervalMinutes * 60 * 1000

    this.timer = setTimeout(() => {
      void this.executeHeartbeat().finally(() => {
        if (this.running && this.settings.enabled) {
          this.scheduleNext()
        }
      })
    }, intervalMs)

    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref()
    }
  }

  private loadSettings(): AgentHeartbeatSettings {
    try {
      ensureConfigTemplates()
      const config = loadConfig<{ agentHeartbeat?: Partial<AgentHeartbeatSettings & { nightMode?: Partial<AgentHeartbeatNightMode> }> }>('settings.json')
      const raw = config.agentHeartbeat

      if (!raw) return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }

      return {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.enabled,
        intervalMinutes: this.safePositiveInt(raw.intervalMinutes, DEFAULT_AGENT_HEARTBEAT_SETTINGS.intervalMinutes),
        nightMode: {
          enabled: typeof raw.nightMode?.enabled === 'boolean' ? raw.nightMode.enabled : DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.enabled,
          startHour: this.safeHour(raw.nightMode?.startHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.startHour),
          endHour: this.safeHour(raw.nightMode?.endHour, DEFAULT_AGENT_HEARTBEAT_SETTINGS.nightMode.endHour),
        },
      }
    } catch {
      return { ...DEFAULT_AGENT_HEARTBEAT_SETTINGS }
    }
  }

  private loadTimezone(): string {
    try {
      ensureConfigTemplates()
      const config = loadConfig<{ timezone?: string }>('settings.json')
      return config.timezone || getDefaultTimezone()
    } catch {
      return getDefaultTimezone()
    }
  }

  private safePositiveInt(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && Number.isInteger(value) && value >= 1 ? value : defaultValue
  }

  private safeHour(value: number | undefined, defaultValue: number): number {
    if (value === undefined) return defaultValue
    return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= 23 ? value : defaultValue
  }
}
