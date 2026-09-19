
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import type { TaskStore } from './task-store.js'
import type { ScheduledTaskStore } from './scheduled-task-store.js'
import { parseCronExpression, getNextRunTime } from './cron-parser.js'
import {
  loadProviders,
  setActiveProvider,
  getProviderDefaultModel,
} from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { getConfigDir, loadConfig } from './config.js'
import { SETTINGS_THINKING_LEVELS, type SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { getAgentSkillsDir, listAgentSkills, trackAgentSkillUsage } from './agent-skills.js'
import { getSkill, loadSkills } from './skill-config.js'
import { renderSkillBlock, wrapAttachedSkills } from './attached-skills.js'

export type SlashCommandSurface = 'web' | 'telegram'

export interface SlashCommandMetadata {
  name: string
  aliases?: string[]
  description: string
  usage?: string
  surfaces: SlashCommandSurface[]
}

/**
 * Structured reply for surfaces that can render interactive UI (web buttons,
 * Telegram inline keyboards). Each option carries a verbatim slash-command
 * string the surface should re-dispatch when picked, so the same handler
 * runs again and produces the next picker / final confirmation.
 */
export interface SlashCommandPickerOption {
  /** Slash-command text to re-dispatch on selection (must start with `/`). */
  command: string
  /** Primary label shown on the button. */
  label: string
  /** Optional secondary line shown beneath the label (web only). */
  description?: string
  /** Optional short tag rendered next to the label (e.g. "active", "default"). */
  badge?: string
}

export interface SlashCommandPicker {
  kind: 'picker'
  /** Stable id for this picker step (e.g. "model:providers"). */
  pickerId: string
  /** Optional title shown above the buttons. */
  title?: string
  /** Optional explanatory text shown above the buttons. */
  description?: string
  options: SlashCommandPickerOption[]
}

export function isSlashCommandPicker(value: unknown): value is SlashCommandPicker {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'picker'
}

/**
 * Reply that asks the surface to run a regular agent turn with `text` as the
 * user message. Used by commands that enrich the user's input (e.g. `/skill`
 * injects a SKILL.md) rather than answering directly. Surfaces persist the
 * raw slash command the user typed and hand `text` to the agent.
 */
export interface SlashCommandAgentTurn {
  kind: 'agent_turn'
  /** Full message to send to the agent. */
  text: string
  /**
   * Synthetic tool call recorded at the start of the turn so the work the
   * command did (e.g. reading a SKILL.md) shows up like the agent's own tool
   * calls. Surfaces pass it through as `StartTurnInput.preambleToolCalls`.
   */
  toolCall?: { toolName: string; toolArgs: unknown; toolResult: unknown }
  /** Short label for surfaces that must replace an interactive prompt (Telegram picker edit). */
  label?: string
}

export function isSlashCommandAgentTurn(value: unknown): value is SlashCommandAgentTurn {
  return typeof value === 'object' && value !== null
    && (value as { kind?: unknown }).kind === 'agent_turn'
}

export type SlashCommandReply = string | SlashCommandPicker | SlashCommandAgentTurn | null

export interface SlashCommandDefinition extends SlashCommandMetadata {
  handler?: (ctx: SlashCommandContext) => Promise<SlashCommandReply> | SlashCommandReply
}

export interface StartModelTaskInput {
  /** Exact model id to pin the task to (must be enabled on a configured provider). */
  modelId: string
  prompt: string
}

export interface StartModelTaskResult {
  taskId: string
  taskName: string
  providerName: string
  modelId: string
}

export interface SlashCommandContext {
  userId: string | null
  surface: SlashCommandSurface
  args: string
  command: SlashCommandDefinition
  registry: SlashCommandRegistry
  db?: Database
  taskStore?: TaskStore
  scheduledTaskStore?: ScheduledTaskStore
  /** Persona the command was issued under (multi-persona surfaces; default 'main'). */
  agentId?: string
  /**
   * Starts a one-off background task pinned to a specific model, wired by the
   * host runtime (runtime-composition). The task result is injected back into
   * the user's chat through the normal task-notification pipeline.
   */
  startModelTask?: (input: StartModelTaskInput) => Promise<StartModelTaskResult>
  onThinkingLevelChanged?: (level: SettingsThinkingLevel) => void
  /**
   * Notifies the host runtime that the active provider/model changed on disk
   * (via /model, /offline, /online) so it can rebuild the agent core. Without
   * this the running agent keeps streaming on the previously bound model.
   */
  onActiveProviderChanged?: () => void
}

export interface ParsedSlashCommand {
  raw: string
  name: string
  args: string
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  if (typeof input !== 'string') return null
  const raw = input
  if (!raw.startsWith('/')) return null
  if (raw.startsWith('//')) return null
  const body = raw.slice(1)
  if (body.length === 0) return null

  // Both whitespace and `:` end the command name so `/skill:foo bar` parses
  // as name="skill", args="foo bar".
  const sepIdx = body.search(/[\s:]/)
  let head = sepIdx === -1 ? body : body.slice(0, sepIdx)
  const args = sepIdx === -1 ? '' : body.slice(sepIdx + 1).trim()

  const atIdx = head.indexOf('@')
  if (atIdx !== -1) head = head.slice(0, atIdx)

  if (!/^[a-zA-Z0-9_]+$/.test(head)) return null

  return { raw, name: head.toLowerCase(), args }
}

export type SlashCommandDispatchResult =
  | { kind: 'no_command' }
  | { kind: 'not_found'; name: string }
  | { kind: 'wrong_surface'; command: SlashCommandDefinition }
  | { kind: 'external'; command: SlashCommandDefinition; args: string }
  | { kind: 'handled'; command: SlashCommandDefinition; reply: SlashCommandReply }
  | { kind: 'error'; command: SlashCommandDefinition; error: Error }

export class SlashCommandRegistry {
  private byName = new Map<string, SlashCommandDefinition>()
  private aliasToName = new Map<string, string>()

  register(def: SlashCommandDefinition): this {
    const name = def.name.toLowerCase()
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw new Error(`Invalid slash-command name: "${def.name}"`)
    }
    if (this.byName.has(name)) {
      throw new Error(`Slash command already registered: "${name}"`)
    }
    if (this.aliasToName.has(name)) {
      throw new Error(`Slash command name conflicts with existing alias: "${name}"`)
    }
    if (!def.surfaces || def.surfaces.length === 0) {
      throw new Error(`Slash command "${name}" must declare at least one surface`)
    }
    this.byName.set(name, { ...def, name })
    for (const alias of def.aliases ?? []) {
      const a = alias.toLowerCase()
      if (!/^[a-z0-9_]+$/.test(a)) {
        throw new Error(`Invalid slash-command alias: "${alias}"`)
      }
      if (this.byName.has(a) || this.aliasToName.has(a)) {
        throw new Error(`Slash command alias collides: "${a}"`)
      }
      this.aliasToName.set(a, name)
    }
    return this
  }

    resolve(nameOrAlias: string): SlashCommandDefinition | undefined {
    const key = nameOrAlias.toLowerCase()
    const direct = this.byName.get(key)
    if (direct) return direct
    const aliased = this.aliasToName.get(key)
    return aliased ? this.byName.get(aliased) : undefined
  }

    list(surface: SlashCommandSurface): SlashCommandDefinition[] {
    return [...this.byName.values()]
      .filter((c) => c.surfaces.includes(surface))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async dispatch(
    input: string,
    ctxBase: Omit<SlashCommandContext, 'args' | 'command'>,
  ): Promise<SlashCommandDispatchResult> {
    const parsed = parseSlashCommand(input)
    if (!parsed) return { kind: 'no_command' }
    const def = this.resolve(parsed.name)
    if (!def) return { kind: 'not_found', name: parsed.name }
    if (!def.surfaces.includes(ctxBase.surface)) {
      return { kind: 'wrong_surface', command: def }
    }
    if (!def.handler) {
      return { kind: 'external', command: def, args: parsed.args }
    }
    try {
      const reply = await def.handler({ ...ctxBase, command: def, args: parsed.args })
      return { kind: 'handled', command: def, reply: reply ?? null }
    } catch (err) {
      return { kind: 'handled', command: def, reply: `⚠️ ${(err as Error).message || 'Slash command failed.'}` }
    }
  }
}


export function renderHelp(registry: SlashCommandRegistry, surface: SlashCommandSurface): string {
  const cmds = registry.list(surface)
  if (cmds.length === 0) return 'No slash commands are available on this surface.'
  const lines: string[] = ['Available commands:']
  const namePad = Math.max(...cmds.map((c) => c.name.length + 1))
  for (const c of cmds) {
    const head = `/${c.name}`.padEnd(namePad + 1)
    lines.push(`${head} — ${c.description}`)
  }
  return lines.join('\n')
}

export function registerBuiltInSlashCommands(registry: SlashCommandRegistry): void {
  registry.register({
    name: 'help',
    description: 'List available slash commands.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => renderHelp(ctx.registry, ctx.surface),
  })

  registry.register({
    name: 'tasks',
    description: 'Show recent and currently running background tasks.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => {
      if (!ctx.taskStore) return 'Task store is not available on this surface.'
      const running = ctx.taskStore.list({ status: 'running', limit: 10 })
      const recent = ctx.taskStore.list({ limit: 5 })
      return formatTasksReply(running, recent)
    },
  })

  registry.register({
    name: 'cronjobs',
    aliases: ['cron'],
    description: 'Show configured cronjobs and their next run times.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => {
      if (!ctx.scheduledTaskStore) return 'Cronjob store is not available on this surface.'
      const jobs = ctx.scheduledTaskStore.list().map((j) => ({
        id: j.id,
      name: j.name,
        cronExpression: j.schedule,
        enabled: j.enabled,
        nextRunAt: computeNextRunAt(j.schedule),
        lastRunAt: j.lastRunAt,
      }))
      return formatCronjobsReply(jobs)
    },
  })

  registry.register({
    name: 'model',
    aliases: ['provider'],
    description: 'Show or switch the active provider and model.',
    usage: '/model [<provider> [<model>]]',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleModelCommand(ctx.args, ctx),
  })

  registry.register({
    name: 'offline',
    description: 'Switch the active provider to the configured local provider (offline mode).',
    usage: '/offline [<local-provider>]',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleOfflineCommand(ctx),
  })

  registry.register({
    name: 'online',
    description: 'Switch back to the provider that was active before /offline.',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleOnlineCommand(ctx),
  })

  registry.register({
    name: 'thinking',
    description: 'Show or set the main chat thinking level.',
  usage: '/thinking <off|minimal|low|medium|high|xhigh>',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleThinkingCommand(ctx),
  })

  for (const spec of MODEL_TASK_COMMANDS) {
    registry.register({
      name: spec.name,
      description: `Run the request as a one-off background task on ${spec.modelLabel} (default chat model stays unchanged).`,
      usage: `/${spec.name} <prompt>`,
      surfaces: ['telegram'],
      handler: (ctx) => handleModelTaskCommand(ctx, spec),
    })
  }
  registry.register({
    name: 'skill',
    description: 'Load a skill into the current conversation.',
    usage: '/skill:<name> [prompt]',
    surfaces: ['web', 'telegram'],
    handler: (ctx) => handleSkillCommand(ctx.args),
  })
}

