/**
 * persona-fields.ts: the structured view of a persona's markdown files
 * (SPEC 13.3). Nobody edits a 200 line SOUL.md on a phone, so the editor
 * offers fields — but the files stay the source of truth, because the agent
 * runtime reads them and a user may have written anything into them by hand.
 *
 * The rules that make this safe:
 *
 * 1. **Never rewrite a file wholesale.** A scalar field lives on one
 *    `- **Label:** value` line in IDENTITY.md. Writing it replaces THAT line
 *    and nothing else, keeping whatever label the file already used
 *    (`Creature:` and `Vibe:` in the personas that exist today, `Wesen:` in
 *    the German template). Only a field that appears nowhere is inserted.
 * 2. **List fields own a delimited block.** Subjects and tools are multi line,
 *    so they get an HTML comment fence. Everything outside the fence survives
 *    untouched, and a second write replaces the block instead of appending a
 *    copy.
 * 3. **Parsing is total.** Every field is optional and anything unparseable
 *    reads as `null`/`[]` — these files are hand edited markdown, not a
 *    schema, and a missing field must never be an error.
 *
 * Together this gives the round trip the editor needs: parse → edit → write
 * loses no prose, and writing back what was parsed leaves the file byte
 * identical.
 */

/** The structured fields the editor of SPEC 13.3 offers. */
export interface PersonaFields {
  /** Display name. Also mirrored into the persona record. */
  name: string | null
  /** A single character or emoji — the badge the clients render. */
  badge: string | null
  /** 6 digit hex, lowercase. */
  color: string | null
  /** Role in one sentence: the load bearing field (router + handover card). */
  role: string | null
  /** Tone, free text ("short, no small talk"). */
  tone: string | null
  /** Model override; empty means the global default (chapter 5). */
  model: string | null
  /** Subjects this persona owns. Short phrases. */
  subjects: string[]
  /** Tool names this persona may use. Empty means "the configured default". */
  tools: string[]
}

/** A patch from the editor: an absent key means "leave as is". */
export type PersonaFieldsPatch = Partial<PersonaFields>

/** The two files the structured fields touch. */
export interface PersonaFieldFiles {
  identity: string
  tools: string
}

export const EMPTY_PERSONA_FIELDS: PersonaFields = {
  name: null,
  badge: null,
  color: null,
  role: null,
  tone: null,
  model: null,
  subjects: [],
  tools: [],
}

/**
 * Label aliases per field, most canonical first. The FIRST entry is what a
 * fresh insert writes; the rest are recognised so the files that exist today
 * (`Creature:`, `Vibe:`) and the German template (`Wesen:`, `Stil:`) keep
 * working without a rewrite.
 */
const FIELD_LABELS: Record<'name' | 'badge' | 'color' | 'role' | 'tone' | 'model', string[]> = {
  name: ['Name', 'Nickname'],
  badge: ['Emoji', 'Badge'],
  color: ['Color', 'Colour', 'Farbe'],
  role: ['Role', 'Creature', 'Rolle', 'Wesen'],
  tone: ['Tone', 'Vibe', 'Ton', 'Stil'],
  model: ['Model', 'Modell'],
}

/** Values the templates use for "not set" — they must read as absent. */
const PLACEHOLDERS = new Set(['—', '–', '-', '', 'n/a', 'none', 'keine', 'tbd'])

/** Upper bounds. Long enough for real values, short enough to stay a field. */
export const PERSONA_NAME_MAX = 80
export const PERSONA_BADGE_MAX = 8
export const PERSONA_ROLE_MAX = 280
export const PERSONA_TONE_MAX = 280
export const PERSONA_MODEL_MAX = 120
export const PERSONA_SUBJECT_MAX = 80
export const PERSONA_SUBJECTS_MAX_COUNT = 30
export const PERSONA_TOOL_MAX = 80
export const PERSONA_TOOLS_MAX_COUNT = 60

export const PERSONA_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/* ── Block fences ── */

const SUBJECTS_BLOCK = 'offtangent:subjects'
const TOOLS_BLOCK = 'offtangent:tools'

function blockStart(name: string): string {
  return `<!-- ${name}:start -->`
}

function blockEnd(name: string): string {
  return `<!-- ${name}:end -->`
}

/* ── Scalar line parsing ── */

/**
 * Build the matcher for one `- **Label:** value` line. Horizontal whitespace
 * only (`[ \t]`, never `\s`): `\s` crosses the line break and would read the
 * NEXT line's text into an empty field — the same trap the client projection
 * documents.
 */
function labelPattern(label: string): RegExp {
  return new RegExp(`^([ \\t]*[-*][ \\t]*\\*\\*[ \\t]*${label}[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?[ \\t]*)(.*)$`, 'i')
}

function cleanValue(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  if (PLACEHOLDERS.has(value.toLowerCase())) return null
  return value
}

/** Read the first line that carries any alias of this field. */
function readScalar(content: string, labels: string[]): string | null {
  const lines = content.split('\n')
  for (const label of labels) {
    const pattern = labelPattern(label)
    for (const line of lines) {
      const match = pattern.exec(line)
      if (!match) continue
      const value = cleanValue(match[2])
      if (value !== null) return value
    }
  }
  return null
}

/**
 * Write a scalar field. Replaces the value on the first line carrying any
 * alias (keeping that line's label and indentation), otherwise inserts a new
 * line after the last bullet of the leading bullet block — which is where the
 * other fields live in every persona file we ship.
 *
 * `null` clears the field: the line is dropped if it exists, nothing is added
 * if it does not.
 */
