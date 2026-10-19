/**
 * Lean local worker profile (plan 2026-10-18-lokale-worker, B2).
 *
 * A background task that runs on a LOCAL model (Ollama on a local GPU host) as
 * a tool of the cloud orchestrator: it reads private raw data itself and hands
 * back only a schema-validated result (same pattern as `ask_connector`).
 *
 * Why a separate profile instead of trimming the normal task prompt:
 * - The normal task envelope costs ~13.3k input tokens on qwen3.8 before the
 *   first tool call (measured B1: 2.8k system prompt, 10.2k for 33 tool
 *   schemas). Prefill of that on a 27B local model is the dominant latency.
 * - The task prompt sits at the TOP of the normal system prompt, and the
 *   Qwen chat template renders the tool block AFTER the system text. So two
 *   tasks share no prompt prefix at all, and the (snapfix) prefix cache can
 *   never reuse the expensive tool block across tasks.
 *
 * The lean profile therefore:
 * - uses ONE byte-identical system prompt for every lean task (no task text,
 *   no paths, no budget minutes, no timestamps, no AGENTS.md / TASKS.md, no
 *   MEMORY.md reference, no skills list),
 * - sends a fixed tool whitelist in a fixed order (same bytes every time),
 * - moves everything task-specific (brief, output schema, budget) into the
 *   FIRST USER MESSAGE, after the cacheable prefix,
 * - requires an output_schema and validates it (no reviewer round, the schema
 *   is the check — and the reviewer could be a cloud provider),
 * - never sends `num_ctx` (no per-request window that could force a reload),
 * - refuses to start on a non-local provider instead of falling back.
 */
import { PROVIDER_TYPE_PRESETS, buildModel, resolveEffectiveBaseUrl } from './provider-config.js'
import type { ProviderConfig } from './provider-config.js'
import { Check, Errors } from 'typebox/value'
import { Compile } from 'typebox/schema'
import { parseOutputSchema } from './task-output-schema.js'

export const LEAN_LOCAL_PROFILE = 'lean_local' as const
export type WorkerProfile = typeof LEAN_LOCAL_PROFILE

/**
 * Tools a lean worker may use, in the order they are sent. Read-mostly on
 * purpose: the worker extracts from private data, it does not act on it.
 * `shell` stays for grep/jq/pdftotext style extraction on workspace files.
 */
export const LEAN_TOOL_WHITELIST: readonly string[] = ['read_file', 'list_files', 'shell', 'email_list', 'email_read']

export function normalizeWorkerProfile(value: unknown): WorkerProfile | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase().replace(/-/g, '_')
  return v === LEAN_LOCAL_PROFILE ? LEAN_LOCAL_PROFILE : null
}

/**
 * Parse a user-supplied profile name. `undefined`/empty → no profile;
 * an unknown name is an error (never silently ignored).
 */
export function parseWorkerProfileInput(value: unknown): { ok: true; profile: WorkerProfile | null } | { ok: false; error: string } {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { ok: true, profile: null }
  const profile = normalizeWorkerProfile(value)
  if (!profile) return { ok: false, error: `Error: worker_profile must be "${LEAN_LOCAL_PROFILE}" (got "${String(value)}").` }
  return { ok: true, profile }
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local|host\.docker\.internal)$/i