/**
 * Prefix commands that run a single request as a background task pinned to a
 * heavy model, without touching the default chat model. Extend this table to
 * add more shortcuts (e.g. opus, haiku) — the command name is the Telegram
 * prefix, the modelId must be enabled on a configured provider.
 */
export const MODEL_TASK_COMMANDS: ReadonlyArray<{ name: string; modelId: string; modelLabel: string }> = [
  { name: 'fable', modelId: 'claude-fable-5', modelLabel: 'Claude Fable 5' },
  { name: 'opus', modelId: 'claude-opus-4-8', modelLabel: 'Claude Opus 4.8' },
  { name: 'sonnet', modelId: 'claude-sonnet-5', modelLabel: 'Claude Sonnet 5' },
]

async function handleModelTaskCommand(
  ctx: SlashCommandContext,
  spec: { name: string; modelId: string; modelLabel: string },
): Promise<string> {
  const prompt = ctx.args.trim()
  if (!prompt) {
    return `Usage: /${spec.name} <prompt>\nRuns the request as a background task on ${spec.modelLabel}; the result is posted back into this chat.`
  }
  if (!ctx.startModelTask) {
    return `/${spec.name} is not available on this surface.`
  }
  const result = await ctx.startModelTask({ modelId: spec.modelId, prompt })
  return `🚀 Task started on ${result.providerName} (${result.modelId}).\n\nTask: ${result.taskName}\nID: ${result.taskId}\n\nThe result will be posted here when it finishes.`
}

