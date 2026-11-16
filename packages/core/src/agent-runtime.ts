import { guardScopedWrites } from './scoped-write-guard.js'
import { getCurrentTaskExecutionContext } from './task-execution-context.js'
import { recordContextManifest } from './context-provenance.js'
import { readStrandWorkingMode, strandWorkingModePrompt } from './strand-working-mode.js'
import { spawn } from 'node:child_process'
import { readStrandContextWindow, readStrandEcoMode } from './eco-mode-store.js'
import { resolveTurnEcoOwner, freezeEcoToolResult } from './eco-tool-freeze.js'
import { ASK_USER_TOOL_NAME, redactAskUserArgs } from './contracts/ask-user.js'
import { SteerSlot, type SteerOffer, type SteerOfferOptions } from './steer.js'
import { ASK_USER_SYSTEM_HINT, batchHasBlockingAskUser, claimInteractionContextNotes, createAskUserTool, isAskUserOfferedFor, markInteractionContextNotesDelivered, releaseInteractionContextNotes } from './ask-user-tool.js'
import type { AfterToolCallContext, AfterToolCallResult } from '@earendil-works/pi-agent-core'
import fs from 'node:fs'
import nodePath from 'node:path'
import { Agent as PiAgent } from '@earendil-works/pi-agent-core'
import type { AgentEvent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Message, ImageContent, Model, SystemMessage } from '@earendil-works/pi-ai'
import { Type } from 'typebox'
import type { Database } from './database.js'
import { logTokenUsage, logToolCall } from './token-logger.js'
import { errorClass, errorTextClass, formatProviderErrorDiagnostic, providerErrorDiagnostic, publicProviderError, withRawError } from './log-safe-error.js'
import { estimateCost, getApiKeyForProvider, buildModel, buildStreamFn, loadProvidersDecrypted, parseProviderModelId, getProviderDefaultModel, resolvePromptProfileOptions } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import type { ProviderManager } from './provider-manager.js'
import { createStreamActivityNotifier } from './provider-phase.js'
import type { SettingsThinkingLevel } from './contracts/settings.js'
import { normalizeThinkingLevel } from './thinking-level.js'
import { resolveContextScope, type ContextScope } from './context-scope.js'
import { assembleSystemPrompt, ensureMemoryStructure, ensureConfigStructure, formatCurrentTimeContext } from './memory.js'
import type { SkillPromptEntry, AvailableProviderModelPromptEntry, RuntimeInstanceIdentity } from './memory.js'
import { loadMultiPersonaSettings } from './config.js'
import { createAskAgentTool, buildAskAgentPromptHint } from './ask-agent-tool.js'
import { getWorkspaceDir } from './workspace.js'
import { loadConfig, ensureConfigTemplates } from './config.js'
import { loadSkills, getSkillDecrypted } from './skill-config.js'
import { createBuiltinWebTools } from './web-tools.js'
import type { BuiltinToolsConfig, BuiltinToolsConfigSource } from './web-tools.js'
import { createTranscribeAudioTool } from './stt-tool.js'
import { loadSttSettings } from './stt.js'
import { createAgentSkillTools, listScopedAgentSkills, scopedAgentSkillsDir, filterAndAnnotateAgentSkills, trackAgentSkillUsage, currentPlatform } from './agent-skills.js'
import { createSearchMemoriesTool } from './memories-tool.js'
import { createReadChatHistoryTool } from './chat-history-tools.js'
import { createRecallMessageTool } from './recall-message-tool.js'
import { cacheReadRatio } from './cache-stats.js'
import { sanitizeHistoryBoundaries, describeHistoryStructure, openWindowOnUser } from './message-history.js'
import { createEmailTools } from './email-tools.js'
import { createAskConnectorTool } from './connectors/ask-connector-tool.js'
import { createProviderQuotaTool } from './quota-tool.js'
import { withSecretBoundary, redactMessages, sealSystemText, sealToolText } from './secret-boundary.js'
import { commandInvokesVaultCli } from './secret-vault-cli.js'
import { spillToolOutput } from './tool-output-spill.js'
import { isNestedCodemodeCallId, loadCodemodeSettings, withCodemodeTool } from './codemode-tool.js'
import { getSharedMcpManager, mcpToolDataClass, withholdLocalOnlyMcpOutput } from './mcp-client.js'
import { findPrivateMcpEvidence, isPrivateMcpSession, isToolAllowedInPrivateMcpScope, markPrivateMcpSession, MCP_PRIVATE_CONTEXT_ERROR, MCP_PRIVATE_TOOL_BLOCKED, McpPrivateContextError, runInMcpPrivacyTurn, currentMcpPrivacyTurn } from './mcp-egress.js'
import { isStrictlyLocalModel } from './data-policy.js'
import { SHELL_EMPTY_OUTPUT_TEXT, SHELL_FAILED_OUTPUT_TEXT } from './secret-index-filter.js'
import { createSealingScope, finishSealingScope, runInSealingScope } from './secret-sealing-stats.js'
import type { QuotaServiceLike } from './quota-tool.js'
import type { AbortScope, AgentRuntimeStateSnapshot, ResponseChunk } from './agent-runtime-types.js'
import { loadHeuristics } from './heuristics.js'
import {
  capHeadTail,
  describeUnreadableFile,
  detectBinaryContent,
  guessMimeType,
  sliceFileForPrompt,
  READ_FILE_MAX_BYTES,
} from './tool-output-limits.js'

/** Fixed notices of the runtime itself; safe to show as they are. */
const CORRUPTED_CONTEXT_NOTICE = '⚠️ Der Gesprächskontext war beschädigt und wurde automatisch zurückgesetzt. Bitte sende deine letzte Nachricht noch einmal.'
const PREVIOUS_RUN_BUSY_NOTICE = '⚠️ Es läuft noch eine vorherige, länger dauernde Anfrage. Bitte warte, bis sie fertig ist, und sende die Nachricht dann erneut.'

/**
 * Options for the shared base agent tool factory.
 * Both the interactive AgentCore and background task agents use this to
 * build the common tool set — keeping the two paths in sync automatically.
 */
export interface BaseAgentToolsOptions {
  db: Database
  /**
   * MCP egress gate (review 2 / B): true only while the calling turn runs on a
   * strictly local model. History tools withhold rows of strands with private
   * MCP material otherwise. Absent (background tasks) = not allowed.
   */
  allowPrivateMcp?: () => boolean
  builtinToolsConfig?: BuiltinToolsConfigSource
  sttEnabled?: boolean
  /** Called by search_memories to scope results to the current user. */
  getCurrentUserId?: () => number | undefined
  /**
   * Called by read_chat_history / search_memories to scope results to the
   * calling persona. Non-'main' personas only see their own data; 'main'
   * and callers that omit this stay unscoped (orchestrator behavior).
   */
  getCurrentAgentId?: () => string | undefined
  /**
   * Session of the calling turn (interactive runtime). recall_message resolves
   * the caller's trusted owner from it before handing out a raw Eco original.
   * Background task tools omit it and use the per-task execution context.
   */
  getCurrentSessionId?: () => string | undefined
  memoryRoot?: string
  quotaService?: QuotaServiceLike
}

/**
 * Build the base tool set shared by the interactive agent and all background
 * task agents (heartbeat, cronjob, user-spawned tasks).
 *
 * Callers add their exclusive tools on top:
 * - Interactive agent: create_task, resume_task, list_tasks, cronjob tools
 * - Background tasks: create_task, resume_task, list_tasks
 */
export function createBaseAgentTools(options: BaseAgentToolsOptions): AgentTool[] {
  const getScope = () => {
    const task = getCurrentTaskExecutionContext()
    const scope = resolveContextScope(options.db, task ? task.taskSessionId ?? undefined : options.getCurrentSessionId?.(), task ? task.agentId ?? undefined : options.getCurrentAgentId?.())
    const userId = task ? task.userId : options.getCurrentUserId?.()
    return userId !== undefined && scope?.userId !== userId ? null : scope
  }
  return [
    ...guardScopedWrites(createYoloTools(), getScope, options.memoryRoot),
    ...createBuiltinWebTools(options.builtinToolsConfig),
    createReadChatHistoryTool({ db: options.db, getCurrentAgentId: options.getCurrentAgentId, allowPrivateMcp: options.allowPrivateMcp }),
    createRecallMessageTool({
      db: options.db,
      getCurrentAgentId: options.getCurrentAgentId,
      getCurrentUserId: options.getCurrentUserId,
      getCurrentSessionId: options.getCurrentSessionId,
      allowPrivateMcp: options.allowPrivateMcp,
    }),
    createSearchMemoriesTool({
      db: options.db,
      getCurrentSessionId: options.getCurrentSessionId,
      getCurrentUserId: options.getCurrentUserId,
      getCurrentAgentId: options.getCurrentAgentId,
    }),
    ...createAgentSkillTools(getScope),
    ...createEmailTools(),
    // The ONE door to private connector data: asks a strictly local sub-agent
    // and returns its summary. The raw connector tools are never registered
    // here (plan 2026-09-26, P2).
    createAskConnectorTool(),
    ...(options.sttEnabled ? [createTranscribeAudioTool()] : []),
    ...(options.quotaService
      ? [createProviderQuotaTool({
          quotaService: options.quotaService,
          isAuthorized: () => isQuotaVisibleToUser(options.db, options.getCurrentUserId?.()),
        })]
      : []),
  ]
}

/**
 * Provider quota is admin-only on the HTTP API, so the tool must not widen that
 * boundary. Background agents (heartbeat, cronjobs, tasks) run without an
 * interactive user and stay allowed.
 */
function isQuotaVisibleToUser(db: Database, userId: number | undefined): boolean {
  if (userId === undefined) return true
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined
  return row?.role === 'admin'
}

export interface AgentRuntimeOptions {
  model: Model<Api>
  apiKey: string
  db: Database
  systemPrompt?: string
  tools?: AgentTool[]
  memoryDir?: string
  baseInstructions?: string
  providerConfig?: ProviderConfig
  providerManager?: ProviderManager
  getCurrentToolUserId?: () => number | undefined
  quotaService?: QuotaServiceLike
  /**
   * Reasoning / thinking level applied to every LLM turn. Defaults to the value
   * stored in `settings.json` (`thinkingLevel`), or `off` if not configured.
   */
  thinkingLevel?: SettingsThinkingLevel
  /**
   * Agent ID for multi-persona support. Determines which persona files to load
   * and which agent identity to use for cross-persona tools like ask_agent.
   * Defaults to 'main'.
   */
  agentId?: string
}

