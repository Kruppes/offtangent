/**
 * Codemode (plan 2026-10-08-codemode): one extra tool, `codemode`, that runs
 * model-written JavaScript in the QuickJS/WASM sandbox of
 * `@earendil-works/pi-codemode`. The script calls allowlisted tools of the
 * current turn as `await tools.<name>(args)`; their results stay inside the
 * sandbox, only `text()` / `console.*` output and the return value come back.
 *
 * Off by default (`settings.json` -> `codemode.mode = "off"`). Off, or a model
 * outside `codemode.models`, means the tool is not registered at all.
 *
 * Guardrails:
 * - Nested calls run through pi-agent-core's `runToolCall` with the agent's own
 *   `beforeToolCall` / `afterToolCall` hooks and the SAME tool instances the
 *   model gets — i.e. the secret-boundary-wrapped ones.
 * - Nested call ids are `<parentId>/cm-<n>` so hooks can recognise them
 *   (`isNestedCodemodeCallId`): Eco does not freeze them, the task runner
 *   counts them against its tool-call guards.
 * - The codemode result itself is sealed (`sealToolText`) and spilled to a
 *   file when it exceeds `maxOutputChars`.
 * - Per-script cap on nested calls, a cap on nested calls in flight at once
 *   (queued calls honour abort and timeout), overall timeout, VM memory
 *   limit, abort signal propagation.
 * - Text output only: `image()` items are discarded with a note.
 */

import {
  runToolCall,
  type AfterToolCallContext,
  type AfterToolCallResult,
  type AgentMessage,
  type AgentTool,
  type AgentToolCallOutcome,
  type AgentToolResult,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import type { AssistantMessage, JsonObject, TextContent } from '@earendil-works/pi-ai'
import {
  CodemodeSandbox,
  renderDeclarations,
  type CodemodeJsonSchema,
  type CodemodeTool,
} from '@earendil-works/pi-codemode'
import { Type } from 'typebox'
import { loadConfig, warnConfigReadFailed } from './config.js'
import { sealToolText, withSecretBoundary } from './secret-boundary.js'
import { spillToolOutput } from './tool-output-spill.js'
import { isFailedToolResult } from './loop-detection.js'

export const CODEMODE_TOOL_NAME = 'codemode'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type CodemodeMode = 'off' | 'readonly' | 'coding'

export interface CodemodeSettings {
  mode: CodemodeMode
  /** Model-id prefixes the tool is offered to (e.g. `claude-`). */
  models: string[]
  timeoutMs: number
  memoryLimitBytes: number
  /** Nested tool calls per script. */
  maxNestedCalls: number
  /**
   * Nested tool calls running at the same time (per codemode tool instance,
   * i.e. per turn / task, across concurrent scripts). Further calls queue.
   */
  maxConcurrentNestedCalls: number
  /** Characters of script output shown inline; the rest is spilled to a file. */
  maxOutputChars: number
}

export const DEFAULT_CODEMODE_SETTINGS: Readonly<CodemodeSettings> = Object.freeze({
  mode: 'off',
  models: ['claude-', 'gpt-'],
  timeoutMs: 120_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxNestedCalls: 50,
  maxConcurrentNestedCalls: 4,
  maxOutputChars: 20_000,
})

/**
 * Inclusive bounds per numeric field. A value outside its bounds is reported;
 * with an enabled mode it switches the whole codemode off (fail closed).
 */
export const CODEMODE_SETTING_BOUNDS = Object.freeze({
  timeoutMs: [1_000, 600_000],
  memoryLimitBytes: [1024 * 1024, 1024 * 1024 * 1024],
  maxNestedCalls: [1, 200],
  maxConcurrentNestedCalls: [1, 16],
  maxOutputChars: [1_000, 1_000_000],
} as const)

const CODEMODE_MODES: readonly CodemodeMode[] = ['off', 'readonly', 'coding']

/**
 * Validate a raw `codemode` object from settings.json. Every invalid field is
 * reported in `problems` and falls back to its default. Fail closed: when the
 * object has ANY problem, the mode is forced to `off` (a final problem entry
 * says so when a valid non-off mode was requested), so neither a typo in
 * `mode` nor a broken guardrail (e.g. `maxNestedCalls: "1"`) can leave
 * codemode running with limits other than the ones configured.
 */
export function resolveCodemodeSettings(raw: unknown): { settings: CodemodeSettings; problems: string[] } {
  const problems: string[] = []
  const settings: CodemodeSettings = { ...DEFAULT_CODEMODE_SETTINGS, models: [...DEFAULT_CODEMODE_SETTINGS.models] }
  if (raw === undefined || raw === null) return { settings, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push('codemode must be an object')
    return { settings, problems }
  }
  const input = raw as Record<string, unknown>
  if (input.mode !== undefined) {
    if (typeof input.mode === 'string' && (CODEMODE_MODES as readonly string[]).includes(input.mode)) {
      settings.mode = input.mode as CodemodeMode
    } else {
      problems.push(`codemode.mode must be one of ${CODEMODE_MODES.join(', ')}`)
    }
  }
  if (input.models !== undefined) {
    if (Array.isArray(input.models) && input.models.every(m => typeof m === 'string' && m.trim().length > 0)) {
      settings.models = (input.models as string[]).map(m => m.trim())
    } else {
      problems.push('codemode.models must be an array of non-empty strings')
    }
  }
  for (const key of Object.keys(CODEMODE_SETTING_BOUNDS) as (keyof typeof CODEMODE_SETTING_BOUNDS)[]) {
    const value = input[key]
    if (value === undefined) continue
    const [min, max] = CODEMODE_SETTING_BOUNDS[key]
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) {
      settings[key] = value
    } else {
      problems.push(`codemode.${key} must be an integer between ${min} and ${max}`)
    }
  }
  if (problems.length > 0 && settings.mode !== 'off') {
    problems.push(`codemode switched off: mode "${settings.mode}" is ignored while any codemode setting is invalid`)
    settings.mode = 'off'
  }
  return { settings, problems }
}