interface OfflineSettings {
  /** Provider id of the designated local/offline provider. */
  localProviderId?: string
  /** `providerId:modelId` composite that was active before /offline. */
  previousProvider?: string
}

function readOfflineSettings(): OfflineSettings {
  try {
    const settings = loadConfig<{ offline?: OfflineSettings }>('settings.json')
    return settings.offline ?? {}
  } catch {
    return {}
  }
}

function writeOfflineSettings(update: Partial<OfflineSettings>): void {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  const offline = { ...(settings.offline as OfflineSettings | undefined ?? {}), ...update }
  // Drop cleared keys so the file stays tidy
  for (const key of Object.keys(offline) as Array<keyof OfflineSettings>) {
    if (offline[key] === undefined || offline[key] === '') delete offline[key]
  }
  settings.offline = offline
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}

function handleOfflineCommand(ctx: SlashCommandContext): string {
  let file
  try {
    file = loadProviders()
  } catch (err) {
    return `Could not read provider settings: ${(err as Error).message}`
  }

  const offline = readOfflineSettings()
  const arg = ctx.args.trim()

  // `/offline <provider>` also (re)configures which provider is the local one.
  let localProvider: ProviderConfig | undefined
  if (arg) {
    localProvider = findProvider(file.providers, arg)
    if (!localProvider) {
      return `Unknown provider: ${arg}\nConfigured providers: ${file.providers.map((p) => p.name).join(', ') || '(none)'}`
    }
    writeOfflineSettings({ localProviderId: localProvider.id })
  } else if (offline.localProviderId) {
    localProvider = file.providers.find((p) => p.id === offline.localProviderId)
    if (!localProvider) {
      return `The configured offline provider (id: ${offline.localProviderId}) no longer exists.\nSet a new one with /offline <provider>.`
    }
  } else {
    return [
      'No offline provider configured yet.',
      '',
      '1. Register your local endpoint (e.g. a local machine running Ollama/LM Studio) as a provider in Settings → Providers (OpenAI-compatible, base URL like http://<host>:11434/v1).',
      '2. Then run /offline <provider-name> once — afterwards a bare /offline toggles to it.',
    ].join('\n')
  }

  const localModel = getProviderDefaultModel(localProvider)
  if (!localModel) {
    return `Provider "${localProvider.name}" has no enabled models — enable one in Settings → Providers first.`
  }

  if (file.activeProvider === localProvider.id) {
    return `Already offline — active: ${localProvider.name} (${file.activeModel ?? localModel}).`
  }

  // Remember what was active so /online can restore it.
  if (file.activeProvider) {
    writeOfflineSettings({ previousProvider: `${file.activeProvider}:${file.activeModel ?? ''}` })
  }

  try {
    setActiveProvider(localProvider.id, localModel)
  } catch (err) {
    return `Could not switch provider: ${(err as Error).message}`
  }
  ctx.onActiveProviderChanged?.()

  return `📴 Offline mode: active provider is now ${localProvider.name} (${localModel}).\nSwitch back with /online.`
}

