/**
 * Sealing the output of a password-manager CLI at the tool boundary
 * (privacy plan 2026-09-26).
 *
 * The structural detector (`secret-detect.ts`) only recognises secrets with a
 * *shape* (`ghp_…`, PEM, JWT). A vault password has no shape: `bw get password
 * <id>` prints `Tr0ub4dor&3` and nothing in that string says "secret". The
 * known-value index (`secret-boundary.ts`) cannot help either, because the
 * value has never been seen before. Without this module the very first read of
 * a vault entry hands the plaintext to the model.
 *
 * So the boundary reasons about the *command* instead of the output: when a
 * `shell` call invokes the Bitwarden-compatible `bw` CLI, its output is
 * treated as secret-bearing by construction:
 *
 * - `bw export …` → the output is dropped entirely (a vault export is never
 *   context material).
 * - `bw get password|totp|notes|attachment …`, `bw unlock`, `bw login`,
 *   `bw generate`, and **any** invocation with `--raw` (that is how a session
 *   key is captured) → the whole trimmed output becomes ONE sealed secret.
 * - JSON output (`bw get item`, `bw list items`, `bw status`), whole or
 *   embedded → every field with secret semantics is sealed individually, with
 *   a speaking slug built from item name plus field.
 * - anything else from a `bw` invocation (piped through `jq`, `python`,
 *   reformatted, partially JSON) → **fail closed**: every line that is not on
 *   the narrow allowlist of harmless CLI status messages is replaced by the
 *   opaque handle. Item names and IDs are lost in that case; the documented
 *   remedy is to ask the CLI for the field directly instead of transforming
 *   its output.
 *
 * Sealed values land in the normal store, so from the second appearance on the
 * generic known-value redaction covers them too (`echo "$PW"`, `curl -u`).
 * The reverse direction works through the existing handle resolution: a
 * `{{secret:vw-…}}` handle in a later `shell` command is substituted with the
 * plaintext like any other handle.
 */

import { listSecrets, renameSecret, sealSecret } from './secret-store.js'

/** `kind` every value sealed by this module is filed under. */
export const VAULT_CLI_KIND = 'vaultwarden'

/** `source` shown in the secrets list for these handles. */
export const VAULT_CLI_SOURCE = 'vaultwarden'

/** Prefix of the generated slugs (`vw-router-login-password`). */
export const VAULT_SLUG_PREFIX = 'vw'

/** Opaque replacement, identical to `REDACTED_HANDLE` in secret-boundary.ts. */
export const VAULT_OPAQUE_HANDLE = '{{secret:redacted}}'

/** Text that replaces the output of a vault export. */
export const VAULT_EXPORT_NOTICE =
  '[secret boundary] The output of a password-manager export was removed. '
  + 'A vault export contains every credential in clear text and must never enter the model context. '
  + 'Write the export to a file with the CLI itself if you need it, and read single fields instead.'

/** Notice appended when the fail-closed line filter removed something. */
export const VAULT_UNPARSEABLE_NOTICE =
  '[secret boundary] This command invoked a password-manager CLI and its output was not machine-readable '
  + '(transformed or partially JSON). Every line that could carry a secret was redacted. '
  + 'Ask for one field directly (for example `get password <id>`) to receive a usable handle.'

function handleText(slug: string): string {
  return `{{secret:${slug}}}`
}

// ---------------------------------------------------------------------------
// Command analysis
// ---------------------------------------------------------------------------

/** Command names that only wrap another command. */
const WRAPPERS = new Set([
  'sudo', 'env', 'nohup', 'time', 'command', 'builtin', 'exec', 'stdbuf', 'nice', 'ionice', 'timeout',
])

/** Basenames that count as the vault CLI. */
const VAULT_CLI_NAMES = new Set(['bw', 'bw.exe'])

/**
 * `bw` subcommands whose plain output is a secret as a whole.
 * `unlock`/`login` print the session key, `generate` prints a fresh password.
 */
const SINGLE_SECRET_SUBCOMMANDS = new Set(['unlock', 'login', 'generate'])

/** Second word of `bw get <object>` that returns a bare secret. */
const SINGLE_SECRET_GET_OBJECTS = new Set(['password', 'totp', 'notes', 'attachment'])

export type VaultCliMode = 'export' | 'single' | 'structured'