export interface AgentRuntimeBoundary {
  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk>
  /**
   * Re-run the last assistant turn after it failed. The trailing failed
   * assistant message is dropped and the turn continues from the existing
   * transcript, so the user message is never sent (and billed) twice. Falls
   * back to a normal prompt when the transcript has no continuable tail.
   */
  retryLastTurn(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk>
  // Fork: persona-aware system prompt refresh (agentId selects the persona's
  // instructions). Kept over upstream's 2-arg version.
  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string, sessionId?: string): void
  getCurrentTimeContext(): string
  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void
  getProviderManager(): ProviderManager | undefined
  /** Replace the ProviderManager (hot provider switch keeps fallback machinery intact). */
  setProviderManager(manager: ProviderManager | undefined): void
  clearMessages(): void
  /**
   * Read the runtime's current model transcript. Used by AgentCore to park a
   * thread's context before switching to another one (Offtangent Stufe 1).
   * Optional so lightweight test doubles of this boundary stay valid — a
   * runtime without it simply keeps the single-transcript behaviour.
   */
  getMessages?(): AgentMessage[]
  /** Replace the runtime's model transcript (counterpart of getMessages). */
  setMessages?(messages: AgentMessage[]): void
  /**
   * Cancel the live pi-agent run. With a `scope.sessionId` the abort only
   * lands if this runtime is currently running exactly that session — a
   * watchdog of one strand must never kill the run of another one
   * (incident 2026-09-15). No scope = abort whatever runs here.
   */
  abort(scope?: AbortScope): void
  getStateSnapshot(): AgentRuntimeStateSnapshot
  /**
   * The session whose run currently owns this runtime, or null when idle.
   * A per-strand model swap must never land while a FOREIGN session's run is
   * still live: `swapProvider` replaces `agent.state.model` in place, so the
   * running turn would finish its tool loop on someone else's model. The
   * global message queue normally prevents this, but its 30-minute watchdog
   * can release the slot while the old provider call is still alive.
   * Optional so lightweight test doubles of this boundary stay valid.
   */
  getRunningSessionId?(): string | null
  /**
   * S1-D: hand a user interjection to the run of `sessionId`, delivered after
   * the current tool batch (see `steer.ts`). Optional so lightweight test
   * doubles of this boundary stay valid; absent = steering unsupported.
   */
  offerSteer?(sessionId: string, text: string, messageId?: number | null, opts?: SteerOfferOptions): SteerOffer
  getCurrentModel(): Model<Api>
  getCurrentApiKey(): string
  /** The current provider config, if the runtime was initialized with one. */
  getCurrentProvider(): ProviderConfig | null
  /** Update the thinking level used for future turns. */
  setThinkingLevel(level: SettingsThinkingLevel | string): void
  /**
   * The level `setThinkingLevel` would replace. A turn-local override (quick
   * capture mode) needs it to put the persona's own level back afterwards.
   * Optional so lightweight test doubles of this boundary stay valid.
   */
  getThinkingLevel?(): SettingsThinkingLevel
}

/**
 * Escape hatch for legacy integrations that still need direct pi-agent access.
 * Not part of AgentRuntimeBoundary to keep the abstraction clean.
 */
export interface AgentRuntimePiAgentAccess {
  getAgent(): PiAgent
}

/**
 * Resolve a path relative to WORKSPACE_DIR (consistent across all tools)
 */
function resolveWorkspacePath(filePath: string): string {
  if (nodePath.isAbsolute(filePath)) return filePath
  return nodePath.resolve(getWorkspaceDir(), filePath)
}

const SHELL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024

/**
 * Inactivity guard for a running turn: if neither the model stream nor a tool
 * produces any agent event for this long, the turn is considered stuck (e.g.
 * a completion promise on a dead connection that never settles — incident
 * 2026-07-19) and gets aborted. This is the PRIMARY hang guard (a real hang
 * shows as silence); it must comfortably exceed the longest silent window a
 * legitimate turn can have. Generous on purpose: autonomous agents (e.g. Kimi
 * K3) run long, multi-step work with slow reasoning + long single tool calls,
 * and killing a still-working turn is worse than waiting (incident 2026-07-20).
 */
const TURN_INACTIVITY_MS = (() => {
  const raw = Number(process.env.AXIOM_TURN_INACTIVITY_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 20 * 60_000
})()

interface ShellResult {
  output: string
  exitCode: number
  timedOut: boolean
}

/**
 * Run a shell command without blocking the Node event loop.
 *
 * Uses async spawn (not execSync) so the HTTP server stays responsive while a
 * command runs. stdin is closed so interactive prompts (ssh/sudo password) get
 * EOF immediately instead of hanging forever. The child leads its own process
 * group (`detached`), and the whole group is SIGKILLed when
 *  - the timeout fires,
 *  - the tool call is cancelled (`signal`, e.g. the task was aborted) — also
 *    when the signal is already aborted at the start, or
 *  - the output exceeds SHELL_MAX_OUTPUT_BYTES (a runaway producer would
 *    otherwise run on until the timeout while its output is discarded).
 * Killing the group reaches pipelines, `&&` chains, npm wrappers and
 * backgrounded grandchildren (e.g. an ssh ControlMaster) that hold the stdout
 * pipe open, so none of them keeps the call alive past the kill.
 */
function runShellCommand(command: string, timeout: number, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let bytes = 0
    let killReason: 'timeout' | 'abort' | 'maxOutput' | null = null
    let settled = false

    const killGroup = (reason: NonNullable<typeof killReason>) => {
      if (killReason !== null) return
      killReason = reason
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => killGroup('timeout'), timeout)
    const onAbort = () => killGroup('abort')
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })

    const append = (chunk: Buffer, toStderr: boolean) => {
      if (bytes >= SHELL_MAX_OUTPUT_BYTES) return
      bytes += chunk.length
      if (toStderr) stderr += chunk.toString('utf-8')
      else stdout += chunk.toString('utf-8')
      if (bytes >= SHELL_MAX_OUTPUT_BYTES) killGroup('maxOutput')
    }
    child.stdout?.on('data', (chunk: Buffer) => append(chunk, false))
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, true))

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const parts = [stdout, stderr].filter(Boolean)
      if (killReason === 'timeout') parts.push(`Command timed out after ${timeout}ms and was killed.`)
      else if (killReason === 'abort') parts.push('Command aborted (the tool call was cancelled); its process group was killed.')
      else if (killReason === 'maxOutput') {
        parts.push(`Command output exceeded ${SHELL_MAX_OUTPUT_BYTES} bytes; the command was killed.`)
      }
      // A killed command never reports success, even if the shell managed to
      // exit 0 in the race between the kill and the close event.
      const finalExitCode = killReason !== null && exitCode === 0 ? 1 : exitCode
      const output = parts.join('\n') || (finalExitCode === 0 ? SHELL_EMPTY_OUTPUT_TEXT : SHELL_FAILED_OUTPUT_TEXT)
      resolve({ output, exitCode: finalExitCode, timedOut: killReason === 'timeout' })
    }

    child.on('error', (err: Error) => {
      stderr += (stderr ? '\n' : '') + err.message
      finish(1)
    })
    child.on('close', (code) => finish(code ?? (killReason !== null ? 124 : 1)))
  })
}

/**
 * Build YOLO-mode tools that give the agent unrestricted access
 */
export function createYoloTools(): AgentTool[] {
  const shellTool: AgentTool = {
    name: 'shell',
    label: 'Execute Shell Command',
    description: 'Execute a shell command and return stdout/stderr. Use this for any system operation. You run as a non-root user; use sudo for privileged operations (e.g. sudo apt-get install, sudo systemctl).',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to execute' }),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in milliseconds (default: 60000)' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const { command, timeout = 60000 } = params as { command: string; timeout?: number }
      // The signal fires when the tool call is cancelled (task abort, chat
      // stop): the command's process group is killed right away instead of
      // running on until the timeout.
      const { output, exitCode } = await runShellCommand(command, timeout, getWorkspaceDir(), signal)
      // Prompt cap (token audit 2026-09-17): the 10 MB guard above only
      // protects memory. A 1,18 Mio char result used to enter the context in
      // full and was then re-sent with every following call.
      const { shellMaxChars, shellSpillChars } = loadHeuristics().toolOutput
      const inlineChars = shellSpillChars > 0
        ? (shellMaxChars > 0 ? Math.min(shellSpillChars, shellMaxChars) : shellSpillChars)
        : shellMaxChars
      // Long output: head + tail inline, the complete output in a file the
      // model can page through (tool-output-spill.ts). The file gets the
      // SEALED text only: the secret boundary seals the returned text after
      // this function, so seal the full output here first. Password-manager
      // CLI output is never written to disk; it keeps the plain cap.
      if (shellSpillChars > 0 && output.length > inlineChars && !commandInvokesVaultCli(command)) {
        const spilled = spillToolOutput(sealToolText(output, 'shell'), {
          maxChars: inlineChars,
          label: 'shell',
          note: `exit code ${exitCode}`,
        })
        if (spilled) {
          return {
            content: [{ type: 'text' as const, text: spilled.text }],
            details: { exitCode, truncated: true, totalChars: spilled.totalChars, fullOutputPath: spilled.path },
          }
        }
      }
      const capped = capHeadTail(output, shellMaxChars, 'shell output')
      return {
        content: [{ type: 'text' as const, text: capped.text }],
        details: capped.truncated
          ? { exitCode, truncated: true, totalChars: capped.totalChars }
          : { exitCode },
      }
    },
  }

  const readFileTool: AgentTool = {
    name: 'read_file',
    label: 'Read File',
    description:
      'Read the contents of a file at the given path. Long files are returned in slices: pass `offset` (and ' +
      'optionally `limit`) to read the next part. Binary files return metadata only.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to read' }),
      offset: Type.Optional(Type.Number({ description: 'Character offset to start reading at (default 0).' })),
      limit: Type.Optional(Type.Number({ description: 'Characters to return (default and maximum: the prompt cap).' })),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, offset, limit } = params as { path: string; offset?: number; limit?: number }
      const maxChars = loadHeuristics().toolOutput.readFileMaxChars
      try {
        const resolved = resolveWorkspacePath(filePath)

        // Size gate, binary gate, then the character cap. A file that is
        // neither oversized nor binary and fits the cap is returned exactly
        // as before, so the common case is unchanged.
        const stat = fs.statSync(resolved)
        if (stat.isFile() && stat.size > READ_FILE_MAX_BYTES) {
          const mime = guessMimeType(resolved)
          return {
            content: [{ type: 'text' as const, text: describeUnreadableFile({ path: resolved, bytes: stat.size, mime, kind: 'too-large' }) }],
            details: { path: resolved, size: stat.size, bytes: stat.size, mime, skipped: 'too-large' },
          }
        }

        const buffer = fs.readFileSync(resolved)
        const binary = detectBinaryContent(buffer)
        if (binary.binary) {
          const mime = guessMimeType(resolved, buffer)
          return {
            content: [{ type: 'text' as const, text: describeUnreadableFile({ path: resolved, bytes: buffer.length, mime, kind: 'binary', reason: binary.reason }) }],
            details: { path: resolved, size: buffer.length, bytes: buffer.length, mime, binary: true, reason: binary.reason },
          }
        }

        let content = buffer.toString('utf-8')

        // Detect SKILL.md loads under /data/skills_agent/<name>/
        const agentSkillMdMatch = resolved.match(/\/data\/skills_agent\/([^/]+)\/SKILL\.md$/)
        if (agentSkillMdMatch) {
          const skillDir = nodePath.dirname(resolved)
          content = content.replaceAll('{baseDir}', skillDir)
          const skillName = agentSkillMdMatch[1]
          trackAgentSkillUsage(skillName)
          const header = `Skill directory: ${skillDir}\n\n`
          const skillSlice = sliceFileForPrompt(header + content, { offset, limit, maxChars, path: resolved })
          return {
            content: [{ type: 'text' as const, text: skillSlice.text }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              agentSkill: true,
              ...(skillSlice.truncated
                ? { truncated: true, totalChars: skillSlice.totalChars, offset: skillSlice.offset, nextOffset: skillSlice.nextOffset }
                : {}),
            },
          }
        }

        // Detect SKILL.md loads under /data/skills/
        const skillMdMatch = resolved.match(/\/data\/skills\/(.+)\/SKILL\.md$/)
        if (skillMdMatch) {
          const skillDir = nodePath.dirname(resolved)

          // Replace {baseDir} with actual skill directory
          content = content.replaceAll('{baseDir}', skillDir)

          // Look up skill in skills.json and inject env vars
          const injectedVars: string[] = []
          try {
            const skillsFile = loadSkills()
            const matchedSkill = skillsFile.skills.find(s => resolved.startsWith(s.path))
            if (matchedSkill) {
              const decrypted = getSkillDecrypted(matchedSkill.id)
              if (decrypted?.envValues) {
                for (const [key, value] of Object.entries(decrypted.envValues)) {
                  if (value) {
                    process.env[key] = value
                    injectedVars.push(key)
                  }
                }
              }
            }
          } catch {
            // Skills config not available, continue without env injection
          }

          const skillName = skillMdMatch[1] // e.g. "zats/perplexity"
          const header = `Skill directory: ${skillDir}\n\n`
          const skillSlice = sliceFileForPrompt(header + content, { offset, limit, maxChars, path: resolved })
          return {
            content: [{ type: 'text' as const, text: skillSlice.text }],
            details: {
              path: resolved,
              size: content.length,
              skillLoad: true,
              skillName,
              envVarsInjected: injectedVars,
              ...(skillSlice.truncated
                ? { truncated: true, totalChars: skillSlice.totalChars, offset: skillSlice.offset, nextOffset: skillSlice.nextOffset }
                : {}),
            },
          }
        }

        const slice = sliceFileForPrompt(content, { offset, limit, maxChars, path: resolved })
        return {
          content: [{ type: 'text' as const, text: slice.text }],
          details: {
            path: resolved,
            size: content.length,
            ...(slice.truncated
              ? {
                  truncated: true,
                  totalChars: slice.totalChars,
                  totalLines: slice.totalLines,
                  offset: slice.offset,
                  returned: slice.returned,
                  nextOffset: slice.nextOffset,
                }
              : {}),
          },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error reading file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const writeFileTool: AgentTool = {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to write' }),
      content: Type.String({ description: 'Content to write to the file' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, content } = params as { path: string; content: string }
      try {
        const resolved = resolveWorkspacePath(filePath)
        const dir = nodePath.dirname(resolved)
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true })
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote ${content.length} bytes to ${resolved}` }],
          details: { path: resolved, size: content.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error writing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const editFileTool: AgentTool = {
    name: 'edit_file',
    label: 'Edit File',
    description: 'Edit a file using exact text replacements. Each edit specifies an oldText to find and a newText to replace it with. The oldText must match exactly and be unique in the file. Use this instead of write_file when you only need to change specific parts of a file.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to the file to edit' }),
      edits: Type.Array(
        Type.Object({
          oldText: Type.String({ description: 'Exact text to find and replace. Must be unique in the file.' }),
          newText: Type.String({ description: 'Replacement text.' }),
        }),
        { description: 'One or more targeted replacements. Each oldText is matched against the original file.' },
      ),
    }),
    execute: async (_toolCallId, params) => {
      const { path: filePath, edits } = params as { path: string; edits: Array<{ oldText: string; newText: string }> }
      try {
        const resolved = resolveWorkspacePath(filePath)

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: 'text' as const, text: `File not found: ${resolved}` }],
            details: { error: true },
          }
        }

        if (!Array.isArray(edits) || edits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'edits must contain at least one replacement.' }],
            details: { error: true },
          }
        }

        const originalContent = fs.readFileSync(resolved, 'utf-8')
        let content = originalContent

        // Validate all edits first (against original content)
        for (let i = 0; i < edits.length; i++) {
          const { oldText } = edits[i]
          if (!oldText) {
            return {
              content: [{ type: 'text' as const, text: `edits[${i}].oldText must not be empty.` }],
              details: { error: true },
            }
          }
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0) {
            return {
              content: [{ type: 'text' as const, text: `Could not find edits[${i}].oldText in ${filePath}. The text must match exactly.` }],
              details: { error: true },
            }
          }
          if (occurrences > 1) {
            return {
              content: [{ type: 'text' as const, text: `Found ${occurrences} occurrences of edits[${i}].oldText in ${filePath}. The text must be unique.` }],
              details: { error: true },
            }
          }
        }

        // Apply all edits
        for (const { oldText, newText } of edits) {
          content = content.replace(oldText, newText)
        }

        if (content === originalContent) {
          return {
            content: [{ type: 'text' as const, text: `No changes made to ${filePath}. The replacements produced identical content.` }],
            details: { error: true },
          }
        }

        fs.writeFileSync(resolved, content, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Successfully replaced ${edits.length} block(s) in ${filePath}.` }],
          details: { path: resolved, editsApplied: edits.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error editing file: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  const listFilesTool: AgentTool = {
    name: 'list_files',
    label: 'List Files',
    description: 'List files and directories at the given path.',
    parameters: Type.Object({
      path: Type.String({ description: 'Directory path to list' }),
    }),
    execute: async (_toolCallId, params) => {
      const { path: dirPath } = params as { path: string }
      try {
        const resolved = resolveWorkspacePath(dirPath)
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
        const listing = entries.map(e =>
          `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
        ).join('\n')
        return {
          content: [{ type: 'text' as const, text: listing || '(empty directory)' }],
          details: { path: resolved, count: entries.length },
        }
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Error listing directory: ${(err as Error).message}` }],
          details: { error: true },
        }
      }
    },
  }

  return [shellTool, readFileTool, writeFileTool, editFileTool, listFilesTool]
}

