/**
 * The secret boundary (plan 2026-09-26, decisions D4/D5).
 *
 * Three pieces, all deterministic and LLM-free:
 * - {@link sealText}: detect secrets in a text, store them, replace them with
 *   `{{secret:<slug>}}` handles, then redact everything already known.
 * - {@link redactKnown}: replace every *known* secret value (handles,
 *   `secrets.json › env`, provider API keys, credential-looking process env
 *   vars) by its handle, or by `{{secret:redacted}}` when there is no handle.
 *   One combined, cached regex — see risk R4 (performance) in the plan.
 * - {@link withSecretBoundary}: wraps a tool list. `shell` gets handles
 *   resolved into a copy of the command (D5 — only `shell` resolves), every
 *   tool gets its result and error text sealed before the model sees it.
 *
 * Wiring these into the actual input paths is task T3; this module is the
 * library layer only.
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'
import fs from 'node:fs'
import path from 'node:path'
import { SECRET_HANDLE_MIN_VALUE_LENGTH } from './contracts/secrets.js'
import { getConfigDir } from './config.js'
import { detectSecrets, type SecretTier } from './secret-detect.js'
import { invalidateSecretFilesSignature, secretFileValues, secretFilesSignature } from './secret-files.js'
import { knownSecretValues, resolveSecret, sealSecret } from './secret-store.js'
import { commandInvokesVaultCli, sealVaultCliOutput } from './secret-vault-cli.js'
import { loadSecretsDecrypted } from './secrets-config.js'
import { loadProvidersDecrypted } from './provider-config.js'

/** Placeholder used when a known value has no handle of its own. */
export const REDACTED_HANDLE = '{{secret:redacted}}'

/** Build the handle text for a slug. */
export function secretHandle(slug: string): string {
  return `{{secret:${slug}}}`
}

/** Matches a handle in text, capturing the slug. */
export const SECRET_HANDLE_RE = /\{\{secret:([a-z0-9][a-z0-9-]{0,63})\}\}/g

export interface SealTextOptions {
  tier: SecretTier
  /** Provenance stored with new handles, e.g. `chat`, `tool:shell`. */
  source: string
}

export interface SealedRef {
  slug: string
  kind: string
}

export interface SealTextResult {
  text: string
  sealed: SealedRef[]
}

/**
 * Minimum length for a *known* value to be redacted.
 *
 * Short values would turn redaction into vandalism: a two-character env value
 * would match everywhere. F5 of the review triage (2026-09-26 19:25) raised the
 * handle floor from 4 to 6 — a 4-digit PIN in the store rewrote every date,
 * port and line number that happened to contain those digits, in every tool
 * output. Resolving a short value through its HANDLE is unaffected; only the
 * global search-and-replace stops at this length. Values harvested from the
 * environment need 8 characters, which is what decision D4 requires.
 */
const MIN_HANDLE_VALUE_LENGTH = SECRET_HANDLE_MIN_VALUE_LENGTH
const MIN_ENV_VALUE_LENGTH = 8

/** Env var names whose values count as known secrets (D4). */
const SECRET_ENV_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD/i

// ---------------------------------------------------------------------------
// Known-value index (cached)
// ---------------------------------------------------------------------------

interface KnownIndex {
  signature: string
  /** value → replacement text (handle or REDACTED_HANDLE) */
  replacements: Map<string, string>
  /** Combined alternation over all known values, longest first. */
  regex: RegExp | null
}

let _index: KnownIndex | null = null

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function statStamp(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return '-'
  }
}