let lastReportedProblems = ''

/**
 * Read `codemode` from settings.json on every call (no restart needed). Fails
 * closed to off on an unreadable file and on any invalid codemode field.
 */
export function loadCodemodeSettings(): CodemodeSettings {
  let raw: unknown
  try {
    raw = loadConfig<{ codemode?: unknown }>('settings.json').codemode
  } catch (err) {
    warnConfigReadFailed('settings.json', err)
    return resolveCodemodeSettings(undefined).settings
  }
  const { settings, problems } = resolveCodemodeSettings(raw)
  const report = problems.join('; ')
  if (report && report !== lastReportedProblems) {
    console.warn(`[codemode] invalid settings, codemode is off until they are fixed: ${report}`)
  }
  lastReportedProblems = report
  return settings
}

/** True when `mode` is not off and `modelId` starts with an allowlisted prefix. */
export function isCodemodeEnabledFor(settings: CodemodeSettings, modelId: string | undefined): boolean {
  if (settings.mode === 'off' || !modelId) return false
  return settings.models.some(prefix => modelId.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// Allowlists (fixed in code on purpose — not configurable)
// ---------------------------------------------------------------------------

/** Read-only tools a script may call in mode `readonly` (and `coding`). */
export const CODEMODE_READONLY_TOOLS: readonly string[] = Object.freeze([
  'read_file',
  'list_files',
  'web_search',
  'web_fetch',
  'search_memories',
  'read_chat_history',
  'recall_message',
  'list_tasks',
  'get_task',
  'list_cronjobs',
  'get_cronjob',
  'list_agent_skills',
  'email_list',
  'email_folders',
])

/** Added in mode `coding`. Same rights as the direct tools. */
export const CODEMODE_CODING_EXTRA_TOOLS: readonly string[] = Object.freeze([
  'write_file',
  'edit_file',
  'shell',
])

/**
 * Never callable from a script: anything with external effect, cost or
 * people in the loop. Allowlists are positive lists, so this list is a
 * second, explicit net (asserted disjoint in tests and enforced at build time).
 */
export const CODEMODE_NEVER_TOOLS: readonly string[] = Object.freeze([
  CODEMODE_TOOL_NAME,
  'email_send',
  'email_read', // marks messages as read
  'email_mark_read',
  'email_mark_unread',
  'email_delete',
  'email_move',
  'email_download_attachment',
  'create_task',
  'create_cronjob',
  'create_reminder',
  'edit_cronjob',
  'remove_cronjob',
  'publish_board',
  'send_file_to_user',
  'canvas_write',
  'generate',
  'ask_agent',
  'ask_connector',
  'resume_task',
  'steer_task',
  'cancel_task',
  'fork_strand',
  'send_voice_message',
  'transcribe_audio',
  'provider_quota',
])

export function codemodeAllowedToolNames(mode: CodemodeMode): ReadonlySet<string> {
  if (mode === 'off') return new Set()
  const names = mode === 'coding'
    ? [...CODEMODE_READONLY_TOOLS, ...CODEMODE_CODING_EXTRA_TOOLS]
    : [...CODEMODE_READONLY_TOOLS]
  return new Set(names.filter(name => !CODEMODE_NEVER_TOOLS.includes(name)))
}

/** The active tools of a turn a script may call, sorted by name (deterministic). */
export function selectCodemodeTools(activeTools: readonly AgentTool[], mode: CodemodeMode): AgentTool[] {
  const allowed = codemodeAllowedToolNames(mode)
  const seen = new Set<string>()
  const selected: AgentTool[] = []
  for (const tool of activeTools) {
    if (!allowed.has(tool.name) || seen.has(tool.name)) continue
    seen.add(tool.name)
    selected.push(tool)
  }
  return selected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ---------------------------------------------------------------------------
// Nested call ids + runner
// ---------------------------------------------------------------------------

const NESTED_ID_RE = /\/cm-\d+$/

export function nestedCodemodeCallId(parentId: string, n: number): string {
  return `${parentId}/cm-${n}`
}

/** True for a tool call that a codemode script issued (not the model). */
export function isNestedCodemodeCallId(id: string | undefined): boolean {
  return typeof id === 'string' && NESTED_ID_RE.test(id)
}

/** Runs one nested call through the agent's pipeline. */
export type CodemodeNestedRunner = (
  callId: string,
  name: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<AgentToolCallOutcome>

/** The parts of a pi `Agent` the nested runner needs. */
export interface CodemodeAgentLike {
  readonly state: { readonly messages: readonly AgentMessage[] }
  beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>
  afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>
}

function syntheticAssistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'unknown',
    provider: 'unknown',
    model: 'unknown',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  } as unknown as AssistantMessage
}

/**
 * Nested runner after the upstream example (`createNestedToolRunner`): the
 * call resolves against `tools` (the allowlisted, boundary-wrapped instances)
 * and passes the agent's hooks, so permission checks, Eco and guards see it.
 */
export function createCodemodeNestedRunner(
  getAgent: () => CodemodeAgentLike,
  tools: readonly AgentTool[],
): CodemodeNestedRunner {
  return (callId, name, args, signal) => {
    const agent = getAgent()
    const messages = [...agent.state.messages]
    let assistant: AgentMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        assistant = messages[i]
        break
      }
    }
    const assistantMessage = (assistant as AssistantMessage | undefined) ?? syntheticAssistantMessage()
    const toolList = [...tools]
    return runToolCall(
      { type: 'toolCall', id: callId, name, arguments: (args ?? {}) as JsonObject },
      {
        tools: toolList,
        assistantMessage,
        context: { messages, tools: toolList },
        beforeToolCall: agent.beforeToolCall,
        afterToolCall: agent.afterToolCall,
        signal,
      },
    )
  }
}