function handleOnlineCommand(ctx: SlashCommandContext): string {
  const offline = readOfflineSettings()
  if (!offline.previousProvider) {
    return 'No previous provider stored — nothing to restore. Use /model to pick one.'
  }

  // Split at the FIRST colon only — model ids may contain colons (qwen3:30b)
  const colonIdx = offline.previousProvider.indexOf(':')
  const providerId = colonIdx === -1 ? offline.previousProvider : offline.previousProvider.slice(0, colonIdx)
  const modelId = colonIdx === -1 ? undefined : offline.previousProvider.slice(colonIdx + 1) || undefined
  let file
  try {
    file = loadProviders()
  } catch (err) {
    return `Could not read provider settings: ${(err as Error).message}`
  }
  const provider = file.providers.find((p) => p.id === providerId)
  if (!provider) {
    writeOfflineSettings({ previousProvider: '' })
    return `The previously active provider no longer exists. Use /model to pick one.`
  }

  const targetModel = modelId && (provider.enabledModels ?? []).includes(modelId)
    ? modelId
    : getProviderDefaultModel(provider)

  try {
    setActiveProvider(provider.id, targetModel)
  } catch (err) {
    return `Could not switch provider: ${(err as Error).message}`
  }
  writeOfflineSettings({ previousProvider: '' })
  ctx.onActiveProviderChanged?.()

  return `🌐 Back online: active provider is now ${provider.name} (${targetModel}).`
}