/**
 * How long the `process.env` part of the signature is reused (F9 of the review
 * triage 2026-09-26 19:25).
 *
 * `sourceSignature()` runs on every `redactKnown()` call — every message, every
 * tool result and, since the task-channel fix seals the system prompt, every
 * `buildSystemPrompt()`. Measured with `scripts/bench-secret-boundary.mjs`, the
 * scan over all of `process.env` costs ~41 µs per call while both `stat`s
 * together cost ~3.5 µs, so the scan is the part worth caching.
 *
 * The two `stat`s deliberately stay live: a value sealed in one channel must be
 * redacted in every other channel *immediately*, and that shows up as a new
 * mtime on `secrets.json`. Env vars are set before the process starts, so a
 * runtime addition becoming effective after at most five seconds is a safe
 * trade — and {@link invalidateKnownValues} makes it immediate.
 */
export const KNOWN_ENV_SCAN_TTL_MS = 5_000

let envSignatureCache: { value: string; at: number } | null = null

/**
 * Monotonic milliseconds. `Date.now()` would be wrong here: a clock jump
 * backwards (NTP, a container resume) could freeze the cache.
 */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

/** Names and value lengths of the credential-ish env vars, throttled. */
function envSignature(): string {
  const now = monotonicNow()
  if (envSignatureCache && now - envSignatureCache.at < KNOWN_ENV_SCAN_TTL_MS) {
    return envSignatureCache.value
  }
  const parts: string[] = []
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) continue
    if (!SECRET_ENV_NAME_RE.test(name)) continue
    parts.push(`${name}=${value.length}`)
  }
  const signature = parts.join('|')
  envSignatureCache = { value: signature, at: now }
  return signature
}

/**
 * Cheap fingerprint of every source of known values, so a change anywhere
 * invalidates the combined regex without an explicit notification: two `stat`s
 * on every call plus the throttled scans over the env names
 * ({@link KNOWN_ENV_SCAN_TTL_MS}) and the secret files
 * (`SECRET_FILES_SIGNATURE_TTL_MS`).
 */
function sourceSignature(): string {
  const configDir = getConfigDir()
  return [
    statStamp(path.join(configDir, 'secrets.json')),
    statStamp(path.join(configDir, 'providers.json')),
    // Secret files (`<DATA_DIR>/secrets/*.env`, key files) — see secret-files.ts.
    secretFilesSignature(),
    envSignature(),
  ].join('|')
}

/**
 * Provider API keys, OAuth tokens and secret-ish extra fields, decrypted.
 *
 * Read straight from providers.json rather than from a running provider
 * service so redaction also works in tests and in one-shot scripts.
 */
function providerSecretValues(): string[] {
  const values: string[] = []
  try {
    const file = loadProvidersDecrypted()
    for (const provider of file.providers ?? []) {
      if (provider.apiKey) values.push(provider.apiKey)
      for (const extra of Object.values(provider.extraFields ?? {})) {
        if (typeof extra === 'string' && extra.length >= MIN_ENV_VALUE_LENGTH) values.push(extra)
      }
      const oauth = provider.oauthCredentials as Record<string, unknown> | undefined
      if (oauth) {
        for (const key of ['accessToken', 'refreshToken', 'idToken']) {
          const value = oauth[key]
          if (typeof value === 'string' && value.length >= MIN_ENV_VALUE_LENGTH) values.push(value)
        }
      }
    }
  } catch {
    // No providers.json / unreadable / undecryptable — redaction still works
    // for every other source.
  }
  return values
}

/** Drop the cached combined regex. */
export function invalidateKnownValues(): void {
  _index = null
  // F9: the file signature and the env scan are throttled to one pass per 5 s;
  // an explicit invalidation must be effective immediately, not after the
  // window.
  invalidateSecretFilesSignature()
  envSignatureCache = null
}