// ---------------------------------------------------------------------------
// Concurrency limit for nested calls
// ---------------------------------------------------------------------------

export interface CodemodeConcurrencyLimiter {
  /**
   * Wait for a free slot. Resolves with a release function (idempotent).
   * Rejects without taking a slot when any of `signals` is or becomes aborted
   * while waiting; the waiter is then removed from the queue.
   */
  acquire(signals: readonly (AbortSignal | undefined)[]): Promise<() => void>
  /** Calls currently holding a slot. */
  readonly active: number
  /** Calls waiting for a slot. */
  readonly queued: number
}

class CodemodeCallCancelledError extends Error {
  constructor() {
    super('codemode: tool call cancelled before it started (script aborted or timed out)')
    this.name = 'AbortError'
  }
}

/** FIFO semaphore; `limit` slots. */
export function createCodemodeConcurrencyLimiter(limit: number): CodemodeConcurrencyLimiter {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`codemode: invalid concurrency limit ${limit}`)
  let active = 0
  const waiters: Array<() => void> = []

  const makeRelease = (): (() => void) => {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = waiters.shift()
      if (next) next() // hand the slot over; `active` stays the same
      else active--
    }
  }

  return {
    get active() { return active },
    get queued() { return waiters.length },
    acquire(signals) {
      const live = signals.filter((sig): sig is AbortSignal => sig !== undefined)
      if (live.some(sig => sig.aborted)) return Promise.reject(new CodemodeCallCancelledError())
      if (active < limit && waiters.length === 0) {
        active++
        return Promise.resolve(makeRelease())
      }
      return new Promise<() => void>((resolve, reject) => {
        const cleanup = () => { for (const sig of live) sig.removeEventListener('abort', onAbort) }
        const grant = () => {
          cleanup()
          resolve(makeRelease())
        }
        function onAbort() {
          const index = waiters.indexOf(grant)
          if (index >= 0) waiters.splice(index, 1)
          cleanup()
          reject(new CodemodeCallCancelledError())
        }
        for (const sig of live) sig.addEventListener('abort', onAbort, { once: true })
        waiters.push(grant)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const CODEMODE_MAX_LOG_ENTRIES = 100
export const CODEMODE_MAX_LOGGED_ARGS_CHARS = 2048
const CODEMODE_MAX_LOGGED_ERROR_CHARS = 500

export interface CodemodeCallLogEntry {
  name: string
  /** JSON of the arguments, sealed, cut at 2 KB. */
  args: string
  ok: boolean
  durationMs: number
  error?: string
}

export interface CodemodeDetails {
  calls: CodemodeCallLogEntry[]
  /** False when more calls ran than the log keeps. */
  complete: boolean
  ok: boolean
  durationMs: number
  errorKind?: string
  /** Absolute path of the spilled full output, when cut. */
  spilledTo?: string
  /** Number of `image()` outputs that were discarded (codemode returns text only). */
  discardedImages?: number
}

/** Note appended to the result when a script produced `image()` output. */
export const CODEMODE_IMAGE_DISCARDED_NOTE = 'image output is not supported in codemode and was discarded'

const codemodeParameters = Type.Object({
  code: Type.String({ description: 'JavaScript source: the body of an async function. Top-level await and return work.' }),
})

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[${text.length - max} more chars]`
}

function textOf(result: AgentToolResult<unknown>): string {
  return (result.content ?? [])
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return String(value)
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

/** `codemode: 7 calls (read_file×5, shell×2), 1.2 s` */
export function formatCodemodeSummary(calls: readonly { name: string }[], totalCalls: number, durationMs: number, failure?: string): string {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1)
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => `${name}×${count}`)
  const callText = `${totalCalls} call${totalCalls === 1 ? '' : 's'}${parts.length ? ` (${parts.join(', ')})` : ''}`
  return `codemode: ${callText}, ${formatSeconds(durationMs)}${failure ? `, failed: ${failure}` : ''}`
}

function buildDescription(sandboxTools: readonly CodemodeTool[], settings: CodemodeSettings): string {
  return [
    'Run JavaScript that calls other tools, to chain calls, run them in parallel (Promise.all), or filter large results.',
    'The code is the body of an async function. There is no Node, file system, network, or timers.',
    'Call tools as `await tools.<name>(args)`; each resolves to the tool\'s text result and throws on a tool error.',
    'Output with `text(value)` or `console.log()`, or `return` a value.',
    'Only the output and the return value reach you, not the results of the tool calls.',
    `Limits per script: ${settings.maxNestedCalls} tool calls, ${Math.round(settings.timeoutMs / 1000)} s; at most ${settings.maxConcurrentNestedCalls} tool calls run at once, further calls wait.`,
    'Output is text only; `image()` output is discarded.',
    '',
    '```ts',
    renderDeclarations({ tools: sandboxTools }),
    '```',
  ].join('\n')
}

export interface CreateCodemodeToolOptions {
  /** Active tools of the turn (already secret-boundary-wrapped). Filtered by the allowlist here. */
  tools: readonly AgentTool[]
  settings: CodemodeSettings
  /** Builds the runner over the allowlisted tools. */
  createRunner: (allowedTools: readonly AgentTool[]) => CodemodeNestedRunner
}

/**
 * Build the codemode tool, or null when the mode is off or no allowlisted
 * tool is active. The returned tool is NOT yet boundary-wrapped; use
 * `buildCodemodeTool` for the wrapped production variant.
 */
export function createCodemodeTool(options: CreateCodemodeToolOptions): AgentTool<typeof codemodeParameters, { codemode: CodemodeDetails }> | null {
  const { settings } = options
  if (settings.mode === 'off') return null
  const callable = selectCodemodeTools(options.tools, settings.mode)
  if (callable.length === 0) return null
  const runNested = options.createRunner(callable)
  // One limiter per tool instance: bounds nested calls in flight across all
  // scripts of this turn / task, not only within one script.
  const limiter = createCodemodeConcurrencyLimiter(settings.maxConcurrentNestedCalls)

  // The schemas only render the declarations; the per-execution `execute`
  // closures are built in `execute` below so every script has its own log.
  const declarationTools: CodemodeTool[] = callable.map(tool => ({
    name: tool.name,
    description: tool.description,
    // TypeBox schemas are JSON Schema. A tool without a schema still gets a
    // valid declaration instead of breaking the whole codemode description.
    inputSchema: (tool.parameters ?? { type: 'object' }) as CodemodeJsonSchema,
    outputSchema: { type: 'string' },
    execute: () => undefined,
  }))
  const description = buildDescription(declarationTools, settings)

  return {
    name: CODEMODE_TOOL_NAME,
    label: 'Codemode',
    description,
    parameters: codemodeParameters,
    execute: async (toolCallId, params, signal) => {
      const startedAt = Date.now()
      const log: (CodemodeCallLogEntry & { pending?: boolean })[] = []
      const counted: { name: string }[] = []
      let issued = 0

      const sandboxTools: CodemodeTool[] = declarationTools.map(decl => ({
        ...decl,
        execute: async (args, context) => {
          if (issued >= settings.maxNestedCalls) {
            issued++
            throw new Error(`codemode: limit of ${settings.maxNestedCalls} tool calls per script reached`)
          }
          issued++
          const callId = nestedCodemodeCallId(toolCallId, issued)
          counted.push({ name: decl.name })
          const entry: CodemodeCallLogEntry & { pending?: boolean } = {
            name: decl.name,
            args: cut(sealToolText(safeJson(args), CODEMODE_TOOL_NAME), CODEMODE_MAX_LOGGED_ARGS_CHARS),
            ok: false,
            durationMs: 0,
            pending: true,
          }
          if (log.length < CODEMODE_MAX_LOG_ENTRIES) log.push(entry)
          let t0 = Date.now()
          let release: (() => void) | undefined
          try {
            // Queue for a slot. Waiting calls reject when the script ends,
            // times out or is aborted (context.signal) or the turn is
            // aborted (signal); a call never starts after an abort.
            release = await limiter.acquire([context.signal, signal])
            if (context.signal.aborted || signal?.aborted) throw new CodemodeCallCancelledError()
            t0 = Date.now()
            const outcome = await runNested(callId, decl.name, args, context.signal)
            const text = textOf(outcome.result)
            entry.durationMs = Date.now() - t0
            entry.pending = false
            const failed = isFailedToolResult(outcome.isError, outcome.result)
            entry.ok = !failed
            if (failed) {
              const message = text || `Tool ${decl.name} failed`
              entry.error = cut(sealToolText(message, CODEMODE_TOOL_NAME), CODEMODE_MAX_LOGGED_ERROR_CHARS)
              throw new Error(message)
            }
            return text
          } catch (err) {
            if (entry.pending) {
              entry.durationMs = Date.now() - t0
              entry.pending = false
              entry.ok = false
              entry.error = cut(sealToolText(err instanceof Error ? err.message : String(err), CODEMODE_TOOL_NAME), CODEMODE_MAX_LOGGED_ERROR_CHARS)
            }
            throw err
          } finally {
            release?.()
          }
        },
      }))

      const sandbox = new CodemodeSandbox({
        tools: sandboxTools,
        timeoutMs: settings.timeoutMs,
        memoryLimitBytes: settings.memoryLimitBytes,
      })
      try {
        const result = await sandbox.execute(params.code, { signal })
        const durationMs = Date.now() - startedAt

        // Text only: image items would bypass the inline cap, the spill and
        // the text sealing, and no allowlisted tool needs image output. The
        // sandbox's built-in `image()` cannot be disabled, so its items are
        // dropped here and replaced by a note.
        const texts: string[] = []
        let discardedImages = 0
        for (const item of result.output) {
          if (item.type === 'text') texts.push(item.text)
          else discardedImages++
        }
        if (discardedImages > 0) {
          texts.push(`[${CODEMODE_IMAGE_DISCARDED_NOTE} (${discardedImages} item${discardedImages === 1 ? '' : 's'})]`)
        }
        if (result.ok && result.value !== undefined) {
          texts.push(typeof result.value === 'string' ? result.value : safeJson(result.value))
        }
        if (!result.ok) {
          texts.push(`Script failed (${result.error.kind}): ${result.error.stack ?? result.error.message}`)
        }

        // Seal first, then cut: the spill file and the inline head never
        // carry plaintext.
        let body = sealToolText(texts.join('\n'), CODEMODE_TOOL_NAME)
        let spilledTo: string | undefined
        const spilled = spillToolOutput(body, { maxChars: settings.maxOutputChars, label: CODEMODE_TOOL_NAME })
        if (spilled) {
          body = spilled.text
          spilledTo = spilled.path
        } else if (body.length > settings.maxOutputChars) {
          // Spill file could not be written: cut hard rather than flood the context.
          body = cut(body, settings.maxOutputChars)
        }

        for (const entry of log) {
          if (entry.pending) {
            entry.pending = false
            entry.ok = false
            entry.error = 'cancelled'
          }
          delete entry.pending
        }

        const summary = formatCodemodeSummary(counted, issued, durationMs, result.ok ? undefined : result.error.kind)
        const content: TextContent[] = [
          { type: 'text', text: body ? `${summary}\n\n${body}` : summary },
        ]
        const details: CodemodeDetails = {
          calls: log,
          complete: issued <= CODEMODE_MAX_LOG_ENTRIES,
          ok: result.ok,
          durationMs,
          ...(result.ok ? {} : { errorKind: result.error.kind }),
          ...(spilledTo ? { spilledTo } : {}),
          ...(discardedImages > 0 ? { discardedImages } : {}),
        }
        return { content, details: { codemode: details }, isError: !result.ok }
      } finally {
        await sandbox.close()
      }
    },
  }
}

export interface BuildCodemodeToolOptions {
  /** Active tools of the turn, already boundary-wrapped. */
  tools: readonly AgentTool[]
  settings: CodemodeSettings
  modelId: string | undefined
  getAgent: () => CodemodeAgentLike
}

/**
 * Production entry: the codemode tool for this turn (boundary-wrapped), or
 * null when codemode is off for this model / turn. Callers append it to the
 * tool list; null means "register nothing" (zero behaviour change).
 */
export function buildCodemodeTool(options: BuildCodemodeToolOptions): AgentTool | null {
  if (!isCodemodeEnabledFor(options.settings, options.modelId)) return null
  const active = options.tools.filter(tool => tool.name !== CODEMODE_TOOL_NAME)
  const tool = createCodemodeTool({
    tools: active,
    settings: options.settings,
    createRunner: allowed => createCodemodeNestedRunner(options.getAgent, allowed),
  })
  return tool ? withSecretBoundary([tool as AgentTool])[0] : null
}

/** `tools` plus the codemode tool when enabled; otherwise `tools` unchanged (same array). */
export function withCodemodeTool(
  tools: AgentTool[],
  settings: CodemodeSettings,
  modelId: string | undefined,
  getAgent: () => CodemodeAgentLike,
): AgentTool[] {
  const base = tools.filter(tool => tool.name !== CODEMODE_TOOL_NAME)
  const codemode = buildCodemodeTool({ tools: base, settings, modelId, getAgent })
  if (!codemode) return base.length === tools.length ? tools : base
  return [...base, codemode]
}