/**
 * Check if an error is a retryable pre-stream error (429, 5xx, connection refused).
 */
export function isRetryablePreStreamError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // HTTP 429 rate limit
  if (message.includes('429') || message.includes('rate limit') || message.includes('too many requests')) {
    return true
  }

  // HTTP 5xx server errors
  if (/\b5\d{2}\b/.test(message) || message.includes('internal server error') || message.includes('bad gateway') || message.includes('service unavailable') || message.includes('gateway timeout')) {
    return true
  }

  // Connection errors
  if (message.includes('econnrefused') || message.includes('econnreset') || message.includes('enotfound') || message.includes('connection refused') || message.includes('fetch failed')) {
    return true
  }

  return false
}

/**
 * Detect the "poisoned context" error class: the in-memory message history has
 * a tool_result with no matching tool_use (or vice-versa), typically left by a
 * turn that errored/was refused mid-tool-execution or by a bad compaction
 * boundary. EVERY provider rejects such history, so the session wedges on every
 * subsequent turn until the context is cleared (incident 2026-07-20).
 *
 * Matches both Anthropic ("unexpected `tool_use_id` found in `tool_result`
 * blocks … must have a corresponding `tool_use` block") and OpenAI-style
 * ("tool_call_id … is not found") phrasings.
 */
export function isCorruptedContextError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  if (!message) return false
  return message.includes('tool_use_id')
    || message.includes('tool_call_id')
    || (message.includes('tool_result') && message.includes('tool_use'))
}

/**
 * pi-agent rejects `prompt()` synchronously when a previous run is still marked
 * active ("Agent is already processing a prompt"). When a prior turn was
 * abandoned but its run never settled, this leaks into the NEXT turn even
 * though nothing is really running — recoverable by force-clearing the stale run.
 */
export function isAgentBusyError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase()
  return message.includes('already processing')
}

/**
 * Load active skill entries for system prompt injection.
 */
function getActiveSkillEntries(scope: ContextScope | null): SkillPromptEntry[] {
  try {
    const skillsFile = loadSkills()
    return skillsFile.skills
      .filter(s => s.enabled && (s.contextAccess === 'global' || (scope && s.contextAccess
        && s.contextAccess.userId === scope.userId && s.contextAccess.agentId === scope.agentId && s.contextAccess.key === scope.key)))
      .map(s => ({
        name: s.name,
        description: s.description,
        location: s.path,
      }))
  } catch {
    return []
  }
}

class PiAgentRuntime implements AgentRuntimeBoundary, AgentRuntimePiAgentAccess {
  private agent: PiAgent
  /** Boundary-wrapped tools without `codemode`; codemode is derived per turn (plan 2026-10-08-codemode). */
  private baseTools: AgentTool[] = []
  /** MCP tools for this persona, re-derived per turn start (settings.json › mcp; empty when off). */
  private mcpTools: AgentTool[] = []
  /** Aborts a running MCP discovery when the turn is aborted. */
  private mcpDiscoveryAbort: AbortController | null = null
  private model: Model<Api>
  private apiKey: string
  private db: Database
  private toolCallTimers: Map<string, number> = new Map() // toolCallId -> startTime
  private toolCallArgs: Map<string, unknown> = new Map() // toolCallId -> args
  private memoryDir?: string
  private baseInstructions?: string
  private providerConfig?: ProviderConfig
  private providerManager?: ProviderManager
  private getCurrentToolUserId: () => number | undefined
  private agentId: string
  /** S1-B: whether this runtime offers `ask_user` (and the prompt says so). */
  /**
   * Whether THIS turn offers ask_user (tool + prompt hint). Decided at every
   * turn start from the settings and the turn surface (`promptChannel`, set
   * by the turn source — never by the model). See {@link refreshAskUserOffer}.
   */
  private askUserOffered = false
  /** `describeHistoryStructure` of the last context handed to the provider (diagnostics only). */
  private lastSentStructure: string | null = null
  /** S1-B: a blocking ask_user was filed in the current tool batch (one per turn). */
  private askUserBlockingClaimed = false
  /**
   * Session whose turn currently occupies this runtime's pi-agent run.
   * Only this identity makes a scoped abort routable — without it every
   * abort is process-wide and hits foreign strands.
   */
  private currentSessionId: string | null = null
  /** S1-D: the one-per-batch user interjection slot of the current run. */
  private readonly steerSlot = new SteerSlot()