function buildIndex(): KnownIndex {
  const replacements = new Map<string, string>()

  // 1. Sealed handles — these have a slug, so the text keeps its meaning.
  for (const [value, slug] of knownSecretValues()) {
    if (value.length < MIN_HANDLE_VALUE_LENGTH) continue
    replacements.set(value, secretHandle(slug))
  }

  const addOpaque = (value: string | undefined): void => {
    if (!value || value.length < MIN_ENV_VALUE_LENGTH) return
    if (replacements.has(value)) return
    replacements.set(value, REDACTED_HANDLE)
  }

  // 2. secrets.json › env (the values injected into process.env at startup).
  try {
    for (const value of Object.values(loadSecretsDecrypted())) addOpaque(value)
  } catch {
    // unreadable secrets.json — other sources still apply
  }

  // 3. Provider API keys / OAuth tokens.
  for (const value of providerSecretValues()) addOpaque(value)

  // 3b. Values that only exist in files (`<DATA_DIR>/secrets/*.env`, key
  // files). Opaque on purpose: nothing is written to the store, so reading a
  // credentials file never creates a handle (maintainer request).
  try {
    for (const value of secretFileValues({ minLength: MIN_ENV_VALUE_LENGTH })) addOpaque(value)
  } catch (err) {
    console.error('[secret-boundary] Could not read the secret files directory:', err)
  }

  // 4. Process env vars whose NAME looks like a credential (D4).
  for (const [name, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_NAME_RE.test(name)) continue
    addOpaque(value)
  }

  const values = [...replacements.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b))
  const regex = values.length
    ? new RegExp(values.map(escapeRegExp).join('|'), 'g')
    : null

  return { signature: sourceSignature(), replacements, regex }
}

function getIndex(): KnownIndex {
  const signature = sourceSignature()
  if (_index && _index.signature === signature) return _index
  _index = buildIndex()
  // buildIndex computes the signature again after reading; keep the one we
  // measured before the read so a concurrent write is picked up next call.
  _index.signature = signature
  return _index
}

// ---------------------------------------------------------------------------
// Handles that are already in the text (report Integration, open point 2)
// ---------------------------------------------------------------------------

interface Range {
  start: number
  end: number
}

/**
 * Positions of every `{{secret:<slug>}}` handle in `text`, including the
 * anonymous {@link REDACTED_HANDLE} (its slug `redacted` matches the same
 * pattern).
 *
 * A handle is *output* of this module, never input to be sealed again. Both
 * {@link sealText} and {@link redactKnown} treat these ranges as untouchable,
 * which is what makes the boundary idempotent.
 */
function handleRanges(text: string): Range[] {
  if (!text.includes('{{secret:')) return []
  const ranges: Range[] = []
  SECRET_HANDLE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SECRET_HANDLE_RE.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/**
 * Blank out the handles, keeping every offset: the detector then runs over a
 * text of the same length in which no rule can see a slug. Spaces are the
 * neutral filler — every detector rule (and every known value) stops at
 * whitespace, so a masked handle can neither be read as a value nor glue two
 * halves of one together.
 */
function maskRanges(text: string, ranges: readonly Range[]): string {
  if (ranges.length === 0) return text
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + ' '.repeat(range.end - range.start)
    cursor = range.end
  }
  return out + text.slice(cursor)
}

function overlapsRange(ranges: readonly Range[], start: number, end: number): boolean {
  return ranges.some(range => start < range.end && end > range.start)
}

/**
 * Replace every known secret value in `text`.
 *
 * Deterministic: the same input always produces the same output, which keeps
 * the prompt cache stable when this runs as the last net before sending.
 *
 * Existing handles are skipped: a known value can be a substring of a slug
 * (someone files `password-1` as a value), and replacing inside a handle would
 * produce `{{secret:{{secret:…}}}}` instead of leaving the handle alone.
 */
export function redactKnown(text: string): string {
  if (!text) return text
  const index = getIndex()
  if (!index.regex) return text
  const ranges = handleRanges(text)
  if (ranges.length === 0) return replaceKnown(text, index)
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += replaceKnown(text.slice(cursor, range.start), index) + text.slice(range.start, range.end)
    cursor = range.end
  }
  return out + replaceKnown(text.slice(cursor), index)
}

function replaceKnown(text: string, index: KnownIndex): string {
  if (!text || !index.regex) return text
  index.regex.lastIndex = 0
  return text.replace(index.regex, match => index.replacements.get(match) ?? REDACTED_HANDLE)
}