function writeScalar(content: string, labels: string[], value: string | null): string {
  const lines = content.split('\n')

  for (const label of labels) {
    const pattern = labelPattern(label)
    for (let i = 0; i < lines.length; i++) {
      const match = pattern.exec(lines[i] as string)
      if (!match) continue
      if (value === null) {
        lines.splice(i, 1)
        return lines.join('\n')
      }
      lines[i] = `${match[1]}${value}`
      return lines.join('\n')
    }
  }

  if (value === null) return content

  const newLine = `- **${labels[0]}:** ${value}`
  const bulletPattern = /^[ \t]*[-*][ \t]/
  let lastBullet = -1
  for (let i = 0; i < lines.length; i++) {
    if (bulletPattern.test(lines[i] as string)) lastBullet = i
    else if (lastBullet >= 0 && (lines[i] as string).trim() === '') continue
    else if (lastBullet >= 0) break
  }
  if (lastBullet >= 0) {
    lines.splice(lastBullet + 1, 0, newLine)
    return lines.join('\n')
  }

  // No bullet list yet: place the field after the heading, else at the top.
  const headingIndex = lines.findIndex(line => line.startsWith('#'))
  if (headingIndex >= 0) {
    lines.splice(headingIndex + 1, 0, '', newLine)
    return lines.join('\n')
  }
  return `${newLine}\n${content}`
}

/* ── Delimited list blocks ── */

function readBlock(content: string, blockName: string): string | null {
  const start = content.indexOf(blockStart(blockName))
  if (start < 0) return null
  const endMarker = blockEnd(blockName)
  const end = content.indexOf(endMarker, start)
  if (end < 0) return null
  return content.slice(start + blockStart(blockName).length, end)
}

/** Bullet items of a fenced block, trimmed and free of empty entries. */
function readList(content: string, blockName: string): string[] {
  const body = readBlock(content, blockName)
  if (body === null) return []
  const items: string[] = []
  for (const line of body.split('\n')) {
    const match = /^[ \t]*[-*][ \t]+(.*)$/.exec(line)
    if (!match) continue
    const value = cleanValue(match[1])
    if (value !== null) items.push(value)
  }
  return items
}

/**
 * Replace (or create, or drop) a fenced list block. An empty list removes the
 * block entirely, so a persona that owns no subject does not carry an empty
 * heading around.
 */
function writeList(content: string, blockName: string, heading: string, items: string[]): string {
  const start = content.indexOf(blockStart(blockName))
  const endMarker = blockEnd(blockName)
  const rendered = items.length === 0
    ? ''
    : `${blockStart(blockName)}\n\n## ${heading}\n\n${items.map(i => `- ${i}`).join('\n')}\n\n${endMarker}`

  if (start >= 0) {
    const end = content.indexOf(endMarker, start)
    if (end >= 0) {
      const before = content.slice(0, start)
      const after = content.slice(end + endMarker.length)
      if (rendered === '') {
        // Collapse the blank lines the removed block leaves behind.
        return `${before.replace(/\n{2,}$/, '\n\n')}${after.replace(/^\n+/, '')}`.replace(/\n{3,}/g, '\n\n')
      }
      return `${before}${rendered}${after}`
    }
  }

  if (rendered === '') return content
  const base = content.endsWith('\n') ? content : `${content}\n`
  return `${base}\n${rendered}\n`
}

/* ── Public API ── */

/** Read the structured view of a persona's files. Never throws. */
export function parsePersonaFields(files: PersonaFieldFiles): PersonaFields {
  const identity = files.identity ?? ''
  const tools = files.tools ?? ''
  const color = readScalar(identity, FIELD_LABELS.color)
  const badge = readScalar(identity, FIELD_LABELS.badge)
  return {
    name: readScalar(identity, FIELD_LABELS.name),
    badge: badge && [...badge].length <= PERSONA_BADGE_MAX ? badge : null,
    color: color && PERSONA_COLOR_PATTERN.test(color) ? color.toLowerCase() : null,
    role: readScalar(identity, FIELD_LABELS.role),
    tone: readScalar(identity, FIELD_LABELS.tone),
    model: readScalar(identity, FIELD_LABELS.model),
    subjects: readList(identity, SUBJECTS_BLOCK),
    tools: readList(tools, TOOLS_BLOCK),
  }
}

/**
 * Apply a field patch to the files. Only the keys present in the patch are
 * touched; everything else in the markdown — prose, extra bullets, hand
 * written sections — is carried over unchanged.
 */
export function applyPersonaFields(files: PersonaFieldFiles, patch: PersonaFieldsPatch): PersonaFieldFiles {
  let identity = files.identity ?? ''
  let toolsFile = files.tools ?? ''

  if ('name' in patch) identity = writeScalar(identity, FIELD_LABELS.name, patch.name ?? null)
  if ('badge' in patch) identity = writeScalar(identity, FIELD_LABELS.badge, patch.badge ?? null)
  if ('color' in patch) {
    const color = patch.color ? patch.color.toLowerCase() : null
    identity = writeScalar(identity, FIELD_LABELS.color, color)
  }
  if ('role' in patch) identity = writeScalar(identity, FIELD_LABELS.role, patch.role ?? null)
  if ('tone' in patch) identity = writeScalar(identity, FIELD_LABELS.tone, patch.tone ?? null)
  if ('model' in patch) identity = writeScalar(identity, FIELD_LABELS.model, patch.model ?? null)
  if ('subjects' in patch) {
    identity = writeList(identity, SUBJECTS_BLOCK, 'Owns these subjects', patch.subjects ?? [])
  }
  if ('tools' in patch) {
    toolsFile = writeList(toolsFile, TOOLS_BLOCK, 'Allowed tools', patch.tools ?? [])
  }

  return { identity, tools: toolsFile }
}