  constructor(options: AgentRuntimeOptions) {
    this.model = options.model
    this.registerModelOrigin(options.model, options.providerConfig)
    this.apiKey = options.apiKey
    this.db = options.db
    this.memoryDir = options.memoryDir
    this.baseInstructions = options.baseInstructions
    this.providerConfig = options.providerConfig
    this.providerManager = options.providerManager
    this.getCurrentToolUserId = options.getCurrentToolUserId ?? (() => undefined)
    this.agentId = options.agentId ?? 'main'

    // Ensure memory/config structure exists before prompt assembly.
    ensureMemoryStructure(options.memoryDir)
    ensureConfigStructure()

    const { sttEnabled, thinkingLevel: storedThinkingLevel } = this.readRuntimeSettings()
    const effectiveThinkingLevel = normalizeThinkingLevel(options.thinkingLevel) ?? storedThinkingLevel ?? 'off'

    // Privacy (plan 2026-09-26, F2 of the review triage 19:25): an injected
    // system prompt bypasses `buildSystemPrompt` and therefore every seal in
    // memory.ts — seal it here. pi-agent keeps the system prompt out of the
    // message list, so `redactMessages` in the context transform never sees it.
    const systemPrompt = options.systemPrompt
      ? sealSystemText(options.systemPrompt, 'runtime-override')
      : this.buildSystemPrompt(undefined, undefined, this.agentId)

    // Conditionally add the ask_agent tool when multi-persona is enabled.
    //
    // getApiKey must mirror the main PiAgent's OAuth-aware resolver: for OAuth-authenticated
    // providers (e.g. Claude Pro) `this.apiKey` is an empty string and the real token has to
    // be resolved fresh from the provider config on every call. Without this, cross-persona
    // calls hit the provider with an empty key and fail silently.
    const runtimeAgentId = this.agentId
    const askAgentTools: AgentTool[] = loadMultiPersonaSettings().enabled
      ? [createAskAgentTool({
          getCurrentAgentId: () => runtimeAgentId,
          getModel: () => this.model,
          getApiKey: () => this.resolveApiKey('ask_agent'),
          db: this.db,
          getCurrentSessionId: () => this.currentSessionId ?? undefined,
        })]
      : []

    // Stufe 1 (S1-B): structured questions through a tool instead of the
    // markdown fence. The tool is always built; whether a turn offers it
    // (settings.json `askUser.agents` + card-capable surface) is decided per
    // turn start in refreshAskUserOffer(), so tool list and prompt hint agree.
    const askUserTools: AgentTool[] = [createAskUserTool({
          db: this.db,
          getSessionId: () => this.currentSessionId ?? undefined,
          getUserId: () => this.getCurrentToolUserId(),
          getAgentId: () => runtimeAgentId,
          claimBlockingSlot: () => {
            if (this.askUserBlockingClaimed) return false
            this.askUserBlockingClaimed = true
            return true
          },
        })]

    // Privacy (plan 2026-09-26, step 3): the secret boundary wraps the WHOLE
    // tool list, including the caller's exclusive tools (`options.tools`) and
    // ask_agent. Everything a tool returns is sealed before the model or the
    // tool_calls log sees it, and only `shell` resolves handles (D5).
    const tools: AgentTool[] = withSecretBoundary([
      ...(options.tools ?? []),
      ...createBaseAgentTools({
        db: this.db,
        memoryRoot: this.memoryDir,
        builtinToolsConfig: () => this.readRuntimeSettings().builtinToolsConfig,
        sttEnabled,
        getCurrentUserId: () => this.getCurrentToolUserId(),
        // Each runtime is permanently bound to one persona — scope its
        // history/memory tools to that persona (main stays unscoped).
        getCurrentAgentId: () => this.agentId,
        allowPrivateMcp: () => this.isModelStrictlyLocal(),
        // A strand runtime serves one session at a time; recall_message
        // checks raw Eco originals against this session's trusted owner.
        getCurrentSessionId: () => this.currentSessionId ?? undefined,
        quotaService: options.quotaService,
      }),
      ...askAgentTools,
      ...askUserTools,
    ])
    this.baseTools = tools

    this.agent = new PiAgent({
      initialState: {
        systemPrompt,
        model: this.model,
        // Codemode (plan 2026-10-08-codemode): off by default, then this is
        // `tools` unchanged. Re-derived per turn in `refreshCodemodeTool`.
        tools: this.toolsWithCodemode(),
        thinkingLevel: effectiveThinkingLevel,
      },
      // Review 3 / P1-1: the MCP privacy gate is bound to the model object
      // the SDK loop actually sends THIS request to (the loop keeps the model
      // snapshot of its start; a swapProvider mid-turn does not change it).
      streamFn: this.gateRequestTarget(buildStreamFn(
        {
          textVerbosity: this.providerConfig?.textVerbosity,
          transport: this.providerConfig?.transport,
          providerType: this.providerConfig?.providerType,
          ollamaNumCtx: this.providerConfig?.ollamaNumCtx,
          models: this.providerConfig?.models,
        },
        undefined,
        // Prompt-cache routing: the strand id is stable for the whole
        // conversation, so providers that key their cache per session keep
        // hitting the same replica/entry across turns.
        {
          getSessionId: () => this.currentSessionId ?? undefined,
          // Native Ollama only (never consulted for other apis): the CURRENT
          // session's own row, read once per request. A task session carries
          // its own snapshot (inheritEcoMode at task start), so a resume reads
          // exactly that and a later parent toggle never leaks in.
          getContextWindowChoice: () => readStrandContextWindow(this.db, this.currentSessionId ?? null),
        },
      )),
      // Ebene B (last net before send): enforce the tool_use/tool_result
      // boundary invariant on EVERY LLM call, right before pi-ai converts the
      // AgentMessage history to provider messages. pi-ai's transformMessages
      // drops error/aborted assistant messages but keeps their tool_result
      // messages, which can orphan a tool_result at messages[0] and wedge the
      // session (incident 2026-08-17). Sanitizing here means the request never
      // carries an orphan in the first place. A drop here means an upstream
      // mutation path slipped past — surfaced as console.error with a
      // secret-free structural dump.
      transformContext: async (messages) => {
        const { messages: bounded, dropped, drops } = sanitizeHistoryBoundaries(messages)
        if (dropped) {
          console.error(
            `[agent-runtime] tool_use/tool_result boundary violation caught before send (agent ${this.agentId}) — dropped ${drops.length} block(s): ${drops.join('; ')} | structure(before)=${describeHistoryStructure(messages)}`,
          )
        }
        // http_400 incident 2026-11-12: the first non-system message must be
        // a user message, or pi-ai flushes a deferred tool declaration to
        // messages[0] and Anthropic rejects the request. The strand trim
        // already repairs the stored window; this covers every path that
        // skips it (task injections, retries, restored transcripts). A repair
        // here means an upstream path slipped past.
        const opened = openWindowOnUser(bounded)
        if (opened.repaired) {
          console.error(
            `[agent-runtime] window opened on a non-user message, window opener inserted before send (agent ${this.agentId}) | structure(before)=${describeHistoryStructure(bounded)}`,
          )
        }
        const cleaned = opened.messages
        // S1-D (REVIEW-S1-D-2, finding 2): the steer is only ARMED here, on
        // the sanitized outgoing context. It counts as delivered once the
        // provider stream of this request emits its first event
        // (`message_start` of a non-error assistant message, see the
        // subscription in streamPrompt): a guard refusal or a pre-send
        // exception never reaches that point and the steer falls back to a
        // queued turn.
        this.steerSlot.contextAssembled(cleaned)
        // Privacy (plan 2026-09-26, step 4): last net before the request
        // leaves the process. Everything already known (handles, secrets.json
        // env, provider keys, credential-looking process env) is replaced by
        // its handle in every text part. Fail open — a redaction bug must not
        // kill a turn, the earlier boundaries already did the real work.
        // MCP egress gate (review P1-3): local_only MCP output never reaches
        // a model that is not strictly local, even later in the strand.
        // Fail closed: a policy error withholds all MCP output.
        // Review 2 / B: the decision is taken on the ACTUAL target model of
        // THIS request (a provider swap mid-turn included). A non-local target
        // with private MCP material anywhere in the context — results, call
        // arguments, assistant text after them, tool declarations, recalled
        // history, or persisted MCP rows of the strand — is refused whole.
        const targetLocal = this.isModelStrictlyLocal()
        if (!targetLocal) this.assertNoPrivateMcpContext(cleaned)
        let gated = cleaned
        if (cleaned.some(m => (m as { role?: string; toolName?: unknown }).role === 'toolResult' && typeof (m as { toolName?: unknown }).toolName === 'string' && ((m as { toolName: string }).toolName).startsWith('mcp_'))) {
          gated = withholdLocalOnlyMcpOutput(cleaned, targetLocal)
        }
        // http_400 incident 2026-11-12: remember the structure of the window
        // that leaves the process, so a provider rejection can be logged and
        // persisted with it (secret-free: roles, block types, ids, counts).
        this.lastSentStructure = describeHistoryStructure(gated)
        try {
          const outgoing = redactMessages(gated)
          this.recordManifest(outgoing)
          return outgoing
        } catch (err) {
          console.error(`[agent-runtime] redactKnown failed on the outgoing context: ${errorClass(err)}`)
          this.recordManifest(gated)
          return gated
        }
      },
      ...(this.providerConfig?.transport && this.providerConfig.transport !== 'sse'
        && { transport: this.providerConfig.transport }),
      getApiKey: () => this.resolveApiKey('agent-runtime'),
      // Real Eco (plan 2026-10-05-real-eco): a NEW tool result is compacted
      // once, persisted with its verbatim original BEFORE the model sees it,
      // and that frozen projection is what every later request carries (Eco
      // on/off, restart, resume). Already-sent context is never touched; off
      // (the default) this returns undefined and the result stays as is.
      afterToolCall: async (ctx) => this.freezeEcoToolResult(ctx),
      beforeToolCall: async (ctx) => this.guardPrivateMcpToolCall(ctx.toolCall.name),
      // S1-B turn-end rule: pi-agent-core only stops on its own when EVERY
      // call of a batch sets `terminate`. A batch with a blocking ask_user
      // ran its other calls normally; the turn ends here, without a further
      // model request, and waits for the answer.
      finishTurn: (turn) => this.finishTurnWithSteer(turn.toolResults),
    })
  }

  /**
   * S1-B ask_user turn-end rule, then S1-D: a pending user interjection is
   * handed to pi-agent-core's steering queue, which the loop drains right
   * after this hook — so it reaches the next model request of this turn. A
   * batch that ends the turn delivers nothing; the caller queues instead.
   */
  private finishTurnWithSteer(
    toolResults: ReadonlyArray<{ toolName: string; isError: boolean; details?: unknown }>,
  ): { action: 'end' } | undefined {
    const decision = this.finishAskUserTurn(toolResults)
    const block = this.steerSlot.batchFinished(decision?.action === 'end' || toolResults.length === 0)
    if (block) {
      const message = { role: 'user' as const, content: [{ type: 'text' as const, text: block }], timestamp: Date.now() }
      this.steerSlot.attachMessage(message)
      this.agent.steer(message)
    }
    return decision
  }

  offerSteer(sessionId: string, text: string, messageId: number | null = null, opts: SteerOfferOptions = {}): SteerOffer {
    if (this.currentSessionId !== sessionId) return { accepted: false, reason: 'no_run' }
    return this.steerSlot.offer(text, messageId, opts)
  }

  /** `end` after a tool batch with a blocking ask_user call (S1-B); resets the one-blocking slot per batch. */
  private finishAskUserTurn(
    toolResults: ReadonlyArray<{ toolName: string; isError: boolean; details?: unknown }>,
  ): { action: 'end' } | undefined {
    this.askUserBlockingClaimed = false
    return batchHasBlockingAskUser(toolResults) ? { action: 'end' } : undefined
  }

  private recordManifest(messages: readonly unknown[]): void {
    if (!this.currentSessionId) return
    try { recordContextManifest(this.db, this.currentSessionId, this.agentId, this.agent.state.systemPrompt, messages) }
    catch { console.warn('[context] Could not record bounded provenance metadata') }
  }

  /** `baseTools` plus `codemode` when the setting and the current model allow it. Fails closed to `baseTools`. */
  private toolsWithCodemode(): AgentTool[] {
    const own = this.askUserOffered ? this.baseTools : this.baseTools.filter(t => t.name !== ASK_USER_TOOL_NAME)
    // Review 4: codemode never wraps MCP tools. Inside one codemode run an MCP
    // result could feed shell/web/file calls without any model request, so
    // neither the request gate nor the private-strand call guard would see it.
    const withMcp = (list: AgentTool[]) => (this.mcpTools.length > 0 ? [...list, ...this.mcpTools] : list)
    try {
      return withMcp(withCodemodeTool(own, loadCodemodeSettings(), this.model.id, () => this.agent))
    } catch (err) {
      console.error(`[agent-runtime] codemode tool assembly failed, continuing without it: ${errorClass(err)}`)
      return withMcp(own)
    }
  }

  /**
   * Per turn start (review B1/B4): settings are read now (no restart after a
   * change), and ask_user is offered only when the persona is released AND
   * the turn comes from a surface that can serve the card (web, android).
   * Telegram and unknown sources: no tool, no hint; the fence path stays.
   */
  private refreshAskUserOffer(): void {
    this.askUserOffered = isAskUserOfferedFor(this.agentId, this.promptChannel)
  }