export interface VaultCliPlan {
  /** True when at least one segment of the command runs the vault CLI. */
  invoked: boolean
  /** How the output must be handled; `structured` is the JSON/fail-closed path. */
  mode: VaultCliMode
  /** Short slug hint for the `single` mode, e.g. `password` or `session`. */
  slugHint: string
  /** Why the mode was chosen (for tests and for the notice text). */
  reason: string
}

/**
 * Split a command line into segments that each start with a command name.
 *
 * Quotes are deliberately **not** honoured: splitting a quoted `;` too often
 * can only produce *more* segments and therefore more detection, which is the
 * safe direction. Handles `export PATH=…; bw …`, `a && bw …`, `x | bw …`,
 * `$(bw …)`, backticks and newlines.
 */
function commandSegments(command: string): string[] {
  return command
    .split(/\$\(|[;\n\r|&()`{}]|&&|\|\|/)
    .map(segment => segment.trim())
    .filter(Boolean)
}

function stripQuotes(token: string): string {
  return token.replace(/^['"]|['"]$/g, '')
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean)
}

/** Basename without quotes, so `/data/bin/bw` and `"bw"` both resolve to `bw`. */
function basename(token: string): string {
  const clean = stripQuotes(token)
  const slash = clean.lastIndexOf('/')
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

/**
 * Arguments of every vault-CLI invocation in `command`.
 *
 * Returns one entry per invocation; an empty array means the command does not
 * call the CLI.
 */
function vaultInvocations(command: string): string[][] {
  const invocations: string[][] = []
  for (const segment of commandSegments(command)) {
    const tokens = tokenize(segment)
    let index = 0
    // Skip leading `VAR=value` assignments and wrapper commands.
    while (index < tokens.length) {
      const token = stripQuotes(tokens[index]!)
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index++; continue }
      const name = basename(token)
      if (WRAPPERS.has(name)) {
        index++
        // `timeout 30 bw …`, `nice -n 5 bw …`
        while (index < tokens.length && /^(-|\d)/.test(stripQuotes(tokens[index]!))) index++
        continue
      }
      break
    }
    if (index >= tokens.length) continue
    if (!VAULT_CLI_NAMES.has(basename(tokens[index]!))) continue
    invocations.push(tokens.slice(index + 1).map(stripQuotes))
  }
  return invocations
}

/**
 * Subcommands that identify a `bw` invocation in FREE TEXT (F4 of the review
 * triage 2026-09-26 19:25). The token walk above only sees the first word of a
 * segment, so `sh -c "bw get password x"`, `bash -c '…'`, `eval "…"` and
 * `echo id | xargs bw get item` all slipped through. This list is the full
 * command surface of the Bitwarden CLI.
 */
const VAULT_TEXT_SUBCOMMANDS = [
  'get', 'list', 'export', 'unlock', 'login', 'sync', 'serve', 'encode', 'config', 'status',
  'create', 'edit', 'generate', 'send', 'receive', 'move', 'restore', 'delete', 'confirm',
  'logout', 'lock',
] as const

/**
 * `bw <subcommand>` anywhere in the text, including inside quotes. The left
 * guard excludes identifier characters, `.`, `/` and `-`, so `bwrap`, `nbw`,
 * `bw-notes`, `/home/agent/bw/x` and `bw.py` do not match.
 */
const VAULT_TEXT_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_./-])bw\\s+(?=(?:${VAULT_TEXT_SUBCOMMANDS.join('|')})(?![A-Za-z0-9_-]))`,
  'g',
)

/** The npm package of the same CLI (`npx @bitwarden/cli get password …`). */
const VAULT_PACKAGE_RE = /@bitwarden\/cli(?:@[^\s"']+)?\s+/g

/**
 * Argument lists of every vault-CLI invocation the TEXT scan finds. Each match
 * contributes the rest of its command up to the next shell terminator, with
 * quotes stripped — enough for {@link classifyVaultCliCommand} to pick the mode.
 */
function textScanInvocations(command: string): string[][] {
  const found: string[][] = []
  for (const re of [VAULT_TEXT_RE, VAULT_PACKAGE_RE]) {
    for (const match of command.matchAll(re)) {
      const rest = command.slice((match.index ?? 0) + match[0].length)
      const head = rest.split(/[;\n\r|&`]|\$\(/)[0] ?? ''
      const args = tokenize(head).map(token => stripQuotes(token).replace(/["']/g, '')).filter(Boolean)
      if (args.length > 0) found.push(args)
    }
  }
  return found
}

/** Every invocation, from the token walk AND from the text scan. */
function allVaultInvocations(command: string): string[][] {
  return [...vaultInvocations(command), ...textScanInvocations(command)]
}

/** True when the command runs the vault CLI somewhere. */
export function commandInvokesVaultCli(command: string): boolean {
  return allVaultInvocations(command).length > 0
}

/** Decide how the output of `command` must be treated. */
export function classifyVaultCliCommand(command: string): VaultCliPlan {
  const invocations = allVaultInvocations(command)
  if (invocations.length === 0) {
    return { invoked: false, mode: 'structured', slugHint: '', reason: 'no-vault-cli' }
  }

  let plan: VaultCliPlan = { invoked: true, mode: 'structured', slugHint: 'output', reason: 'structured-output' }

  for (const args of invocations) {
    const positional = args.filter(arg => !arg.startsWith('-'))
    const subcommand = positional[0]?.toLowerCase() ?? ''

    if (subcommand === 'export') {
      return { invoked: true, mode: 'export', slugHint: 'export', reason: 'export' }
    }

    if (args.some(arg => arg === '--raw')) {
      plan = { invoked: true, mode: 'single', slugHint: subcommand === 'unlock' || subcommand === 'login' ? 'session' : (positional[1]?.toLowerCase() ?? subcommand ?? 'raw'), reason: 'raw-flag' }
      continue
    }
    if (SINGLE_SECRET_SUBCOMMANDS.has(subcommand)) {
      plan = { invoked: true, mode: 'single', slugHint: subcommand === 'generate' ? 'generated' : 'session', reason: `subcommand:${subcommand}` }
      continue
    }
    if (subcommand === 'get') {
      const object = positional[1]?.toLowerCase() ?? ''
      if (SINGLE_SECRET_GET_OBJECTS.has(object)) {
        plan = { invoked: true, mode: 'single', slugHint: object, reason: `get:${object}` }
        continue
      }
    }
  }

  return plan
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Build the wanted slug from the parts, e.g. `vw-router-login-password`. */
export function vaultSlug(...parts: (string | undefined)[]): string {
  const body = parts
    .map(part => (part ? slugify(part) : ''))
    .filter(Boolean)
    .join('-')
  const slug = `${VAULT_SLUG_PREFIX}-${body || 'secret'}`
  // Store slugs are limited to 64 characters.
  return slug.length <= 64 ? slug : slug.slice(0, 64).replace(/-+$/, '')
}

function freeSlug(wanted: string, taken: Set<string>): string {
  if (!taken.has(wanted)) return wanted
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`
    const base = wanted.length + suffix.length <= 64 ? wanted : wanted.slice(0, 64 - suffix.length).replace(/-+$/, '')
    const candidate = `${base}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return wanted
}

/**
 * Seal one vault value and return its handle text.
 *
 * Dedupe is the store's (SHA-256): sealing the same password twice returns the
 * first handle and does not create a second entry, so the slug of an existing
 * value wins over the speaking name of this call. Failure is fail-closed: the
 * opaque handle, never the plaintext.
 */
export function sealVaultValue(value: string, slugBase: string): string {
  try {
    const before = new Set(listSecrets().map(entry => entry.slug))
    let slug = sealSecret(value, VAULT_CLI_KIND, VAULT_CLI_SOURCE)
    if (!before.has(slug)) {
      const wanted = freeSlug(slugBase, new Set([...before, slug]))
      if (wanted !== slug) {
        renameSecret(slug, wanted)
        slug = wanted
      }
    }
    return handleText(slug)
  } catch (err) {
    console.error('[secret-vault-cli] Could not seal a vault value, redacting instead:', err)
    return VAULT_OPAQUE_HANDLE
  }
}

// ---------------------------------------------------------------------------
// JSON field sealing
// ---------------------------------------------------------------------------

/**
 * Field paths with secret semantics in a Bitwarden item.
 *
 * `fields[].value` is sealed only for `type: 1` (hidden); a visible custom
 * field is metadata the model may need. `passwordHistory[].password` is not in
 * the request list but is the same secret one revision older, so it is sealed
 * as well.
 */
const ITEM_SECRET_FIELDS: Record<string, readonly string[]> = {
  login: ['password', 'totp'],
  card: ['number', 'code'],
  identity: ['ssn', 'passportNumber', 'licenseNumber'],
  sshKey: ['privateKey'],
}

/** Key names that are sealed wherever they appear (jq-reshaped JSON, `bw status`). */
const ALWAYS_SECRET_KEYS = new Set(['password', 'totp', 'privatekey', 'ssn', 'passportnumber', 'licensenumber'])

type Json = unknown

interface JsonSealContext {
  seal: (value: string, slugBase: string) => string
  count: number
}

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sealString(ctx: JsonSealContext, value: Json, itemName: string, field: string): Json {
  if (typeof value !== 'string' || value.trim() === '') return value
  // Already a handle (second pass, or the model echoed one back).
  if (/^\{\{secret:[a-z0-9][a-z0-9-]*\}\}$/.test(value.trim())) return value
  ctx.count++
  return ctx.seal(value, vaultSlug(itemName, field))
}

function sealJsonNode(ctx: JsonSealContext, node: Json, itemName: string): Json {
  if (Array.isArray(node)) return node.map(entry => sealJsonNode(ctx, entry, itemName))
  if (!isPlainObject(node)) return node

  const name = typeof node.name === 'string' && node.name.trim() ? node.name : itemName
  const out: Record<string, Json> = {}

  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase()

    if (lower === 'notes') {
      out[key] = sealString(ctx, value, name, 'notes')
      continue
    }

    if (ITEM_SECRET_FIELDS[key] && isPlainObject(value)) {
      const section: Record<string, Json> = {}
      for (const [subKey, subValue] of Object.entries(value)) {
        section[subKey] = ITEM_SECRET_FIELDS[key]!.includes(subKey)
          ? sealString(ctx, subValue, name, `${key}-${subKey}`)
          : sealJsonNode(ctx, subValue, name)
      }
      out[key] = section
      continue
    }

    if (key === 'fields' && Array.isArray(value)) {
      out[key] = value.map(entry => {
        if (!isPlainObject(entry)) return sealJsonNode(ctx, entry, name)
        const hidden = entry.type === 1
        const fieldName = typeof entry.name === 'string' ? entry.name : 'field'
        return {
          ...entry,
          ...(hidden ? { value: sealString(ctx, entry.value, name, `${fieldName}-hidden`) } : {}),
        }
      })
      continue
    }

    if (key === 'passwordHistory' && Array.isArray(value)) {
      out[key] = value.map(entry =>
        isPlainObject(entry)
          ? { ...entry, password: sealString(ctx, entry.password, name, 'password-history') }
          : entry,
      )
      continue
    }

    if (ALWAYS_SECRET_KEYS.has(lower) && typeof value === 'string') {
      out[key] = sealString(ctx, value, name, lower)
      continue
    }

    out[key] = sealJsonNode(ctx, value, name)
  }

  return out
}

/** Find the end index (exclusive) of the JSON value starting at `start`. */
function matchJsonEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === open) depth++
    else if (char === close) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

interface Chunk {
  json: boolean
  text: string
}

/** Longest input this module tries to parse as JSON (shell output is capped anyway). */
const MAX_JSON_SCAN_LENGTH = 512 * 1024

/**
 * Split `text` into JSON and non-JSON chunks, sealing the secret fields of
 * every JSON chunk.
 */
function sealJsonChunks(text: string, seal: JsonSealContext['seal']): { chunks: Chunk[]; sealedCount: number; jsonCount: number } {
  const chunks: Chunk[] = []
  const ctx: JsonSealContext = { seal, count: 0 }
  let jsonCount = 0

  if (text.length > MAX_JSON_SCAN_LENGTH) {
    return { chunks: [{ json: false, text }], sealedCount: 0, jsonCount: 0 }
  }

  let cursor = 0
  let plainStart = 0
  while (cursor < text.length) {
    const char = text[cursor]
    if (char !== '{' && char !== '[') { cursor++; continue }
    const end = matchJsonEnd(text, cursor)
    if (end < 0) { cursor++; continue }
    const candidate = text.slice(cursor, end)
    let parsed: Json
    try {
      parsed = JSON.parse(candidate)
    } catch {
      cursor++
      continue
    }
    if (cursor > plainStart) chunks.push({ json: false, text: text.slice(plainStart, cursor) })
    const sealedNode = sealJsonNode(ctx, parsed, '')
    chunks.push({ json: true, text: JSON.stringify(sealedNode, null, 2) })
    jsonCount++
    cursor = end
    plainStart = end
  }
  if (plainStart < text.length) chunks.push({ json: false, text: text.slice(plainStart) })

  return { chunks, sealedCount: ctx.count, jsonCount }
}

// ---------------------------------------------------------------------------
// Fail-closed line filter
// ---------------------------------------------------------------------------

/**
 * Status lines of the CLI that are known to carry no secret. Everything else
 * in a non-JSON output is redacted — see the module docs for the trade-off.
 */
const HARMLESS_LINE_RES: RegExp[] = [
  /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/,
  /^You are (?:logged in|not logged in|already logged in)\b/i,
  /^You have logged out\b/i,
  /^Syncing complete\.?$/i,
  /^Saved setting\b/i,
  /^Your vault is (?:locked|unlocked)\b/i,
  /^Vault is (?:locked|unlocked)\b/i,
  /^More than one result was found\b/i,
  /^Not found\.?$/i,
  /^No.{0,40}found\.?$/i,
  /^(?:Username\/password|Email address|Master password|Two-step login|Session key) .{0,60}$/i,
  /^Invalid master password\.?$/i,
  /^An error has occurred\.?$/i,
  /^bw <command>/,
  /^Usage: bw\b/,
  /^…\[.*truncated.*\]…$/,
]

/** A line that only contains handles, whitespace and punctuation is already safe. */
function isOnlyHandles(line: string): boolean {
  const withoutHandles = line.replace(/\{\{secret:[a-z0-9][a-z0-9-]*\}\}/g, '')
  return /\{\{secret:/.test(line) && !/[A-Za-z0-9]/.test(withoutHandles)
}

function filterLinesFailClosed(text: string): { text: string; redacted: number } {
  let redacted = 0
  const lines = text.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (isOnlyHandles(trimmed)) return line
    if (HARMLESS_LINE_RES.some(re => re.test(trimmed))) return line
    redacted++
    return VAULT_OPAQUE_HANDLE
  })
  return { text: lines.join('\n'), redacted }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface SealVaultCliOptions {
  /** Injected for tests; defaults to {@link sealVaultValue}. */
  seal?: (value: string, slugBase: string) => string
  /**
   * Treat the text as an error message: only the fail-closed line filter runs,
   * nothing is written to the store. A thrown tool error is not vault content,
   * so sealing "command timed out" as a secret would only pollute the store —
   * but an error text can still quote a command line with a session key in it.
   */
  errorText?: boolean
}

/**
 * Seal the output of a `shell` call that invoked the vault CLI.
 *
 * Returns `text` unchanged when the command does not call the CLI, so a
 * command like `ls bw-notes` or `echo bw` is never touched.
 */
export function sealVaultCliOutput(text: string, command: string, options: SealVaultCliOptions = {}): string {
  if (!text) return text
  const plan = classifyVaultCliCommand(command)
  if (!plan.invoked) return text
  const seal = options.seal ?? sealVaultValue

  if (plan.mode === 'export') return VAULT_EXPORT_NOTICE

  if (options.errorText) {
    const filtered = filterLinesFailClosed(text)
    if (filtered.redacted === 0) return filtered.text
    return `${filtered.text.replace(/\s+$/, '')}\n${VAULT_UNPARSEABLE_NOTICE}`
  }

  if (plan.mode === 'single') {
    const trimmed = text.trim()
    if (!trimmed) return text
    return seal(trimmed, vaultSlug(plan.slugHint))
  }

  const { chunks, jsonCount } = sealJsonChunks(text, seal)

  // Pure JSON output (the common `bw get item` / `bw list items` case): the
  // reserialised document is returned, item names and IDs stay readable.
  if (jsonCount === 1 && chunks.length === 1) return chunks[0]!.text

  // Mixed or non-JSON output: JSON chunks keep their sealed form, everything
  // else runs through the fail-closed line filter.
  let redacted = 0
  const merged = chunks
    .map(chunk => {
      if (chunk.json) return chunk.text
      const filtered = filterLinesFailClosed(chunk.text)
      redacted += filtered.redacted
      return filtered.text
    })
    .join('')

  if (redacted === 0) return merged
  return `${merged.replace(/\s+$/, '')}\n${VAULT_UNPARSEABLE_NOTICE}`
}
