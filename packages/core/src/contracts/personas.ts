/**
 * Persona contracts — shared types and validation for the personas API.
 * Used by both web-backend and web-frontend.
 */

/* ── Constants ── */

export const PERSONA_FILE_NAMES = [
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'AGENTS.md',
  'HEARTBEAT.md',
] as const

export type PersonaFileName = (typeof PERSONA_FILE_NAMES)[number]

export const PERSONA_FILE_KEYS = ['identity', 'soul', 'user', 'tools', 'agents', 'heartbeat'] as const
export type PersonaFileKey = (typeof PERSONA_FILE_KEYS)[number]

/** Maximum size of a single persona file in bytes (256 KB) */
export const PERSONA_FILE_MAX_BYTES = 262_144

/** Agent ID regex: lowercase alphanumeric + hyphens, 2-50 chars, starts with letter */
const AGENT_ID_REGEX = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/

/* ── Types ── */

export interface PersonaFilesContract {
  identity: string
  soul: string
  user: string
  tools: string
  agents: string
  heartbeat: string
}

/**
 * The structured fields of SPEC 13.3, as they cross the wire. Every field is
 * nullable because the markdown behind it is hand editable and may simply not
 * carry the value.
 */
export interface PersonaFieldsContract {
  name: string | null
  badge: string | null
  color: string | null
  role: string | null
  tone: string | null
  model: string | null
  subjects: string[]
  tools: string[]
}

export interface PersonaListItemContract {
  id: string
  hasTelegramBinding: boolean
  telegramBotName?: string
  fileCount: number
  /** SPEC 13.2: metadata that used to live in the client. */
  displayName: string
  color: string | null
  badge: string | null
  role: string | null
  isDefault: boolean
  archived: boolean
}

export interface PersonaDetailContract {
  id: string
  files: PersonaFilesContract
  hasTelegramBinding: boolean
  fields: PersonaFieldsContract
  displayName: string
  color: string | null
  badge: string | null
  isDefault: boolean
  archived: boolean
}

/** What a hard delete of a persona would remove (SPEC 13.5). */
export interface PersonaDeletePreviewContract {
  personaId: string
  strands: number
  messages: number
  tasks: number
  cronjobs: number
  facts: number
  captures: number
}

export interface CreatePersonaPayloadContract {
  id: string
  fields?: Partial<PersonaFieldsContract>
  files?: Partial<PersonaFilesContract>
}

export interface UpdatePersonaPayloadContract {
  /** Raw file contents ("advanced mode"). Applied BEFORE `fields`. */
  files?: Partial<PersonaFilesContract>
  /** Structured fields. Applied on top of `files`, so they win on conflict. */
  fields?: Partial<PersonaFieldsContract>
  archived?: boolean
  isDefault?: boolean
}

/* ── Validation helpers ── */

interface ParseSuccess<T> {
  ok: true
  value: T
}