  /**
   * MCP (settings.json › mcp): re-discover the tools this persona may use at
   * turn start. Off by default; never throws, a failing server only
   * contributes no tools. The tools go through the same secret boundary as
   * every other tool, so results are sealed before the model sees them.
   */
  private async refreshMcpTools(sessionId: string): Promise<void> {
    const userIdOrUndefined = (id: number | undefined) => (id === undefined ? undefined : String(id))
    const abort = new AbortController()
    this.mcpDiscoveryAbort = abort
    try {
      const reserved = new Set(this.baseTools.map(t => t.name))
      const scope = {
        agentId: this.agentId,
        userId: userIdOrUndefined(this.getCurrentToolUserId()),
        // One MCP session per strand: nothing is shared across strands, users or personas.
        sessionId,
        // Re-evaluated at every call: the model of the strand may change.
        modelIsLocal: () => this.isModelStrictlyLocal(),
      }
      const tools = await getSharedMcpManager().getToolsFor(scope, reserved, abort.signal)
      this.mcpTools = tools.length > 0 ? withSecretBoundary(tools) : []
    } catch (err) {
      console.error(`[agent-runtime] MCP tool discovery failed, continuing without MCP tools: ${errorClass(err)}`)
      this.mcpTools = []
    } finally {
      if (this.mcpDiscoveryAbort === abort) this.mcpDiscoveryAbort = null
    }
  }

  /**
   * Review 2 / B: throws McpPrivateContextError when the outgoing context or
   * the persisted strand carries private MCP material. Only called for a
   * non-local target. Fails closed: an evaluation error refuses the request.
   */
  private assertNoPrivateMcpContext(messages: readonly unknown[]): void {
    let reason: string | null
    try {
      const cloudOk = new Set(this.mcpTools.filter(t => mcpToolDataClass(t) === 'cloud_ok').map(t => t.name))
      reason = findPrivateMcpEvidence(messages, cloudOk)
        ?? (isPrivateMcpSession(this.db, this.currentSessionId) ? 'persisted_strand' : null)
    } catch {
      reason = 'policy_error'
    }
    if (reason === null) return
    console.warn(`[agent-runtime] MCP privacy gate refused a non-local request (agent ${this.agentId}): ${reason}`)
    throw new McpPrivateContextError()
  }

  /** Re-gate the offered MCP tools against the current model (review 2 / B). */
  private regateMcpTools(): void {
    if (this.mcpTools.length === 0 || this.isModelStrictlyLocal()) return
    this.mcpTools = this.mcpTools.filter(t => mcpToolDataClass(t) === 'cloud_ok')
  }

  /**
   * Review 3 / P1-1: provider config id of every model object this runtime
   * built or received. The request gate resolves locality from the model the
   * SDK loop ACTUALLY sends to, not from the mutable `this.model`.
   */
  private readonly modelOrigins = new WeakMap<object, string>()

  private registerModelOrigin(model: unknown, provider: ProviderConfig | undefined): void {
    if (model && typeof model === 'object' && provider?.id) this.modelOrigins.set(model, provider.id)
  }

  /** Strictly local request target; an unknown model object counts as remote. */
  private isRequestTargetStrictlyLocal(model: unknown): boolean {
    try {
      const providerId = model && typeof model === 'object' ? this.modelOrigins.get(model) : undefined
      const modelId = (model as { id?: unknown } | null)?.id
      if (!providerId || typeof modelId !== 'string') return false
      return isStrictlyLocalModel(providerId, modelId)
    } catch {
      return false
    }
  }

  /**
   * Review 3 / P1-1: last check immediately before EVERY wire request. The
   * `model` argument is the request target the SDK loop uses (its snapshot
   * from the start of the run). When that target is not strictly local, the
   * exact outgoing context (tool results, calls, declarations, recalled
   * history) and the persisted strand are checked; private material refuses
   * the request before any byte leaves the process. Fail closed.
   */
  private gateRequestTarget(inner: ReturnType<typeof buildStreamFn>): ReturnType<typeof buildStreamFn> {
    return ((model, context, options) => {
      const messages = (context as { messages?: unknown[] } | null)?.messages ?? []
      const tools = (context as { tools?: Array<{ name?: unknown }> } | null)?.tools
      const cloudOk = new Set(this.mcpTools.filter(t => mcpToolDataClass(t) === 'cloud_ok').map(t => t.name))
      const privateTools = Array.isArray(tools) && tools.some(t => typeof t?.name === 'string' && t.name.startsWith('mcp_') && !cloudOk.has(t.name))
      if (!this.isRequestTargetStrictlyLocal(model)) {
        this.assertNoPrivateMcpContext(messages)
        if (privateTools) {
          console.warn(`[agent-runtime] MCP privacy gate refused a non-local request (agent ${this.agentId}): tool_definition`)
          throw new McpPrivateContextError()
        }
      } else {
        // Review 3 / P1-2: private MCP material (results, calls, tool
        // declarations and their metadata) is about to reach the local model.
        // Taint the turn in memory and the strand persistently FIRST, so no
        // side path (voice, ask_agent, create_task, summaries, facts) can
        // forward what the model learned, also after a reload or in parallel.
        let evidence: string | null
        try { evidence = privateTools ? 'tool_definition' : findPrivateMcpEvidence(messages, cloudOk) } catch { evidence = 'policy_error' }
        if (evidence !== null) {
          const turn = currentMcpPrivacyTurn()
          if (turn) turn.private = true
          if (!markPrivateMcpSession(this.db, this.currentSessionId)) {
            console.warn(`[agent-runtime] MCP privacy gate refused a request: the private marker of the strand could not be persisted (agent ${this.agentId})`)
            throw new McpPrivateContextError()
          }
        }
      }
      return inner(model, context, options)
    }) as ReturnType<typeof buildStreamFn>
  }

  /**
   * Review 4: one call guard for every tool the SDK loop executes, decided
   * per call (a tool offered before the strand turned private is caught
   * too). A strand with private MCP material runs only the read-only/local
   * allowlist plus the MCP tools its server policy offers right now. Clean
   * and cloud_ok strands are untouched. A strand id is required for any MCP
   * material to reach a model (the request gate refuses otherwise), so a
   * turn without one is private only through its in-memory flag.
   */
  private async guardPrivateMcpToolCall(toolName: string): Promise<{ block: true; reason: string } | undefined> {
    let isPrivate: boolean
    try {
      isPrivate = currentMcpPrivacyTurn()?.private === true
        || (!!this.currentSessionId && isPrivateMcpSession(this.db, this.currentSessionId))
    } catch {
      isPrivate = true
    }
    if (!isPrivate) return undefined
    // Only MCP tools the server policy explicitly declares local_only: a
    // cloud_ok server is a remote service, and model-written arguments in a
    // private strand may quote private data (no hidden egress grant).
    const offeredMcp = new Set(this.mcpTools.filter(t => mcpToolDataClass(t) === 'local_only').map(t => t.name))
    if (isToolAllowedInPrivateMcpScope(toolName, offeredMcp) && this.resolvesToTrustedTool(toolName)) return undefined
    console.warn(`[agent-runtime] MCP privacy gate refused a tool call in a private strand (agent ${this.agentId}): ${toolName.startsWith('mcp_') ? 'mcp tool not offered' : toolName}`)
    return { block: true, reason: MCP_PRIVATE_TOOL_BLOCKED }
  }

  /**
   * Review 5: the allowlist is keyed by name, so an allowed name must resolve
   * to exactly one tool instance that was assembled at construction (core
   * factories plus the host's exclusive tools) or, for an MCP name, to the
   * MCP tool discovered for this turn. A duplicate or a later, foreign tool
   * under an allowed name is refused.
   */
  private resolvesToTrustedTool(toolName: string): boolean {
    try {
      const resolved = this.agent.state.tools.filter(t => t.name === toolName)
      if (resolved.length !== 1) return false
      const trusted: readonly AgentTool[] = toolName.startsWith('mcp_') ? this.mcpTools : this.baseTools
      return trusted.includes(resolved[0])
    } catch {
      return false
    }
  }

  /** Strictly local current model (data-policy). Any doubt counts as remote. */
  private isModelStrictlyLocal(): boolean {
    try {
      return isStrictlyLocalModel(this.providerConfig?.id ?? '', this.model.id)
    } catch {
      return false
    }
  }

  /**
   * Re-derive the codemode tool at the start of a turn: the setting is read
   * per turn and `swapProvider` may have changed the model. The description
   * is deterministic, so an unchanged allowlist declares no tool change and
   * the prompt cache prefix stays stable.
   */
  private refreshCodemodeTool(): void {
    // pi-agent-core diffs tool DECLARATIONS (name, description, schema), not
    // instances, so a rebuilt codemode tool with the same allowlist and
    // limits declares no tool change. Always assigning keeps the freshly
    // read limits (memory, output cap) in effect.
    this.agent.state.tools = this.toolsWithCodemode()
  }