/**
 * Detect secrets in `text`, store them and replace them with handles, then
 * redact everything else that is already known.
 */
export function sealText(text: string, options: SealTextOptions): SealTextResult {
  if (!text) return { text, sealed: [] }
  // Handles that are already in the text are masked before detection, so no
  // match can reach into one and no slug can be read as a value (report
  // Integration, open point 2). Offsets stay valid because the mask has the
  // same length; a span that still overlaps a handle (a multi-line rule such
  // as the PEM block could span the gap) is dropped instead of nested.
  const protectedRanges = handleRanges(text)
  const detectable = maskRanges(text, protectedRanges)
  const spans = detectSecrets(detectable, { tier: options.tier })
    .filter(span => !overlapsRange(protectedRanges, span.start, span.end))
  if (spans.length === 0) return { text: redactKnown(text), sealed: [] }

  const sealed: SealedRef[] = []
  const seen = new Set<string>()
  let out = ''
  let cursor = 0
  for (const span of spans) {
    const value = text.slice(span.start, span.end)
    // Fail closed: when the store cannot take the value (unwritable config
    // dir, broken key) the plaintext must still not survive — it is replaced
    // by the anonymous handle instead of being passed through.
    let replacement = REDACTED_HANDLE
    let slug: string | null = null
    try {
      slug = sealSecret(value, span.kind, options.source)
      replacement = secretHandle(slug)
    } catch (err) {
      console.error(`[secret-boundary] Could not seal a ${span.kind} (${options.source}), redacting instead:`, err)
    }
    out += text.slice(cursor, span.start) + replacement
    cursor = span.end
    if (slug && !seen.has(slug)) {
      seen.add(slug)
      sealed.push({ slug, kind: span.kind })
    }
  }
  out += text.slice(cursor)
  return { text: redactKnown(out), sealed }
}

/**
 * Replace `{{secret:<slug>}}` handles by their plaintext value.
 *
 * Only used for the `shell` command copy (D5). Unknown slugs are reported
 * instead of silently passed through, so a typo does not run a command with a
 * literal handle in it.
 */
export function resolveHandles(text: string): { text: string; unknown: string[] } {
  const unknown: string[] = []
  SECRET_HANDLE_RE.lastIndex = 0
  const resolved = text.replace(SECRET_HANDLE_RE, (match, slug: string) => {
    if (slug === 'redacted') {
      unknown.push(slug)
      return match
    }
    const value = resolveSecret(slug)
    if (value === null) {
      unknown.push(slug)
      return match
    }
    return value
  })
  return { text: resolved, unknown }
}

/**
 * Seal a text that goes into the system prompt (MEMORY.md, dailies, wiki
 * list, persona files). Structural rules only (`strong`), because a system
 * prompt is prose the user never typed as a credential.
 *
 * Deterministic: the same file content always yields the same output, so the
 * prompt prefix cache stays stable (plan risk R4).
 */
export function sealSystemText(text: string, source: string): string {
  if (!text) return text
  return sealText(text, { tier: 'strong', source: `system:${source}` }).text
}

/** Seal a tool result / error text: strong tier plus known-value redaction. */
export function sealToolText(text: string, toolName: string): string {
  if (!text) return text
  return sealText(text, { tier: 'strong', source: `tool:${toolName}` }).text
}

/**
 * Last net before a request leaves the process (plan step 4): run
 * {@link redactKnown} over every text part of every message.
 *
 * Pure view — the caller's `agent.state.messages` is not mutated; messages
 * without a hit are returned by reference so the common case allocates
 * nothing.
 */
export function redactMessages<T>(messages: readonly T[]): T[] {
  return messages.map(message => redactMessage(message))
}

