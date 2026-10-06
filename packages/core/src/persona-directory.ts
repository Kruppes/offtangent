/**
 * persona-directory.ts: who can be delegated to (plan persona-architektur 1c).
 *
 * One place that answers "which personas exist, which are archived, what do
 * they do" for the three delegation surfaces: the `<cross_persona>` prompt
 * block, `create_task` with `persona`, and `ask_agent`. Reads the persona
 * folders (`<DATA_DIR>/agents/<id>/IDENTITY.md`) and, when a database is at
 * hand, the `personas` table for the archived flag. Never throws: a missing
 * folder, an unreadable file or an install without the `personas` table
 * simply yields fewer details.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from './database.js'
import { parsePersonaFields } from './persona-fields.js'
import { LEGACY_DEFAULT_PERSONA_ID } from './persona-store.js'

/** How many subjects of a persona the prompt block shows. */
export const PERSONA_DIRECTORY_SUBJECTS = 6
/** Hard cap for the role line in the prompt block (one line, never a paragraph). */
export const PERSONA_DIRECTORY_ROLE_MAX = 200

export interface PersonaDirectoryEntry {
  id: string
  name: string | null
  badge: string | null
  role: string | null
  subjects: string[]
  /** Model override from IDENTITY (`Model:`), or null. */
  model: string | null
}

function agentsBaseDir(baseDir?: string): string {
  return baseDir ?? path.join(process.env.DATA_DIR ?? '/data', 'agents')
}

/** Persona ids with a folder under the agents dir, `main` excluded, sorted. */
function folderPersonaIds(baseDir?: string): string[] {
  try {
    return fs.readdirSync(agentsBaseDir(baseDir), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== LEGACY_DEFAULT_PERSONA_ID && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
}

/** Archived persona ids from the `personas` table; empty without db/table. */
export function archivedPersonaIds(db?: Database | null): Set<string> {
  if (!db) return new Set()
  try {
    const rows = db.prepare('SELECT id FROM personas WHERE archived = 1').all() as { id: string }[]
    return new Set(rows.map(r => r.id))
  } catch {
    return new Set()
  }
}

/** The flagged default persona; `main` without db/table/flag. */
export function defaultPersonaId(db?: Database | null): string {
  if (!db) return LEGACY_DEFAULT_PERSONA_ID
  try {
    const row = db.prepare('SELECT id FROM personas WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined
    return row?.id ?? LEGACY_DEFAULT_PERSONA_ID
  } catch {
    return LEGACY_DEFAULT_PERSONA_ID
  }
}

/**
 * Every persona that can be addressed: `main` plus each folder persona that
 * is not archived. `main` first, the rest sorted by id, so the list (and the
 * prompt block built from it) is byte-stable between turns.
 */
export function listActivePersonaIds(options?: { baseDir?: string; db?: Database | null }): string[] {
  const archived = archivedPersonaIds(options?.db)
  return [LEGACY_DEFAULT_PERSONA_ID, ...folderPersonaIds(options?.baseDir).filter(id => !archived.has(id))]
}

function oneLine(text: string | null, max: number): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1).trimEnd()}…`
}

/** Directory entry of one persona. `main` has no folder and gets a fixed line. */
export function readPersonaDirectoryEntry(id: string, baseDir?: string): PersonaDirectoryEntry {
  if (id === LEGACY_DEFAULT_PERSONA_ID) {
    return { id, name: null, badge: null, role: 'default persona and conductor (orchestrates the others)', subjects: [], model: null }
  }
  let identity = ''
  try {
    identity = fs.readFileSync(path.join(agentsBaseDir(baseDir), id, 'IDENTITY.md'), 'utf-8')
  } catch {
    identity = ''
  }
  const fields = parsePersonaFields({ identity, tools: '' })
  return {
    id,
    name: fields.name,
    badge: fields.badge,
    // `role` already reads the legacy `Creature:` / `Wesen:` labels.
    role: oneLine(fields.role, PERSONA_DIRECTORY_ROLE_MAX),
    subjects: fields.subjects.slice(0, PERSONA_DIRECTORY_SUBJECTS).map(s => oneLine(s, 80) ?? '').filter(Boolean),
    model: fields.model,
  }
}

/** Active personas with their details, in the order of `listActivePersonaIds`. */
export function listPersonaDirectory(options?: { baseDir?: string; db?: Database | null }): PersonaDirectoryEntry[] {
  return listActivePersonaIds(options).map(id => readPersonaDirectoryEntry(id, options?.baseDir))
}

/** One prompt line per persona: `- bob 🔨 Bob: role. Subjects: a; b`. */
export function formatPersonaDirectoryLine(entry: PersonaDirectoryEntry): string {
  const head = [entry.id, entry.badge, entry.name && entry.name !== entry.id ? entry.name : null]
    .filter(Boolean)
    .join(' ')
  const parts = [`- ${head}`]
  if (entry.role) parts.push(`: ${entry.role}`)
  if (entry.subjects.length > 0) parts.push(`${entry.role ? '' : ':'} Subjects: ${entry.subjects.join('; ')}`)
  return parts.join('')
}

export type DelegationTargetResult =
  | { ok: true; personaId: string; foreign: boolean }
  | { ok: false; error: string }

/**
 * Validate a `create_task` `persona` argument for `callerAgentId`.
 *
 * - absent/empty → the caller itself (today's behaviour)
 * - the caller itself → fine for everyone
 * - another persona → only the default persona may delegate; the target must
 *   exist (folder, or `main`) and must not be archived
 */
export function resolveDelegationTarget(input: {
  requested: string | null | undefined
  callerAgentId: string | null | undefined
  baseDir?: string
  db?: Database | null
}): DelegationTargetResult {
  const caller = input.callerAgentId || LEGACY_DEFAULT_PERSONA_ID
  const requested = (input.requested ?? '').trim()
  if (!requested || requested === caller) return { ok: true, personaId: caller, foreign: false }

  const valid = listActivePersonaIds({ baseDir: input.baseDir, db: input.db })
  const defaultId = defaultPersonaId(input.db)
  if (caller !== defaultId) {
    return {
      ok: false,
      error: `persona "${requested}" not allowed: only the default persona (${defaultId}) may start a task as another persona; persona "${caller}" may only use persona "${caller}" or omit the parameter.`,
    }
  }
  if (!valid.includes(requested)) {
    const archived = archivedPersonaIds(input.db).has(requested)
    return {
      ok: false,
      error: `persona "${requested}" ${archived ? 'is archived' : 'is unknown'}. Valid personas: ${valid.join(', ')}.`,
    }
  }
  return { ok: true, personaId: requested, foreign: true }
}