export interface LoadableSkill {
  /** Identifier accepted by `/skill:<id>` (agent skill name or `owner/name`). */
  id: string
  name: string
  description: string
  kind: 'agent' | 'installed'
}

/**
 * Skills the user may load via `/skill`: self-created agent skills plus
 * enabled installed skills. Agent skills are addressed by their directory
 * name (what `loadAttachedSkillContent` expects), installed ones by id.
 */
export function listLoadableSkills(): LoadableSkill[] {
  const out: LoadableSkill[] = []
  for (const s of listAgentSkills()) {
    out.push({
      id: path.basename(s.location),
      name: s.name,
      description: s.description,
      kind: 'agent',
    })
  }
  try {
    for (const s of loadSkills().skills) {
      if (!s.enabled || !s.path) continue
      if (!fs.existsSync(path.join(s.path, 'SKILL.md'))) continue
      out.push({ id: s.id, name: s.name, description: s.description, kind: 'installed' })
    }
  } catch {
    // skills.json unreadable → agent skills only
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function findLoadableSkill(skills: LoadableSkill[], key: string): LoadableSkill | undefined {
  const k = key.toLowerCase()
  return skills.find((s) => s.id.toLowerCase() === k)
    ?? skills.find((s) => s.name.toLowerCase() === k)
}

/**
 * `/skill` → picker with all loadable skills.
 * `/skill:<name> [prompt]` → agent turn with the SKILL.md injected. Without a
 * prompt the agent is asked to confirm and wait, which is the second step of
 * the Telegram picker flow (button tap → load → user types the request).
 */
function handleSkillCommand(rawArgs: string): SlashCommandReply {
  const args = rawArgs.trim()
  const skills = listLoadableSkills()

  if (args.length === 0) {
    if (skills.length === 0) return 'No skills available to load.'
    return buildSkillPicker(skills)
  }

  const sepIdx = args.search(/\s/)
  const key = sepIdx === -1 ? args : args.slice(0, sepIdx)
  const prompt = sepIdx === -1 ? '' : args.slice(sepIdx + 1).trim()

  const skill = findLoadableSkill(skills, key)
  if (!skill) {
    return `Unknown skill: ${key}\n\n${formatSkillList(skills)}`
  }

  const loaded = readSkillMd(skill)
  if (!loaded) {
    return `Could not read SKILL.md for "${skill.name}".`
  }
  if (skill.kind === 'agent') trackAgentSkillUsage(skill.name)

  const block = wrapAttachedSkills([renderSkillBlock(skill.id, loaded.content)])
  const instruction = prompt.length > 0
    ? `The user loaded the skill "${skill.name}" via /skill. Follow its instructions for this request:\n\n${prompt}`
    : `The user loaded the skill "${skill.name}" via /skill but has not given a request yet. `
      + `Confirm in one short sentence that the skill is loaded and ask what they want to do. Do not act yet.`

  return {
    kind: 'agent_turn',
    text: `${block}\n\n${instruction}`,
    // Mirrors the real `read_file` tool's SKILL.md output so the chat UI
    // renders the same "Load Skill" row it shows for agent-initiated loads.
    toolCall: {
      toolName: 'read_file',
      toolArgs: { path: loaded.path },
      toolResult: {
        content: [{ type: 'text', text: `Skill directory: ${path.dirname(loaded.path)}\n\n${loaded.content}` }],
        details: { path: loaded.path, size: loaded.content.length, skillLoad: true, skillName: skill.id },
      },
    },
    label: `\uD83D\uDCDA Skill loaded: ${skill.name}`,
  }
}

function resolveSkillMdPath(skill: LoadableSkill): string | null {
  if (skill.kind === 'agent') return path.join(getAgentSkillsDir(), skill.id, 'SKILL.md')
  const installed = getSkill(skill.id)
  return installed?.path ? path.join(installed.path, 'SKILL.md') : null
}

function readSkillMd(skill: LoadableSkill): { path: string; content: string } | null {
  const skillPath = resolveSkillMdPath(skill)
  if (!skillPath) return null
  try {
    const raw = fs.readFileSync(skillPath, 'utf-8')
    return { path: skillPath, content: raw.replaceAll('{baseDir}', path.dirname(skillPath)) }
  } catch {
    return null
  }
}

function formatSkillList(skills: LoadableSkill[]): string {
  if (skills.length === 0) return 'No skills available to load.'
  const lines = ['Available skills:']
  for (const s of skills) {
    lines.push(`  \u2022 /skill:${s.id} \u2014 ${truncate(s.description, 80)}`)
  }
  return lines.join('\n')
}

function buildSkillPicker(skills: LoadableSkill[]): SlashCommandPicker {
  return {
    kind: 'picker',
    pickerId: 'skill:list',
    title: 'Choose a skill to load',
    description: 'Tip: type /skill:<name> <prompt> to load a skill and ask in one go.',
    options: skills.map((s) => ({
      command: `/skill:${s.id}`,
      label: s.name,
      description: truncate(s.description, 120),
      badge: s.kind === 'installed' ? 'installed' : undefined,
    })),
  }
}

function handleThinkingCommand(ctx: SlashCommandContext): string {
  const args = ctx.args.trim().toLowerCase()
  if (!args) {
    const current = readConfiguredThinkingLevel() ?? 'off'
    return `Current thinking level: ${current}\nUsage: /thinking ${SETTINGS_THINKING_LEVELS.join('|')}`
  }

  const [level, ...rest] = args.split(/\s+/)
  if (rest.length > 0 || !level) {
    return `Usage: /thinking ${SETTINGS_THINKING_LEVELS.join('|')}`
  }

  const normalized = normalizeThinkingLevel(level)
  if (!normalized) {
    return `Unknown thinking level: ${level}\nValid levels: ${SETTINGS_THINKING_LEVELS.join(', ')}`
  }

  writeConfiguredThinkingLevel(normalized)
  ctx.onThinkingLevelChanged?.(normalized)
  return `Thinking level set to: ${normalized}`
}

function readConfiguredThinkingLevel(): SettingsThinkingLevel | undefined {
  try {
    const settings = loadConfig<{ thinkingLevel?: string }>('settings.json')
    return normalizeThinkingLevel(settings.thinkingLevel)
  } catch {
    return undefined
  }
}

function writeConfiguredThinkingLevel(level: SettingsThinkingLevel): void {
  const settingsPath = path.join(getConfigDir(), 'settings.json')
  const settings = loadConfig<Record<string, unknown>>('settings.json')
  settings.thinkingLevel = level
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
}


interface TaskLike {
  id: string
  name: string
  status: string
  triggerType: string
  createdAt: string
  finishedAt?: string | null
}

export function formatTasksReply(running: TaskLike[], recent: TaskLike[]): string {
  const lines: string[] = []
  lines.push(`Running tasks: ${running.length}`)
  if (running.length > 0) {
    for (const t of running.slice(0, 10)) {
      lines.push(`  • ${truncate(t.name, 60)} (${t.triggerType}) — started ${t.createdAt}`)
    }
  }
  lines.push('')
  lines.push('Recent tasks (newest first):')
  if (recent.length === 0) {
    lines.push('  (none)')
  } else {
    for (const t of recent.slice(0, 5)) {
      const when = t.finishedAt ?? t.createdAt
      lines.push(`  • [${t.status}] ${truncate(t.name, 60)} — ${when}`)
    }
  }
  return lines.join('\n')
}

interface CronjobLike {
  id: string
  name: string
  cronExpression: string
  enabled: boolean
  nextRunAt?: string | null
  lastRunAt?: string | null
}

export function formatCronjobsReply(jobs: CronjobLike[]): string {
  if (jobs.length === 0) return 'No cronjobs configured.'
  const lines: string[] = [`Configured cronjobs: ${jobs.length}`]
  for (const j of jobs) {
    const state = j.enabled ? 'on ' : 'off'
    const next = j.nextRunAt ?? '—'
    lines.push(`  • [${state}] ${truncate(j.name, 50)} — ${j.cronExpression} (next: ${next})`)
  }
  return lines.join('\n')
}

/**
 * Multi-step `/model` command. Returns either a structured picker (interactive
 * surfaces render this as buttons / inline keyboards) or a plain text reply
 * (terminal confirmation, errors).
 *
 * - `/model`                     → picker with provider buttons
 * - `/model <provider>`          → picker with model buttons (+ "Back")
 * - `/model <provider> <model>`  → text confirmation after switching
 *
 * Provider/model identifiers are resolved case-insensitively against both
 * `id` and `name`, so picker callbacks can use ids while users typing the
 * command directly can use names.
 */
function handleModelCommand(rawArgs: string, ctx?: SlashCommandContext): SlashCommandReply {
  const args = rawArgs.trim()
  let file
  try {
    file = loadProviders()
  } catch (err) {
    return `Could not read provider settings: ${(err as Error).message}`
  }
  const providers = file.providers
  if (providers.length === 0) {
    return 'No providers are configured. Add one in the settings UI first.'
  }

  const tokens = args.length === 0 ? [] : args.split(/\s+/)

  // No args → provider picker
  if (tokens.length === 0) {
    return buildProviderPicker(providers, file.activeProvider, file.activeModel)
  }

  const providerKey = tokens[0]!
  const provider = findProvider(providers, providerKey)
  if (!provider) {
    return `Unknown provider: ${providerKey}\n\nUse /model to choose from the list.`
  }

  // 1 arg → model picker for the chosen provider
  if (tokens.length === 1) {
    return buildModelPicker(provider, file.activeProvider, file.activeModel)
  }

  // 2 args → switch active provider + model (terminal step)
  if (tokens.length === 2) {
    const modelKey = tokens[1]!
    const enabled = enabledModelIds(provider)
    const modelId = enabled.find((m) => m.toLowerCase() === modelKey.toLowerCase())
    if (!modelId) {
      return `Model "${modelKey}" is not enabled for provider "${provider.name}".`
    }
    try {
      setActiveProvider(provider.id, modelId)
    } catch (err) {
      return `Could not switch model: ${(err as Error).message}`
    }
    // Rebuild the agent core \u2014 without this the running agent keeps
    // streaming on the previously bound model despite the file change.
    ctx?.onActiveProviderChanged?.()
    return `\u2705 Active provider: ${provider.name} (${provider.providerType})\nActive model: ${modelId}`
  }

  return `Usage: /model [<provider> [<model>]]`
}

function findProvider(providers: ProviderConfig[], key: string): ProviderConfig | undefined {
  const k = key.toLowerCase()
  return providers.find((p) => p.id.toLowerCase() === k || p.name.toLowerCase() === k)
}

function enabledModelIds(provider: ProviderConfig): string[] {
  return provider.enabledModels ?? []
}

function buildProviderPicker(
  providers: ProviderConfig[],
  activeProviderId: string | undefined,
  activeModelId: string | undefined,
): SlashCommandPicker {
  const active = providers.find((p) => p.id === activeProviderId) ?? providers[0]!
  const activeModel = activeModelId ?? (getProviderDefaultModel(active) || '(none)')
  const options: SlashCommandPickerOption[] = providers.map((p) => {
    const isActive = p.id === activeProviderId
    return {
      // Use provider id (always set, never collides) for the callback
      command: `/model ${p.id}`,
      label: p.name,
      description: p.providerType,
      badge: isActive ? 'active' : (p.status === 'error' ? 'error' : undefined),
    }
  })
  return {
    kind: 'picker',
    pickerId: 'model:providers',
    title: 'Choose a provider',
    description: `Active: ${active.name} \u00b7 ${activeModel}`,
    options,
  }
}

function buildModelPicker(
  provider: ProviderConfig,
  activeProviderId: string | undefined,
  activeModelId: string | undefined,
): SlashCommandPicker {
  const enabled = enabledModelIds(provider)
  const isActiveProvider = provider.id === activeProviderId
  const options: SlashCommandPickerOption[] = enabled.map((m) => {
    const flags: string[] = []
    if (isActiveProvider && m === activeModelId) flags.push('active')
    if (m === getProviderDefaultModel(provider)) flags.push('default')
    const status = provider.modelStatuses?.[m]
    if (status && status !== 'untested') flags.push(status)
    const overrideName = provider.models?.find((mm) => mm.id === m)?.name
    return {
      command: `/model ${provider.id} ${m}`,
      label: overrideName ?? m,
      description: overrideName ? m : undefined,
      badge: flags[0],
    }
  })
  // Back button → re-show provider picker
  options.push({ command: '/model', label: '\u2190 Back to providers' })
  return {
    kind: 'picker',
    pickerId: `model:models:${provider.id}`,
    title: `Choose a model for ${provider.name}`,
    description: provider.providerType,
    options,
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function computeNextRunAt(schedule: string): string | null {
  try {
    const fields = parseCronExpression(schedule)
    const next = getNextRunTime(fields, new Date())
    if (!next) return null
    return next.toISOString().replace('T', ' ').slice(0, 16)
  } catch {
    return null
  }
}