function redactMessage<T>(message: T): T {
  const msg = message as unknown as { content?: unknown }
  const content = msg?.content
  if (typeof content === 'string') {
    const redacted = redactKnown(content)
    return redacted === content ? message : ({ ...(message as object), content: redacted } as T)
  }
  if (!Array.isArray(content)) return message

  let changed = false
  const parts = content.map(part => {
    if (!part || typeof part !== 'object') return part
    const typed = part as { type?: string; text?: unknown; thinking?: unknown }
    if ((typed.type === 'text' || typed.type === 'thinking') && typeof typed.text === 'string') {
      const redacted = redactKnown(typed.text)
      if (redacted === typed.text) return part
      changed = true
      return { ...typed, text: redacted }
    }
    if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
      const redacted = redactKnown(typed.thinking)
      if (redacted === typed.thinking) return part
      changed = true
      return { ...typed, thinking: redacted }
    }
    return part
  })
  return changed ? ({ ...(message as object), content: parts } as T) : message
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/**
 * Wrap a tool list with the secret boundary.
 *
 * - `shell`: `{{secret:<slug>}}` in `command` is resolved into a **copy** used
 *   for execution only. The arguments the runtime logs keep the handle. An
 *   unknown slug fails the tool call instead of executing a command with a
 *   literal handle.
 * - every tool: text content of the result and the message of a thrown error
 *   are sealed (tier `strong`) and known values are redacted before they reach
 *   the model or the tool_calls log.
 */
export function withSecretBoundary<T extends AgentTool>(tools: T[]): T[] {
  return tools.map(tool => {
    // The list is wrapped at every place that hands tools to a PiAgent, and
    // some of those places nest (a caller passes `options.tools` into a
    // runtime that wraps again). Wrapping twice would be correct but would
    // pay for detection twice per call, so an already-wrapped tool is
    // returned unchanged.
    if (wrappedTools.has(tool)) return tool
    const originalExecute = tool.execute.bind(tool)
    const wrapped: T = {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        let effectiveParams = params
        if (tool.name === 'shell') {
          const command = (params as { command?: unknown }).command
          if (typeof command === 'string' && command.includes('{{secret:')) {
            const { text, unknown } = resolveHandles(command)
            if (unknown.length > 0) {
              throw new Error(
                `Unknown secret handle(s): ${unknown.map(s => `{{secret:${s}}}`).join(', ')}. `
                + 'Use the handle exactly as it was shown, or ask for the secret to be stored first.',
              )
            }
            // Copy only — `params` (and with it the logged arguments) keeps
            // the handle.
            effectiveParams = { ...(params as object), command: text } as typeof params
          }
        }

        // A `shell` call that runs a password-manager CLI gets an extra pass:
        // its output is secret-bearing by construction, which no structural
        // rule can see (maintainer request).
        const vaultCommand =
          tool.name === 'shell'
          && typeof (params as { command?: unknown }).command === 'string'
          && commandInvokesVaultCli((params as { command: string }).command)
            ? (params as { command: string }).command
            : null

        try {
          const result = await originalExecute(toolCallId, effectiveParams, signal, onUpdate)
          if (!result || !Array.isArray(result.content)) return result
          return {
            ...result,
            content: result.content.map(part =>
              part.type === 'text'
                ? {
                    ...part,
                    text: sealToolText(
                      vaultCommand ? sealVaultCliOutput(part.text, vaultCommand) : part.text,
                      tool.name,
                    ),
                  }
                : part,
            ),
          }
        } catch (err) {
          const message = errorMessage(err)
          throw new Error(
            sealToolText(
              vaultCommand ? sealVaultCliOutput(message, vaultCommand, { errorText: true }) : message,
              tool.name,
            ),
          )
        }
      },
    }
    wrappedTools.add(wrapped)
    return wrapped
  })
}

/** Identity set of tools that already carry the boundary. */
const wrappedTools = new WeakSet<object>()

/** True when this exact tool object was produced by {@link withSecretBoundary}. */
export function hasSecretBoundary(tool: object): boolean {
  return wrappedTools.has(tool)
}