  private async freezeEcoToolResult(ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> {
    // A call a codemode script issued never reaches the model or the
    // transcript; only the codemode result itself is frozen (plan 2026-10-08-codemode).
    if (isNestedCodemodeCallId(ctx.toolCall.id)) return undefined
    const sessionId = this.currentSessionId
    if (!sessionId || readStrandEcoMode(this.db, sessionId) !== 'on') return undefined
    if ((ctx.result as { structuredContent?: unknown }).structuredContent !== undefined) return undefined
    // Fail closed: a raw original is stored only for a trusted owner (the
    // turn's user agreeing with the session owner in the DB).
    const owner = resolveTurnEcoOwner(this.db, sessionId, this.getCurrentToolUserId())
    if (owner === undefined) return undefined
    const frozen = freezeEcoToolResult({
      db: this.db,
      sessionId,
      userId: owner,
      ownerUserId: owner,
      agentId: this.agentId,
      toolName: ctx.toolCall.name,
      toolCallId: ctx.toolCall.id,
      args: ctx.args,
      content: ctx.result.content,
      details: ctx.result.details,
      isError: ctx.isError,
    })
    return frozen ? { content: frozen.content, details: frozen.details } : undefined
  }

  /**
   * The credential for the CURRENT provider, resolved per call.
   *
   * Deliberately not decided once at construction: `swapProvider` replaces the
   * provider of a live runtime (per-strand/per-persona model selection), so a
   * runtime built on an API-key provider and later swapped to an OAuth one
   * would otherwise keep serving the access token frozen at swap time and
   * never see a refreshed one — a guaranteed 401 in a process that outlives
   * the token lifetime. Resolving here also means a credential refreshed after
   * an authentication failure is picked up by the very next call.
   *
   * OAuth resolution failures fall back to the cached key instead of throwing:
   * the request then fails with the provider's own error, which is what the
   * turn runner classifies.
   */
  private async resolveApiKey(logScope: string): Promise<string> {
    const provider = this.providerConfig
    if (provider?.authMethod !== 'oauth') return this.apiKey
    try {
      const file = loadProvidersDecrypted()
      const freshProvider = file.providers.find(p => p.id === provider.id)
      if (freshProvider) return await getApiKeyForProvider(freshProvider)
    } catch (err) {
      console.error(`[${logScope}] OAuth token refresh failed: ${errorClass(err)}`)
    }
    return this.apiKey
  }

  streamPrompt(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    // S1-B: answers of non-blocking questions and dismissed questions reach
    // the model once, ahead of the next user text (consumed on read).
    // Two phases (review B3): reserved now with a 10-minute lease, marked
    // delivered only when the turn ends without error.
    const claim = claimInteractionContextNotes(this.db, sessionId)
    if (!claim) return this.executePromptWithRetry(text, sessionId, false, images)
    return this.confirmNotesOnTurnEnd(claim.turnId, this.executePromptWithRetry(`${claim.text}\n\n${text}`, sessionId, false, images))
  }

  /**
   * Phase 2 of the context notes: a turn that ran to its end without an
   * error chunk marks them delivered; an error, an abort or a consumer that
   * stops early releases the lease, so the next turn carries them again
   * (a crash leaves the lease to run out — duplicate yes, loss no).
   */
  private async *confirmNotesOnTurnEnd(turnId: string, stream: AsyncIterable<ResponseChunk>): AsyncIterable<ResponseChunk> {
    let ok = false
    let errored = false
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'error') errored = true
        yield chunk
      }
      ok = !errored
    } finally {
      if (ok) markInteractionContextNotesDelivered(this.db, turnId)
      else releaseInteractionContextNotes(this.db, turnId)
    }
  }

  retryLastTurn(text: string, sessionId: string, images?: ImageContent[]): AsyncIterable<ResponseChunk> {
    const continuable = this.dropFailedAssistantTail()
    return this.executePromptWithRetry(text, sessionId, false, images, continuable)
  }

  /**
   * Drop the trailing assistant messages left behind by a failed turn so the
   * transcript ends on the user (or tool-result) message the assistant still
   * owes an answer to. Returns false when no such tail exists — then the
   * caller must re-prompt instead of continuing.
   */
  private dropFailedAssistantTail(): boolean {
    const messages = this.agent.state.messages
    let end = messages.length
    while (end > 0 && (messages[end - 1] as { role?: string }).role === 'assistant') end--
    if (end === 0) return false

    const last = messages[end - 1] as { role?: string }
    if (last.role !== 'user' && last.role !== 'toolResult') return false

    if (end !== messages.length) this.agent.state.messages = messages.slice(0, end)
    return true
  }

  // Fork: persona-aware refresh (agentId selects the persona's instructions,
  // defaulting to this runtime's bound persona).
  // pi-agent-core >= 0.87 makes `state.systemPrompt` read-only: the prompt is
  // replayed from the transcript's system messages. Replacing the prompt (what
  // this fork does on every persona/channel switch) therefore means rewriting
  // the leading system message in place, keeping its tool declarations.
  private promptChannel?: string
  private promptUser?: { username: string }

  refreshSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string, sessionId?: string): void {
    // A global memory/skills refresh is not an identity change. Explicit
    // arguments (even undefined) still clear stale identity fail-closed.
    if (arguments.length === 0) {
      channel = this.promptChannel
      currentUser = this.promptUser
    }
    this.promptChannel = channel
    this.promptUser = currentUser
    const prompt = this.buildSystemPrompt(channel, currentUser, agentId ?? this.agentId, sessionId)
    if (this.agent.state.systemPrompt === prompt) return

    const messages = this.agent.state.messages.slice()
    const first = messages[0] as (SystemMessage & { role?: string }) | undefined
    if (first && first.role === 'system') {
      messages[0] = { ...first, content: prompt } as AgentMessage
    } else {
      messages.unshift({ role: 'system', content: prompt, timestamp: Date.now() } as AgentMessage)
    }
    this.agent.state.messages = messages
  }

  getCurrentTimeContext(): string {
    const { timezone } = this.readRuntimeSettings()
    return formatCurrentTimeContext(timezone)
  }

  setThinkingLevel(level: SettingsThinkingLevel | string): void {
    const normalized = normalizeThinkingLevel(level)
    if (!normalized) return
    this.agent.state.thinkingLevel = normalized
  }

  getThinkingLevel(): SettingsThinkingLevel {
    return normalizeThinkingLevel(this.agent.state.thinkingLevel) ?? 'off'
  }

  swapProvider(provider: ProviderConfig, apiKey: string, modelId?: string): void {
    this.model = buildModel(provider, modelId)
    this.registerModelOrigin(this.model, provider)
    this.apiKey = apiKey
    this.providerConfig = provider
    this.agent.state.model = this.model
    // Review 2 / B: local_only MCP tools leave the offer at once when the new
    // model is not strictly local (before any further request is built).
    this.regateMcpTools()
    // The codemode tool is gated by a model allowlist: a fallback to a model
    // outside it must lose the tool at once, not only on the next turn.
    this.refreshCodemodeTool()
  }

  getProviderManager(): ProviderManager | undefined {
    return this.providerManager
  }

  setProviderManager(manager: ProviderManager | undefined): void {
    this.providerManager = manager
  }

  clearMessages(): void {
    this.agent.state.messages = []
  }

  getMessages(): AgentMessage[] {
    return this.agent.state.messages
  }

  setMessages(messages: AgentMessage[]): void {
    // `state.messages` copies the assigned top-level array (pi-agent-core), so
    // the caller's snapshot stays independent of further mutations here.
    this.agent.state.messages = messages
  }

  /**
   * Ebene B (after mutation): enforce the tool_use/tool_result boundary
   * invariant on the persistent in-memory history. Called after every turn so
   * an orphan left by an errored/aborted turn is repaired at the source — not
   * just masked on the outgoing request. A drop here is expected maintenance
   * (console.warn), whereas a drop in the pre-send transformContext net means
   * something reached the wire uncleaned (console.error). Returns true if the
   * history was modified.
   */
  private sanitizeInMemoryHistory(context: string): boolean {
    let messages: unknown
    try {
      messages = this.agent.state.messages
    } catch {
      return false
    }
    if (!Array.isArray(messages) || messages.length === 0) return false
    const { messages: cleaned, dropped, drops } = sanitizeHistoryBoundaries(messages)
    if (!dropped) return false
    console.warn(
      `[agent-runtime] Repaired tool_use/tool_result boundary in history (${context}, agent ${this.agentId}) — dropped ${drops.length} block(s): ${drops.join('; ')}`,
    )
    try {
      this.agent.state.messages = cleaned
    } catch (err) {
      console.error(`[agent-runtime] Failed to write back sanitized history: ${errorClass(err)}`)
      return false
    }
    return true
  }

  abort(scope?: AbortScope): void {
    if (scope?.sessionId !== undefined && this.currentSessionId !== scope.sessionId) return
    this.mcpDiscoveryAbort?.abort()
    this.agent.abort()
  }

  getAgent(): PiAgent {
    return this.agent
  }

  getStateSnapshot(): AgentRuntimeStateSnapshot {
    return {
      modelId: this.model.id,
      toolNames: this.agent.state.tools.map(tool => tool.name),
      messageCount: this.agent.state.messages.length,
    }
  }

  getRunningSessionId(): string | null {
    return this.currentSessionId
  }

  getCurrentModel(): Model<Api> {
    return this.model
  }

  getCurrentApiKey(): string {
    return this.apiKey
  }

  getCurrentProvider(): ProviderConfig | null {
    return this.providerConfig ?? null
  }

  private readRuntimeSettings(): {
    language: string | undefined
    timezone: string | undefined
    builtinToolsConfig: BuiltinToolsConfig | undefined
    sttEnabled: boolean
    thinkingLevel: SettingsThinkingLevel | undefined
    instanceIdentity: RuntimeInstanceIdentity | undefined
  } {
    let language: string | undefined
    let timezone: string | undefined
    let builtinToolsConfig: BuiltinToolsConfig | undefined
    let thinkingLevel: SettingsThinkingLevel | undefined
    let instanceIdentity: RuntimeInstanceIdentity | undefined
    try {
      ensureConfigTemplates()
      const settings = loadConfig<{
        language?: string
        timezone?: string
        builtinTools?: BuiltinToolsConfig
        thinkingLevel?: string
        instanceIdentity?: RuntimeInstanceIdentity
      }>('settings.json')
      language = settings.language
      timezone = settings.timezone
      builtinToolsConfig = settings.builtinTools
      thinkingLevel = normalizeThinkingLevel(settings.thinkingLevel)
      instanceIdentity = settings.instanceIdentity
    } catch {
      // Config not available yet, use defaults
    }

    let sttEnabled = false
    try {
      sttEnabled = loadSttSettings().enabled
    } catch {
      // STT settings not available
    }

    return { language, timezone, builtinToolsConfig, sttEnabled, thinkingLevel, instanceIdentity }
  }

  private buildSystemPrompt(channel?: string, currentUser?: { username: string }, agentId?: string, sessionId?: string): string {
    const { language, timezone, builtinToolsConfig, sttEnabled, instanceIdentity } = this.readRuntimeSettings()

    const contextScope = currentUser && channel !== 'telegram-group' ? resolveContextScope(this.db, sessionId, agentId ?? this.agentId) : null
    const activeSkills = getActiveSkillEntries(contextScope)
    // Build a skill-prompt context so agent skills can be gated by the current
    // platform / active toolset and annotated with missing required env vars.
    const activeTools = new Set<string>([
      'shell', 'read_file', 'write_file', 'edit_file', 'list_files',
      'create_task', 'resume_task', 'list_tasks', 'get_task', 'steer_task', 'cancel_task',
      'create_cronjob', 'edit_cronjob', 'remove_cronjob', 'list_cronjobs', 'get_cronjob',
      'create_reminder',
      'read_chat_history', 'search_memories', 'list_agent_skills',
    ])
    if (builtinToolsConfig?.webSearch?.enabled !== false) activeTools.add('web_search')
    if (builtinToolsConfig?.webFetch?.enabled !== false) activeTools.add('web_fetch')
    if (sttEnabled) activeTools.add('transcribe_audio')

    const scopedSkills = listScopedAgentSkills(contextScope)
    const agentSkillEntries = filterAndAnnotateAgentSkills(scopedSkills.sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "")).slice(0, 10), {
      platform: currentPlatform(),
      activeTools,
    })
    const totalAgentSkills = scopedSkills.length
    const allSkills = [...activeSkills, ...agentSkillEntries]

    const builtinToolsPromptConfig = {
      ...builtinToolsConfig,
      stt: { enabled: sttEnabled },
    }

    // Provider/model inventory — lets the agent translate user-facing
    // model names (e.g. "kimi-k2.6") into the right `provider`/`model`
    // arguments for create_task / create_cronjob / edit_cronjob, and route
    // background tasks to models the user annotated with a description.
    // Failures here are non-fatal: the tools still work without this hint,
    // the agent just has to guess or ask.
    let availableProviders: Array<{ name: string; models: AvailableProviderModelPromptEntry[] }> | undefined
    try {
      const file = loadProvidersDecrypted()
      const activeProviderId = file.activeProvider ?? null

      let taskProviderId: string | null = null
      let taskModelId: string | undefined
      try {
        ensureConfigTemplates()
        const settings = loadConfig<{ tasks?: { defaultProvider?: string } }>('settings.json')
        const taskDefault = settings.tasks?.defaultProvider
        if (taskDefault) {
          const parsed = parseProviderModelId(taskDefault)
          if (parsed.providerId) {
            taskProviderId = parsed.providerId
            taskModelId = parsed.modelId
          }
        }
      } catch {
        // settings not available yet — no task default label
      }

      availableProviders = file.providers.map(p => {
        const enabled = p.enabledModels ?? []
        const activeModelForProvider = p.id === activeProviderId ? (file.activeModel ?? getProviderDefaultModel(p)) : null
        const models: AvailableProviderModelPromptEntry[] = enabled.map(id => {
          const entry = p.models?.find(m => m.id === id)
          const isDefaultAgentModel = p.id === activeProviderId && id === activeModelForProvider
          const isDefaultTaskModel = p.id === taskProviderId && id === (taskModelId ?? getProviderDefaultModel(p))
          return {
            id,
            description: entry?.description,
            isDefaultAgentModel: isDefaultAgentModel || undefined,
            isDefaultTaskModel: isDefaultTaskModel || undefined,
          }
        })
        return { name: p.name, models }
      })
    } catch {
      availableProviders = undefined
    }

    // Per-provider prompt profile: 'slim' shrinks the prompt for slow/local
    // providers (fewer dailies, no wiki listing, no docs block). Without a
    // configured profile this resolves to the historical defaults, keeping
    // the prompt byte-identical for existing providers.
    const profileOptions = resolvePromptProfileOptions(this.providerConfig?.promptProfile)

    let prompt = assembleSystemPrompt({
      memoryDir: this.memoryDir,
      contextScope,
      baseInstructions: this.baseInstructions,
      instanceIdentity,
      recentDays: profileOptions.recentDays,
      includeWikiPages: profileOptions.includeWikiPages,
      includeAxiomDocs: profileOptions.includeAxiomDocs,
      language,
      timezone,
      channel,
      skills: allSkills,
      agentSkillsOverflowCount: totalAgentSkills > 10 ? totalAgentSkills : undefined,
      currentUser,
      builtinTools: builtinToolsPromptConfig,
      agentSkillsDir: contextScope ? scopedAgentSkillsDir(contextScope) : undefined,
      availableProviders,
      agentId,
    })

    if (sessionId) prompt += strandWorkingModePrompt(agentId ?? this.agentId, readStrandWorkingMode(this.db, sessionId))

    if (this.askUserOffered) prompt += `\n\n${ASK_USER_SYSTEM_HINT}\n`

    // Append cross-persona hint when ask_agent is available.
    if (loadMultiPersonaSettings().enabled) {
      const hint = buildAskAgentPromptHint(agentId ?? 'main', undefined, this.db)
      if (hint) {
        prompt += hint
      }
    }

    // Privacy (plan 2026-09-26, F2): `memory.ts` seals the sections it owns,
    // but everything assembled around them (skill list, provider list, docs
    // block, ask_agent hint) went to the model unsealed. This is the one net
    // over the WHOLE prompt; it is deterministic and idempotent over existing
    // handles, so the prompt prefix cache stays stable.
    return sealSystemText(prompt, 'runtime')
  }

  /**
   * Execute a prompt with optional fallback retry on pre-stream errors.
   */
  private async *executePromptWithRetry(text: string, sessionId: string, isRetry: boolean = false, images?: ImageContent[], continueTranscript = false): AsyncIterable<ResponseChunk> {
    const eventQueue: AgentEvent[] = []
    let resolveWaiting: (() => void) | null = null
    let done = false
    let preStreamError: unknown = null
    let midStreamError: unknown = null

    const unsubscribe = this.agent.subscribe((event: AgentEvent) => {
      // S1-D: synchronous, so an interjection offered while this batch
      // executes is accepted for it (the chunk consumer may lag behind).
      if (event.type === 'tool_execution_start') this.steerSlot.toolStarted()
      // S1-D (REVIEW-S1-D-2): send start = the provider stream's first
      // `start` event (pi-ai pushes it only after the HTTP response
      // arrived; the overflow guard forwards one per answered request and
      // none on a refusal). The loop maps it to `message_start` of the
      // partial assistant message; an error/abort without a start is mapped
      // to a `message_start` of the final error message, which is ignored.
      else if (event.type === 'message_start' && isSentAssistantStart(event.message)) this.steerSlot.requestStarted()
      eventQueue.push(event)
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    // Start the prompt (non-blocking)
    this.currentSessionId = sessionId
    this.askUserBlockingClaimed = false
    this.refreshAskUserOffer()
    // A2 (S0-A): every secret-boundary replacement made while this prompt
    // runs (system prompt, context transform, tool results) is counted in this scope.
    const sealingScope = createSealingScope(`agent=${this.agentId} session=${sessionId}`)
    // Scope must be resolved at every turn, including runtime reuse and global refresh.
    runInSealingScope(sealingScope, () => this.refreshSystemPrompt(this.promptChannel, this.promptUser, this.agentId, sessionId))
    await this.refreshMcpTools(sessionId)
    this.refreshCodemodeTool()
    // Review 3 / P1-2: the in-memory privacy state of this turn; every tool
    // the loop executes inherits it. Starts private when the strand already is.
    const privacyTurn = { sessionId: sessionId ?? null, private: isPrivateMcpSession(this.db, sessionId) }
    const started = runInMcpPrivacyTurn(privacyTurn, () => runInSealingScope(sealingScope, () => (continueTranscript ? this.agent.continue() : this.agent.prompt(text, images))))
    const promptPromise = started.then(() => {
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    }).catch((err) => {
      // If no events have been received yet, this is a pre-stream error
      if (eventQueue.length === 0) {
        preStreamError = err
      } else {
        // Mid-stream error — surface error to the user, then signal agent_end
        // Class only: a provider error body can quote the prompt (= a
        // dictation); its message and stack stay out of the log (review K0-K2-3 #2).
        console.error(`Agent prompt error (mid-stream, session ${sessionId}): ${errorClass(err)}`)
        midStreamError = err
        eventQueue.push({ type: 'agent_end', messages: [] })
      }
      done = true
      if (resolveWaiting) {
        resolveWaiting()
        resolveWaiting = null
      }
    })

    let yieldedDone = false

    // Per-turn accounting so a turn that ends with zero visible output is
    // diagnosable from the logs (incident 2026-07-20: silent empty turns).
    let textChars = 0
    let thinkingChars = 0
    let toolCalls = 0
    let errorChunks = 0
    let corruptedContext = false
    // Provider output that maps to no chunk (tool-call argument deltas, block
    // boundaries) is still proof the stream is alive. Tell the stall watchdog
    // of this session, throttled (plan 2026-10-09-provider-silence).
    const signalStreamActivity = createStreamActivityNotifier(sessionId)

    try {
      while (true) {
        // Process all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          const chunks = this.processEvent(event, sessionId)
          if (chunks.length === 0 && event.type === 'message_update') signalStreamActivity()
          for (const chunk of chunks) {
            if (chunk.type === 'done') yieldedDone = true
            if (chunk.type === 'text') textChars += chunk.text?.length ?? 0
            if (chunk.type === 'thinking') thinkingChars += chunk.thinking?.length ?? 0
            if (chunk.type === 'tool_call_start') toolCalls++
            if (chunk.type === 'error') {
              // Suppress the raw provider corruption error (ugly, and we emit a
              // friendly recovery notice after auto-clearing below).
              if (isCorruptedContextError(chunk.rawError ?? chunk.error)) {
                corruptedContext = true
                continue
              }
              errorChunks++
            }
            yield chunk
          }
        }

        if (done && eventQueue.length === 0) break

        // Wait for more events — bounded by the inactivity watchdog so a
        // completion whose promise never settles cannot hang the turn (and
        // with it the sequential message queue) forever.
        const outcome = await new Promise<'event' | 'inactivity'>(resolve => {
          const timer = setTimeout(() => resolve('inactivity'), TURN_INACTIVITY_MS)
          if (typeof timer === 'object' && 'unref' in timer) timer.unref()
          resolveWaiting = () => {
            clearTimeout(timer)
            resolve('event')
          }
        })
        resolveWaiting = null

        if (outcome === 'inactivity') {
          console.error(`[agent-runtime] Turn watchdog: no agent events for ${Math.round(TURN_INACTIVITY_MS / 1000)}s — aborting turn (session ${sessionId})`)
          try {
            this.agent.abort()
          } catch {
            // best effort — the turn is abandoned either way
          }
          midStreamError = new Error(`Keine Aktivität für ${Math.round(TURN_INACTIVITY_MS / 60_000)} Minuten — Turn abgebrochen. Bitte Nachricht erneut senden.`)
          break
        }
      }
    } finally {
      unsubscribe()
      // S1-D: an interjection the run did not take settles `false`; the
      // caller queues it as a normal turn.
      // An in-flight steer that never reached a request must not leak into
      // the next run (it comes back as a queued turn of its own).
      const undelivered = this.steerSlot.inFlightMessage()
      if (undelivered) {
        try {
          this.agent.clearSteeringQueue()
          const msgs = this.agent.state.messages
          if (msgs.includes(undelivered as never)) this.agent.state.messages = msgs.filter(m => m !== undelivered)
        } catch (err) {
          console.warn(`[agent-runtime] Could not drop an undelivered steer: ${errorClass(err)}`)
        }
      }
      this.steerSlot.runEnded()
      // Normally settled once `done` is set; after a watchdog abort it may
      // never settle (that's the failure mode we're guarding against), so
      // never await it unbounded.
      await Promise.race([
        promptPromise,
        new Promise<void>(resolve => {
          const t = setTimeout(resolve, 10_000)
          if (typeof t === 'object' && 'unref' in t) t.unref()
        }),
      ])
      // If the run is STILL active after the bounded wait, abort it and let it
      // settle on its own — pi-agent's handleRunFailure then clears activeRun.
      // We deliberately do NOT force-clear activeRun here: nulling it out from
      // under a live run makes pi-agent throw "Agent listener invoked outside
      // active run" when a late event (e.g. a delayed connection error) arrives
      // (incident 2026-07-20). A run that truly ignores the abort is rare and
      // self-recovers once it eventually settles.
      if (!done) {
        console.error(`[agent-runtime] Turn generator closing with run still active (session ${sessionId}) — aborting orphaned run`)
        try {
          this.agent.abort()
        } catch {
          // best effort
        }
      }
      // Released last so a scoped abort arriving during the bounded wait above
      // (a user /stop on a run that ignores the first abort) still reaches this
      // run. A fallback retry re-enters this method and claims it again.
      if (this.currentSessionId === sessionId) this.currentSessionId = null
    }

    // One line per turn — this is the primary forensic breadcrumb for
    // "bot went silent" reports: it shows exactly what the model returned.
    console.log(`[agent-runtime] Turn end (session ${sessionId}): text=${textChars} thinking=${thinkingChars} tools=${toolCalls} errors=${errorChunks}${midStreamError ? ' midStreamError' : ''}${preStreamError ? ' preStreamError' : ''}${corruptedContext ? ' corruptedContext' : ''}`)
    const sealingLine = finishSealingScope(sealingScope)
    if (sealingLine) (sealingLine.hot ? console.warn : console.log)(sealingLine.line)
    if (textChars === 0 && toolCalls === 0 && errorChunks === 0 && !midStreamError && !preStreamError && !corruptedContext) {
      console.warn(`[agent-runtime] EMPTY TURN (session ${sessionId}): model produced no text, no tool calls, no error — thinking=${thinkingChars} chars. Provider degradation?`)
    }

    // Ebene B (after mutation): a turn that errored/aborted mid-tool can leave a
    // dangling tool_use or an orphan tool_result in state.messages. Repair it
    // now so the NEXT turn starts from a valid boundary and never triggers the
    // provider 400 in the first place (incident 2026-08-17). The reactive
    // auto-clear below stays as the last-resort safety net.
    try {
      this.sanitizeInMemoryHistory(`turn end, session ${sessionId}`)
    } catch (err) {
      console.error(`[agent-runtime] Post-turn history sanitize failed: ${errorClass(err)}`)
    }

    // Surface mid-stream errors (e.g. context window exceeded after tool calls)
    if (midStreamError) {
      const errMsg = (midStreamError instanceof Error ? midStreamError.message : String(midStreamError)) || 'Unknown error'
      console.error(`Agent mid-stream error surfaced to user (session ${sessionId}): ${errorClass(midStreamError)}`)
      if (isCorruptedContextError(midStreamError)) corruptedContext = true
      yield withRawError({ type: 'error' as const, error: publicProviderError(errMsg) }, errMsg)
    }
    if (preStreamError && isCorruptedContextError(preStreamError)) corruptedContext = true

    // Self-heal a poisoned context: a dangling tool_use/tool_result pair wedges
    // EVERY provider on EVERY subsequent turn. Clear the in-memory history so
    // the next message starts clean instead of requiring a manual /new or a
    // container restart (incident 2026-07-20). The DB chat history is untouched;
    // only the live agent context is reset.
    if (corruptedContext) {
      // Secret-free structural dump (roles + block types + tool ids only, NEVER
      // content) so we can see WHICH boundary broke if the invariant nets ever
      // miss a case. Best-effort: try to repair in place first — if that
      // resolves the invariant we avoid nuking the whole context.
      try {
        console.error(
          `[agent-runtime] Corrupted context structure (session ${sessionId}): ${describeHistoryStructure(this.agent.state.messages)}`,
        )
      } catch {
        // history not readable — fall through to clear
      }
      const repaired = (() => {
        try {
          return this.sanitizeInMemoryHistory(`corrupted-context heal, session ${sessionId}`)
        } catch {
          return false
        }
      })()
      console.error(`[agent-runtime] Corrupted context detected (session ${sessionId}) — ${repaired ? 'repaired boundary in place, ' : ''}auto-clearing in-memory history to unwedge the session`)
      try {
        this.clearMessages()
      } catch (err) {
        console.error(`[agent-runtime] Failed to auto-clear corrupted context: ${errorClass(err)}`)
      }
      yield withRawError({ type: 'error' as const, error: CORRUPTED_CONTEXT_NOTICE }, CORRUPTED_CONTEXT_NOTICE)
    }

    // Safety net: if no 'done' chunk was yielded (e.g. agent_end never fired),
    // ensure we always signal completion so the frontend doesn't hang.
    if (!yieldedDone && !preStreamError) {
      yield { type: 'done' as const }
    }

    // Handle pre-stream error with fallback retry
    if (preStreamError) {
      // "Agent is already processing" means a PRIOR turn's run is still live
      // (long autonomous work whose queue slot the watchdog released early).
      // Surface an honest, non-destructive notice — do NOT force-clear the
      // live run (that caused "listener invoked outside active run",
      // incident 2026-07-20). The running turn finishes on its own.
      if (isAgentBusyError(preStreamError)) {
        console.warn(`[agent-runtime] prompt() rejected as busy (session ${sessionId}) — a previous turn is still running; asking user to retry`)
        yield withRawError({ type: 'error' as const, error: PREVIOUS_RUN_BUSY_NOTICE }, PREVIOUS_RUN_BUSY_NOTICE)
        yield { type: 'done' as const }
        return
      }

      const canRetry = !isRetry
        && this.providerManager
        && this.providerManager.getOperatingMode() === 'normal'
        && this.providerManager.getFallbackProvider() !== null
        && isRetryablePreStreamError(preStreamError)

      if (canRetry) {
        console.warn(`[AgentRuntime] Pre-stream error detected (session ${sessionId}), swapping to fallback provider: ${errorClass(preStreamError)}`)
        this.providerManager!.swapToFallback()
        const fallback = this.providerManager!.getEffectiveProvider()!
        const apiKey = await getApiKeyForProvider(fallback)
        const previousModelId = this.model.id
        this.swapProvider(fallback, apiKey)
        // Audit only: the sessions pin columns are intentionally untouched, so
        // the next turn re-resolves the strand's requested model.
        this.db.prepare(
          `INSERT INTO chat_messages (session_id, role, content, metadata, agent_id)
           VALUES (?, 'system', ?, ?, ?)`,
        ).run(
          sessionId,
          `Modell (automatischer Fallback): ${previousModelId} → ${this.model.id}`,
          JSON.stringify({ type: 'model_change', automatic: true }),
          this.agentId,
        )

        // Retry once with fallback
        yield* this.executePromptWithRetry(text, sessionId, true, images, continueTranscript)
        return
      }

      // No retry possible — surface the error
      // Class only, never the Error object (message + stack can carry a
      // provider echo of the prompt, review K0-K2-3 #2). The client gets a
      // fixed text plus class; the raw message stays in `rawError` for the
      // runner's retry/auth classifiers (review K0-K2-4 #2).
      console.error(`Agent prompt error (pre-stream, session ${sessionId}${isRetry ? ', after fallback' : ''}): ${errorClass(preStreamError)}`)
      const preStreamMessage = (preStreamError as Error).message ?? String(preStreamError)
      yield withRawError({ type: 'error' as const, error: publicProviderError(preStreamMessage) }, preStreamMessage)
      yield { type: 'done' as const }
    }
  }

  /**
   * Process an agent event into response chunks.
   */
  private processEvent(event: AgentEvent, sessionId: string): ResponseChunk[] {
    const chunks: ResponseChunk[] = []

    switch (event.type) {
      case 'message_update': {
        const assistantEvent = event.assistantMessageEvent
        if (assistantEvent.type === 'text_delta') {
          chunks.push({
            type: 'text',
            text: assistantEvent.delta,
          })
        } else if (assistantEvent.type === 'thinking_delta') {
          chunks.push({
            type: 'thinking',
            thinking: assistantEvent.delta,
          })
        }
        break
      }

      case 'message_end': {
        const msg = event.message as Message
        if (msg.role === 'assistant') {
          const assistantMsg = msg as AssistantMessage
          // Log token usage
          const cost = estimateCost(
            this.model,
            assistantMsg.usage.input,
            assistantMsg.usage.output,
            assistantMsg.usage.cacheRead,
            assistantMsg.usage.cacheWrite,
          )

          // Use pi-mono cost if available and non-zero, otherwise our estimate
          const finalCost = assistantMsg.usage.cost.total > 0
            ? assistantMsg.usage.cost.total
            : cost

          logTokenUsage(this.db, {
            provider: assistantMsg.provider,
            model: assistantMsg.model,
            promptTokens: assistantMsg.usage.input,
            completionTokens: assistantMsg.usage.output,
            cacheRead: assistantMsg.usage.cacheRead,
            cacheWrite: assistantMsg.usage.cacheWrite,
            estimatedCost: finalCost,
            sessionId,
            agentId: this.agentId,
            contextWindow: this.model.contextWindow ?? null,
            // Class only (review K0-K2-4 #2): the provider message can echo
            // the prompt and this column is kept for months.
            error: (assistantMsg as { errorMessage?: string }).errorMessage
              ? errorTextClass((assistantMsg as { errorMessage?: string }).errorMessage)
              : ((assistantMsg as { stopReason?: string }).stopReason === 'error' ? 'Unknown model error' : null),
          })
          // SPEC 11.5: one line per turn so a cache regression is visible in
          // the container log without a query.
          {
            const ratio = cacheReadRatio(assistantMsg.usage.input, assistantMsg.usage.cacheRead)
            console.log(
              `[prompt-cache] session=${sessionId} model=${assistantMsg.model} input=${assistantMsg.usage.input} `
              + `cache_read=${assistantMsg.usage.cacheRead} cache_write=${assistantMsg.usage.cacheWrite} `
              + `ratio=${ratio === null ? 'n/a' : ratio.toFixed(2)}`,
            )
          }

          // pi-agent-core swallows run failures (e.g. exhausted provider
          // retries) into a synthetic assistant message with empty text and
          // only `errorMessage`/`stopReason` set — the event sequence looks
          // like a clean turn. Without surfacing this, the user gets pure
          // silence (incident 2026-07-20, overnight empty turns).
          // Fork version kept: it is a superset of upstream's stopReason-only
          // check (also catches errorMessage-without-stopReason) and logs.
          const failure = assistantMsg as { stopReason?: string; errorMessage?: string }
          if (failure.errorMessage || failure.stopReason === 'error') {
            const errText = failure.errorMessage ?? 'Unknown model error'
            console.error(`[agent-runtime] Assistant message carries error (stopReason=${failure.stopReason ?? 'n/a'}, session ${sessionId}): ${errorTextClass(errText)}`)
            // Merge note: the TurnRunner's retry classifier
            // (isRetryableTurnError, upstream 0.27.0) needs the untouched
            // provider message; it gets it from the in-process `rawError`.
            // `error` and `text` are what leaves the process (client, error
            // row, logs) and carry a fixed text plus class only, because the
            // provider message can echo the prompt (review K0-K2-4 #2).
            // Review 2 / B: the MCP privacy gate's own fixed sentence (no remote
            // text) is shown as is, so the user learns why nothing was sent.
            const publicError = errText === MCP_PRIVATE_CONTEXT_ERROR ? MCP_PRIVATE_CONTEXT_ERROR : publicProviderError(errText)
            // http_400 incident 2026-11-12: a 4xx rejection gets a secret-free
            // structural record (status, provider error type, path, fixed
            // phrases, hash, sent window) in the log and on the error chunk,
            // which the runner persists with the turn_error row.
            const diagnostic = providerErrorDiagnostic(errText)
            if (diagnostic) {
              const window = this.lastSentStructure
              if (typeof window === 'string') diagnostic.window = window
              console.error(`[agent-runtime] Provider rejected the request (session ${sessionId}): ${formatProviderErrorDiagnostic(diagnostic)}`)
            }
            chunks.push(withRawError<ResponseChunk>({ type: 'error', error: publicError, text: `Modellfehler: ${publicError}`, ...(diagnostic ? { diagnostic } : {}) }, errText))
          }
        }
        break
      }

      case 'tool_execution_start': {
        // S1-B: ask_user arguments never leave the server as stream text, tool
        // row metadata or log input — only the question count does. The
        // payload reaches the client after validation as `interaction.open`.
        const toolArgs = event.toolName === ASK_USER_TOOL_NAME ? redactAskUserArgs(event.args) : event.args
        this.toolCallTimers.set(event.toolCallId, Date.now())
        this.toolCallArgs.set(event.toolCallId, toolArgs)
        chunks.push({
          type: 'tool_call_start',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolArgs,
        })
        break
      }

      case 'tool_execution_end': {
        const startTime = this.toolCallTimers.get(event.toolCallId) ?? Date.now()
        const durationMs = Date.now() - startTime
        const args = this.toolCallArgs.get(event.toolCallId) ?? {}
        this.toolCallTimers.delete(event.toolCallId)
        this.toolCallArgs.delete(event.toolCallId)

        // Log tool call
        logToolCall(this.db, {
          sessionId,
          toolName: event.toolName,
          input: JSON.stringify(args),
          output: JSON.stringify(event.result ?? {}),
          durationMs,
          // Strand statistics: the chat path used to log every tool call as
          // `success` (no status passed → token-logger default) although the
          // event carries `isError`; the error count was only recoverable
          // from chat_messages.metadata.toolIsError.
          status: event.isError ? 'error' : 'success',
        })

        chunks.push({
          type: 'tool_call_end',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          toolResult: event.result,
          toolIsError: event.isError,
        })
        break
      }

      case 'agent_end': {
        chunks.push({ type: 'done' })
        break
      }
    }

    return chunks
  }
}

export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntimeBoundary {
  return new PiAgentRuntime(options)
}

/**
 * Test-only handle on the runtime class (not re-exported from the package
 * index): lets the log-safety test drive the turn loop on a stand-in.
 */
export { PiAgentRuntime as PiAgentRuntimeForTests }

/** S1-D: a `message_start` that proves a model request reached the provider (not a local error/abort stub). */
function isSentAssistantStart(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as { role?: unknown; stopReason?: unknown }
  return m.role === 'assistant' && m.stopReason !== 'error' && m.stopReason !== 'aborted'
}