interface ParseFailure {
  ok: false
  error: string
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure

/**
 * Parse and validate an agent ID.
 * 'main' is always valid. Otherwise must match AGENT_ID_REGEX.
 */
export function parseAgentId(id: unknown): ParseResult<string> {
  if (typeof id !== 'string' || !id) {
    return { ok: false, error: 'id must be a non-empty string' }
  }
  // Explicit first, even though the character class below already rejects
  // these: the id becomes a directory name under /data/agents, so a traversal
  // attempt deserves its own guard and its own test rather than relying on a
  // regex staying strict through future edits.
  if (id.includes('/') || id.includes('\\') || id.includes('.') || id.includes('\u0000')) {
    return { ok: false, error: 'id must not contain path separators, dots or null bytes' }
  }
  if (id === 'main') {
    return { ok: true, value: 'main' }
  }
  if (id.length < 2 || id.length > 50) {
    return { ok: false, error: 'id must be between 2 and 50 characters' }
  }
  if (!AGENT_ID_REGEX.test(id)) {
    return { ok: false, error: 'id must be lowercase alphanumeric (hyphens allowed, must start with a letter)' }
  }
  return { ok: true, value: id }
}

/**
 * Parse and validate persona file updates.
 * Each key must be a valid PersonaFileKey; each value must be a string
 * not exceeding PERSONA_FILE_MAX_BYTES.
 */
export function parsePersonaFiles(files: unknown): ParseResult<Partial<PersonaFilesContract>> {
  if (!files || typeof files !== 'object') {
    return { ok: false, error: 'files must be an object' }
  }

  const obj = files as Record<string, unknown>
  const result: Partial<PersonaFilesContract> = {}

  for (const [key, value] of Object.entries(obj)) {
    if (!(PERSONA_FILE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown file key: "${key}". Valid keys: ${PERSONA_FILE_KEYS.join(', ')}` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `files.${key} must be a string` }
    }
    if (Buffer.byteLength(value, 'utf-8') > PERSONA_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `files.${key} exceeds maximum size of ${PERSONA_FILE_MAX_BYTES} bytes (${Math.round(PERSONA_FILE_MAX_BYTES / 1024)} KB)`,
      }
    }
    result[key as PersonaFileKey] = value
  }

  return { ok: true, value: result }
}

/* ── Structured fields (SPEC 13.3) ── */

/** Limits, mirrored from persona-fields.ts so the contract stays standalone. */
export const PERSONA_FIELD_LIMITS = {
  name: 80,
  badge: 8,
  role: 280,
  tone: 280,
  model: 120,
  subject: 80,
  subjectCount: 30,
  tool: 80,
  toolCount: 60,
} as const

const PERSONA_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Control characters break a markdown line silently — a newline in a scalar
 * field would move the rest of the value onto a line the parser never reads
 * back, so it is rejected instead of stripped. Written as a code point scan
 * rather than a regex: a control character class in a literal is exactly the
 * thing the linter (rightly) flags as unreadable.
 */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function parseScalarField(
  value: unknown,
  label: string,
  max: number,
): ParseResult<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: `fields.${label} must be a string or null` }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  if (hasControlChars(trimmed)) {
    return { ok: false, error: `fields.${label} must not contain line breaks or control characters` }
  }
  if ([...trimmed].length > max) {
    return { ok: false, error: `fields.${label} must be at most ${max} characters` }
  }
  return { ok: true, value: trimmed }
}

function parseListField(
  value: unknown,
  label: string,
  maxItem: number,
  maxCount: number,
): ParseResult<string[]> {
  if (value === null || value === undefined) return { ok: true, value: [] }
  if (!Array.isArray(value)) return { ok: false, error: `fields.${label} must be an array of strings` }
  if (value.length > maxCount) {
    return { ok: false, error: `fields.${label} must have at most ${maxCount} entries` }
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') return { ok: false, error: `fields.${label} must contain strings only` }
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (hasControlChars(trimmed)) {
      return { ok: false, error: `fields.${label} entries must not contain line breaks or control characters` }
    }
    if ([...trimmed].length > maxItem) {
      return { ok: false, error: `fields.${label} entries must be at most ${maxItem} characters` }
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return { ok: true, value: out }
}

/**
 * Parse a structured-field patch. Keys that are absent stay absent in the
 * result, because "not mentioned" and "cleared" mean different things to the
 * markdown writer.
 */
export function parsePersonaFieldsPatch(input: unknown): ParseResult<Partial<PersonaFieldsContract>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'fields must be an object' }
  }
  const obj = input as Record<string, unknown>
  const known = ['name', 'badge', 'color', 'role', 'tone', 'model', 'subjects', 'tools']
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      return { ok: false, error: `Unknown field: "${key}". Valid fields: ${known.join(', ')}` }
    }
  }

  const out: Partial<PersonaFieldsContract> = {}

  for (const [key, max] of [
    ['name', PERSONA_FIELD_LIMITS.name],
    ['badge', PERSONA_FIELD_LIMITS.badge],
    ['role', PERSONA_FIELD_LIMITS.role],
    ['tone', PERSONA_FIELD_LIMITS.tone],
    ['model', PERSONA_FIELD_LIMITS.model],
  ] as const) {
    if (!(key in obj)) continue
    const parsed = parseScalarField(obj[key], key, max)
    if (!parsed.ok) return parsed
    out[key] = parsed.value
  }

  if ('color' in obj) {
    const parsed = parseScalarField(obj.color, 'color', 7)
    if (!parsed.ok) return parsed
    if (parsed.value !== null && !PERSONA_COLOR_RE.test(parsed.value)) {
      return { ok: false, error: 'fields.color must be a 6 digit hex colour like #4f8ef7' }
    }
    out.color = parsed.value ? parsed.value.toLowerCase() : null
  }

  if ('subjects' in obj) {
    const parsed = parseListField(obj.subjects, 'subjects', PERSONA_FIELD_LIMITS.subject, PERSONA_FIELD_LIMITS.subjectCount)
    if (!parsed.ok) return parsed
    out.subjects = parsed.value
  }
  if ('tools' in obj) {
    const parsed = parseListField(obj.tools, 'tools', PERSONA_FIELD_LIMITS.tool, PERSONA_FIELD_LIMITS.toolCount)
    if (!parsed.ok) return parsed
    out.tools = parsed.value
  }

  return { ok: true, value: out }
}

/**
 * Parse a create-persona request body. The id is mandatory and immutable from
 * that moment on (SPEC 13.5); everything else is the optional first version of
 * the structured fields.
 */
export function parseCreatePersonaPayload(body: unknown): ParseResult<CreatePersonaPayloadContract> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object with an "id" field' }
  }
  const obj = body as Record<string, unknown>
  const idResult = parseAgentId(obj.id)
  if (!idResult.ok) return idResult

  const value: CreatePersonaPayloadContract = { id: idResult.value }

  if (obj.fields !== undefined) {
    const parsed = parsePersonaFieldsPatch(obj.fields)
    if (!parsed.ok) return parsed
    value.fields = parsed.value
  }
  if (obj.files !== undefined) {
    const parsed = parsePersonaFiles(obj.files)
    if (!parsed.ok) return parsed
    value.files = parsed.value
  }

  return { ok: true, value }
}

/**
 * Parse an update-persona request body. At least one of `files`, `fields`,
 * `archived` or `isDefault` must be present — an empty PUT is a client bug,
 * not a no-op worth writing files for.
 */
export function parseUpdatePersonaPayload(body: unknown): ParseResult<UpdatePersonaPayloadContract> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Request body must be an object' }
  }
  const obj = body as Record<string, unknown>
  const value: UpdatePersonaPayloadContract = {}

  if (obj.files !== undefined) {
    const filesResult = parsePersonaFiles(obj.files)
    if (!filesResult.ok) return filesResult
    value.files = filesResult.value
  }
  if (obj.fields !== undefined) {
    const fieldsResult = parsePersonaFieldsPatch(obj.fields)
    if (!fieldsResult.ok) return fieldsResult
    value.fields = fieldsResult.value
  }
  if (obj.archived !== undefined) {
    if (typeof obj.archived !== 'boolean') return { ok: false, error: 'archived must be a boolean' }
    value.archived = obj.archived
  }
  if (obj.isDefault !== undefined) {
    if (typeof obj.isDefault !== 'boolean') return { ok: false, error: 'isDefault must be a boolean' }
    value.isDefault = obj.isDefault
  }

  if (Object.keys(value).length === 0) {
    return { ok: false, error: 'Request body must include at least one of "files", "fields", "archived", "isDefault"' }
  }

  return { ok: true, value }
}