function isLocalUrl(raw: string | null | undefined): boolean {
  const url = (raw ?? '').trim()
  if (!url) return false
  try {
    return LOCAL_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * A provider counts as local when the endpoint requests ACTUALLY go to is a
 * loopback or private-network host. The provider type alone is not enough
 * (an Ollama provider can point at a hosted endpoint), and neither is the
 * configured base URL: the runtime resolves the effective endpoint in
 * `buildModel` (OAuth/catalog presets take the vendor URL from the pi-ai
 * catalog or the resolved request auth, fixed-URL presets ignore a stored
 * URL — e.g. a Codex provider with a stored `http://localhost` base URL
 * still talks to chatgpt.com). So:
 * - OAuth/subscription and catalog-routed presets are never local (their
 *   transport is the vendor's, whatever the stored URL says),
 * - the configured URL, the preset-resolved URL and the URL of the model
 *   `buildModel` produces must ALL be local.
 * Fails closed: no URL, unparsable URL, unknown resolution → not local.
 */
export function isLocalProvider(provider: Pick<ProviderConfig, 'providerType' | 'baseUrl'> | null | undefined, modelId?: string): boolean {
  if (!provider) return false
  const preset = PROVIDER_TYPE_PRESETS[provider.providerType]
  if (preset && (preset.authMethod === 'oauth' || preset.resolveModelsFromCatalog)) return false
  if (!isLocalUrl(provider.baseUrl)) return false
  if (!isLocalUrl(resolveEffectiveBaseUrl(provider.providerType, provider.baseUrl))) return false
  let effective: string | undefined
  try {
    effective = buildModel(provider as ProviderConfig, modelId).baseUrl
  } catch {
    return false
  }
  return isLocalUrl(effective)
}

/**
 * The one system prompt of every lean task. MUST stay free of anything
 * per-task or per-run (paths, dates, budgets, ids): its bytes are the prompt
 * prefix the local server caches. Change it deliberately, never dynamically.
 */
export const LEAN_SYSTEM_PROMPT = `You are a local extraction worker. A coordinating agent gave you one bounded job in the first user message. You run on a local model to keep this job small and fast; your final answer goes back to the coordinating agent.

Rules:
- Do exactly the job in the brief. No side quests, no extra files, no network unless the brief asks for it.
- Use the tools only to read the data the brief names. Prefer one precise call over many broad ones.
- Never invent values. If a value is missing or unreadable, say so in the field the schema provides, or use null where the schema allows it.
- Copy numbers, dates, names and ids exactly as they appear in the source.
- Keep tool output small: read only the part you need (line ranges, grep, head).
- When a <time_budget_warning> arrives, stop and answer with what you have.

Final answer format, exactly:

STATUS: completed | failed | question
SUMMARY:
\`\`\`json
<one JSON object that satisfies the output schema from the brief>
\`\`\`

No text outside this format. STATUS: question only if the job is impossible without one missing fact; then the SUMMARY is that one question. STATUS: failed if the data cannot be read; then the SUMMARY explains why in one sentence.`

/**
 * First user message of a lean task: everything task-specific, AFTER the
 * cacheable prefix (system prompt + tool block).
 */
export function buildLeanKickoff(input: { taskPrompt: string; serializedSchema: string; budgetMinutes?: number | null; workspaceDir: string }): string {
  const budget = input.budgetMinutes && input.budgetMinutes > 0 ? `${input.budgetMinutes} minutes` : 'limited'
  return `<brief>
${input.taskPrompt}
</brief>

<output_schema>
Your SUMMARY must be exactly one JSON object that satisfies this JSON Schema, inside a \`\`\`json fence.

${input.serializedSchema}
</output_schema>

Working directory: ${input.workspaceDir}. Time budget: ${budget}.`
}

/** Filter + order the tools for a lean task: whitelist order, unknown names dropped. */
export function selectLeanTools<T extends { name: string }>(tools: readonly T[], whitelist: readonly string[] = LEAN_TOOL_WHITELIST): T[] {
  const byName = new Map(tools.map(t => [t.name, t]))
  const out: T[] = []
  for (const name of whitelist) {
    const tool = byName.get(name)
    if (tool) out.push(tool)
  }
  return out
}

/**
 * Supported output_schema dialect of a lean_local task (P1, review of 7665793f).
 *
 * A JSON Schema subset, described below as a meta-schema and checked with the
 * same TypeBox validator that later checks the result. Anything outside it is
 * refused before the model runs (creation, start, recovery and the re-read
 * before a result is accepted); there is no fallback to "accept unchecked".
 *
 * Supported keywords on every (sub)schema:
 * - `type`: "object" | "array" | "string" | "number" | "integer" | "boolean" |
 *   "null", or a non-empty array of those
 * - objects: `properties` (map of subschemas), `required` (string array),
 *   `additionalProperties` (boolean or subschema), `minProperties`, `maxProperties`
 * - arrays: `items` (ONE subschema, no tuple form), `minItems`, `maxItems`, `uniqueItems`
 * - strings: `minLength`, `maxLength`, `pattern` (must compile as a `u` RegExp),
 *   `format` (date, date-time, time, email, uri, uuid, ipv4, ipv6, hostname)
 * - numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`
 *   (numeric form), `multipleOf` (> 0)
 * - any: `enum` (non-empty array), `const`, `anyOf` / `oneOf` / `allOf`
 *   (non-empty arrays of subschemas)
 * - annotations: `title`, `description`, `$comment`, `$schema`, `default`, `examples`
 *
 * Not supported (refused): `$ref` / `$defs` / `definitions`, `not`, `if`/`then`/`else`,
 * `patternProperties`, `prefixItems`, `dependent*`, `unevaluated*`, unknown
 * keywords and unknown formats. The root must be an object schema (see
 * parseOutputSchema). Normal tasks keep the permissive parseOutputSchema.
 */
const LEAN_SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const LEAN_SCHEMA_FORMATS = ['date', 'date-time', 'time', 'email', 'uri', 'uuid', 'ipv4', 'ipv6', 'hostname']
const LEAN_NODE_REF = { $ref: '#/$defs/node' }
const LEAN_COUNT = { type: 'integer', minimum: 0 }
const LEAN_SUBSCHEMA_LIST = { type: 'array', minItems: 1, items: LEAN_NODE_REF }
export const LEAN_OUTPUT_SCHEMA_DIALECT: Record<string, unknown> = {
  $defs: {
    node: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { anyOf: [{ enum: LEAN_SCHEMA_TYPES }, { type: 'array', minItems: 1, uniqueItems: true, items: { enum: LEAN_SCHEMA_TYPES } }] },
        properties: { type: 'object', additionalProperties: LEAN_NODE_REF },
        required: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        additionalProperties: { anyOf: [{ type: 'boolean' }, LEAN_NODE_REF] },
        minProperties: LEAN_COUNT,
        maxProperties: LEAN_COUNT,
        items: LEAN_NODE_REF,
        minItems: LEAN_COUNT,
        maxItems: LEAN_COUNT,
        uniqueItems: { type: 'boolean' },
        minLength: LEAN_COUNT,
        maxLength: LEAN_COUNT,
        pattern: { type: 'string' },
        format: { enum: LEAN_SCHEMA_FORMATS },
        minimum: { type: 'number' },
        maximum: { type: 'number' },
        exclusiveMinimum: { type: 'number' },
        exclusiveMaximum: { type: 'number' },
        multipleOf: { type: 'number', exclusiveMinimum: 0 },
        enum: { type: 'array', minItems: 1 },
        const: {},
        anyOf: LEAN_SUBSCHEMA_LIST,
        oneOf: LEAN_SUBSCHEMA_LIST,
        allOf: LEAN_SUBSCHEMA_LIST,
        title: { type: 'string' },
        description: { type: 'string' },
        $comment: { type: 'string' },
        $schema: { type: 'string' },
        default: {},
        examples: { type: 'array' },
      },
    },
  },
  ...LEAN_NODE_REF,
}

/**
 * Parse an output_schema for a lean_local task: the generic parse (JSON,
 * object root, size), then the dialect meta-schema, then a compile with the
 * TypeBox schema engine that validates results (compiles every `pattern`
 * eagerly, so an unusable regex is refused here and not after model rounds).
 */
export function parseLeanOutputSchema(raw: unknown): { ok: true; schema: Record<string, unknown>; serialized: string } | { ok: false; error: string } {
  const parsed = parseOutputSchema(raw)
  if (!parsed.ok) return parsed
  if (!Check(LEAN_OUTPUT_SCHEMA_DIALECT, parsed.schema)) {
    const errors: string[] = []
    for (const e of Errors(LEAN_OUTPUT_SCHEMA_DIALECT, parsed.schema)) {
      const err = e as { instancePath?: string; message?: string }
      errors.push(`${err.instancePath || '/'}: ${err.message ?? 'invalid'}`)
      if (errors.length >= 3) break
    }
    return { ok: false, error: `output_schema is outside the supported ${LEAN_LOCAL_PROFILE} schema dialect (${errors.join('; ') || 'invalid'})` }
  }
  try {
    Compile(parsed.schema)
  } catch (err) {
    return { ok: false, error: `output_schema cannot be evaluated: ${err instanceof Error ? err.message : String(err)}` }
  }
  return parsed
}

/**
 * Pre-flight for a lean task. Returns an error text when the task must not
 * run as a lean worker. No fallback: the caller fails the task with it.
 */
export function checkLeanPreconditions(input: { provider: Pick<ProviderConfig, 'providerType' | 'baseUrl' | 'name'> | null; outputSchema: string | null }): string | null {
  if (!input.outputSchema || input.outputSchema.trim() === '') {
    return `worker_profile "${LEAN_LOCAL_PROFILE}" requires an output_schema`
  }
  // Fail closed on a schema that cannot be used (also a corrupted row on
  // recovery): a lean result is only accepted when it was validated against
  // a schema of the supported dialect.
  const parsedSchema = parseLeanOutputSchema(input.outputSchema)
  if (!parsedSchema.ok) {
    return `worker_profile "${LEAN_LOCAL_PROFILE}" requires a usable output_schema (${parsedSchema.error})`
  }
  if (!isLocalProvider(input.provider)) {
    return `worker_profile "${LEAN_LOCAL_PROFILE}" requires a local provider (got "${input.provider?.name ?? 'none'}"); no cloud fallback`
  }
  return null
}

/**
 * Upper bound for every lean result that is NOT a validated success (failed,
 * question, silent, error and abort texts, handoff records). The orchestrator
 * reads these rows; a local worker must not be able to flood its context.
 */
export const LEAN_NON_SUCCESS_MAX_CHARS = 2000

/**
 * Cap a lean non-success text to `max` characters. Keeps the head (a question
 * or the cause comes first) and states how much was cut, so the result stays
 * readable and honest. Short texts are returned unchanged.
 */
export function compactLeanText(text: string, max: number = LEAN_NON_SUCCESS_MAX_CHARS): string {
  if (text.length <= max) return text
  const marker = (cut: number) => `\n[… ${cut} characters cut (lean_local result limit ${max})]`
  let keep = max - marker(text.length).length
  if (keep < 0) keep = 0
  return text.slice(0, keep) + marker(text.length - keep)
}
