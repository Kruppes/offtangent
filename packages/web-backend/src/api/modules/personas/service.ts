/**
 * Persona service (SPEC 13.2, 13.3, 13.5).
 *
 * A persona is still a directory of markdown files under `/data/agents/<id>/`
 * — that is what the agent runtime reads, and this service never invents a
 * second prompt format. What it adds is the layer around it:
 *
 * - a persistent record (colour, badge, display name, `is_default`,
 *   `archived`) so a client can render a persona it does not ship code for,
 * - a structured view of the files so a phone can edit fields instead of five
 *   markdown documents,
 * - archive as the default removal, and a hard delete that first says what it
 *   would take with it and refuses while a turn of that persona is running.
 *
 * The write path is reachable from authenticated admin HTTP requests only. It
 * is deliberately NOT exported as an agent tool: persona files carry tool
 * access, and an agent that can widen its own permissions after reading a web
 * page is an incident with a date attached (SPEC 13.7).
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  loadMultiPersonaSettings,
  loadConfig,
  invalidatePersonaCache,
  applyPersonaFields,
  parsePersonaFields,
  ensurePersonaRecord,
  getPersonaRecord,
  listPersonaRecords,
  updatePersonaRecord,
  deletePersonaRecord,
  getDefaultPersonaId,
  hasLiveTaskForPersona,
  previewPersonaDelete,
} from '@axiom/core'
import type { Database, PersonaDeletePreview, PersonaRecord } from '@axiom/core'
import type {
  PersonaFilesContract as PersonaFiles,
  PersonaListItemContract as PersonaListItem,
  PersonaDetailContract as PersonaDetail,
  PersonaFieldsContract,
  UpdatePersonaPayloadContract,
  CreatePersonaPayloadContract,
} from '@axiom/core/contracts'
import { PERSONA_FILE_NAMES, PERSONA_FILE_KEYS } from '@axiom/core/contracts'
import type { PersonaFileKey } from '@axiom/core/contracts'

/** Map file name → key in PersonaFiles */
const FILE_TO_KEY: Record<string, PersonaFileKey> = {
  'IDENTITY.md': 'identity',
  'SOUL.md': 'soul',
  'USER.md': 'user',
  'TOOLS.md': 'tools',
  'AGENTS.md': 'agents',
  'HEARTBEAT.md': 'heartbeat',
}

const KEY_TO_FILE: Record<PersonaFileKey, string> = {
  identity: 'IDENTITY.md',
  soul: 'SOUL.md',
  user: 'USER.md',
  tools: 'TOOLS.md',
  agents: 'AGENTS.md',
  heartbeat: 'HEARTBEAT.md',
}

/**
 * Every failure a caller may see. The message is written for a user; it never
 * carries a filesystem path or a stack trace, because this endpoint is reached
 * from a browser and a phone.
 */
export class PersonaServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PersonaServiceError'
  }
}

/** Minimal turn runner view: the service only asks, it never starts a turn. */
export interface PersonaTurnGuard {
  hasActiveTurnForAgent?: (agentId: string) => boolean
}

export interface PersonaServiceOptions {
  db: Database
  getTurnRunner?: () => PersonaTurnGuard | null
}

/* ── Path safety ── */

function getAgentsBaseDir(): string {
  return path.resolve(process.env.DATA_DIR ?? '/data', 'agents')
}

/**
 * Resolve a persona directory with path-traversal protection. The id is
 * validated at the contract boundary already; this is the second lock on the
 * same door, because everything below writes files.
 */
function safePersonaDir(agentId: string): string {
  const baseDir = getAgentsBaseDir()
  const resolved = path.resolve(baseDir, agentId)
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new PersonaServiceError(400, 'invalid_id', 'Invalid persona id')
  }
  return resolved
}

/**
 * Resolve a persona file path with path-traversal protection.
 * Only allows files from the PERSONA_FILE_NAMES whitelist.
 */
function safeFilePath(personaDir: string, fileName: string): string {
  if (!(PERSONA_FILE_NAMES as readonly string[]).includes(fileName)) {
    throw new PersonaServiceError(400, 'invalid_file', 'Unknown persona file')
  }
  const resolved = path.resolve(personaDir, fileName)
  if (!resolved.startsWith(personaDir + path.sep) && resolved !== personaDir) {
    throw new PersonaServiceError(400, 'invalid_file', 'Unknown persona file')
  }
  return resolved
}

/* ── Atomic file writes ── */

/**
 * Write a file atomically: write to temp file, then rename.
 * Prevents corruption from concurrent or interrupted writes.
 */
function atomicWriteFile(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  try {
    fs.writeFileSync(tmp, content, 'utf-8')
    fs.renameSync(tmp, filePath)
  } catch (err) {
    // Clean up temp file on error
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

/* ── Telegram bindings ── */

/**
 * Get telegram bindings: agentId → botToken exists.
 */
function getTelegramBindings(db: Database): Map<string, string> {
  const bindings = new Map<string, string>()
  try {
    const multiPersona = loadMultiPersonaSettings()
    interface RawTelegramConfig {
      enabled?: boolean
      botToken?: string
      accounts?: Record<string, { agentId?: string; botToken?: string; enabled?: boolean }>
    }
    const telegram = loadConfig<RawTelegramConfig>('telegram.json')

    if (multiPersona.enabled && telegram.accounts) {
      for (const [key, account] of Object.entries(telegram.accounts)) {
        const agentId = account.agentId ?? key
        if (account.botToken && account.enabled !== false) {
          bindings.set(agentId, account.botToken)
        }
      }
    } else if (telegram.enabled && telegram.botToken) {
      // Single-bot mode binds the default persona, whatever it is called.
      bindings.set(getDefaultPersonaId(db), telegram.botToken)
    }
  } catch {
    // Config not available
  }
  return bindings
}

/* ── File helpers ── */

function readFiles(dir: string): PersonaFiles {
  const files: PersonaFiles = {
    identity: '', soul: '', user: '', tools: '', agents: '', heartbeat: '',
  }
  for (const fileName of PERSONA_FILE_NAMES) {
    const key = FILE_TO_KEY[fileName]
    if (!key) continue
    try {
      const filePath = safeFilePath(dir, fileName)
      if (fs.existsSync(filePath)) files[key] = fs.readFileSync(filePath, 'utf-8')
    } catch {
      // Unreadable file reads as empty: the editor must still open.
    }
  }
  return files
}

function writeFiles(dir: string, files: Partial<PersonaFiles>): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  for (const [key, content] of Object.entries(files)) {
    if (!(PERSONA_FILE_KEYS as readonly string[]).includes(key)) continue
    if (typeof content !== 'string') continue
    const fileName = KEY_TO_FILE[key as PersonaFileKey]
    if (!fileName) continue
    atomicWriteFile(safeFilePath(dir, fileName), content)
  }
}

function countPersonaFiles(dir: string): number {
  let count = 0
  for (const file of PERSONA_FILE_NAMES) {
    try {
      if (fs.existsSync(path.join(dir, file))) count++
    } catch { /* ignore */ }
  }
  return count
}

/**
 * Resolve the rendered identity of a persona. The record wins, the markdown is
 * the fallback: installs that predate the record keep the name and emoji they
 * had in IDENTITY.md, and nothing is ever blank.
 */
function projectIdentity(id: string, record: PersonaRecord | null, fields: PersonaFieldsContract): {
  displayName: string
  color: string | null
  badge: string | null
} {
  return {
    displayName: record?.displayName ?? fields.name ?? id,
    color: record?.color ?? fields.color ?? null,
    badge: record?.badge ?? fields.badge ?? null,
  }
}

/* ── Service ── */

export function createPersonasService(options: PersonaServiceOptions) {
  const { db } = options

  function personaDirs(): string[] {
    const baseDir = getAgentsBaseDir()
    try {
      if (!fs.existsSync(baseDir)) return []
      return fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      return []
    }
  }

  /**
   * Ids that exist at all: directories on disk plus records in the database.
   * Both, because a directory may predate the table and a record may survive a
   * directory that was removed by hand.
   */
  function allPersonaIds(): string[] {
    const ids = new Set<string>(personaDirs())
    for (const record of listPersonaRecords(db)) ids.add(record.id)
    ids.add(getDefaultPersonaId(db))
    return [...ids]
  }

  function exists(agentId: string): boolean {
    return fs.existsSync(safePersonaDir(agentId)) || getPersonaRecord(db, agentId) !== null
  }

  function requireExists(agentId: string): void {
    if (!exists(agentId)) {
      throw new PersonaServiceError(404, 'persona_not_found', `Persona "${agentId}" not found`)
    }
  }

  /**
   * SPEC 13.5 runtime hazard: a persona that is answering right now, or that
   * carries a delegated task, must not be archived or deleted — the next turn
   * would write against files that are gone. Mirrors `strand_busy`.
   */
  function assertNotBusy(agentId: string): void {
    const runner = options.getTurnRunner?.()
    if (runner?.hasActiveTurnForAgent?.(agentId)) {
      throw new PersonaServiceError(409, 'persona_busy', 'A turn of this persona is running')
    }
    if (hasLiveTaskForPersona(db, agentId)) {
      throw new PersonaServiceError(409, 'persona_busy', 'A delegated task of this persona is running')
    }
  }

  function toListItem(id: string, bindings: Map<string, string>): PersonaListItem {
    const dir = safePersonaDir(id)
    const record = getPersonaRecord(db, id)
    const files = readFiles(dir)
    const fields = parsePersonaFields({ identity: files.identity, tools: files.tools })
    const identity = projectIdentity(id, record, fields)
    return {
      id,
      hasTelegramBinding: bindings.has(id),
      fileCount: countPersonaFiles(dir),
      displayName: identity.displayName,
      color: identity.color,
      badge: identity.badge,
      role: fields.role,
      isDefault: record?.isDefault ?? id === getDefaultPersonaId(db),
      archived: record?.archived ?? false,
    }
  }

  /**
   * List every persona. Archived ones are included and flagged rather than
   * hidden: the caller needs them to offer "restore", and a filter is one line
   * on the client.
   */
  function listPersonas(): PersonaListItem[] {
    const bindings = getTelegramBindings(db)
    const defaultId = getDefaultPersonaId(db)
    return allPersonaIds()
      .map(id => toListItem(id, bindings))
      .sort((a, b) => {
        if (a.id === defaultId) return -1
        if (b.id === defaultId) return 1
        if (a.archived !== b.archived) return a.archived ? 1 : -1
        return a.id.localeCompare(b.id)
      })
  }

  function getPersona(agentId: string): PersonaDetail {
    const dir = safePersonaDir(agentId)
    const files = readFiles(dir)
    const fields = parsePersonaFields({ identity: files.identity, tools: files.tools })
    const record = getPersonaRecord(db, agentId)
    const identity = projectIdentity(agentId, record, fields)
    return {
      id: agentId,
      files,
      hasTelegramBinding: getTelegramBindings(db).has(agentId),
      fields: {
        ...fields,
        // The record is authoritative for the three rendered fields, so the
        // editor opens with what the clients actually show.
        name: identity.displayName,
        color: identity.color,
        badge: identity.badge,
      },
      displayName: identity.displayName,
      color: identity.color,
      badge: identity.badge,
      isDefault: record?.isDefault ?? agentId === getDefaultPersonaId(db),
      archived: record?.archived ?? false,
    }
  }

  /**
   * Apply an update. Order is deliberate: raw files first ("advanced mode"),
   * then the structured fields on top, so a user who edits both in one request
   * gets the fields they just typed and not the stale markdown behind them.
   */
  function updatePersona(agentId: string, payload: UpdatePersonaPayloadContract): PersonaDetail {
    requireExists(agentId)
    const dir = safePersonaDir(agentId)

    // Archiving is a state change with a runtime hazard; editing text is not.
    if (payload.archived === true) assertNotBusy(agentId)

    if (payload.files && Object.keys(payload.files).length > 0) {
      writeFiles(dir, payload.files)
    }

    if (payload.fields && Object.keys(payload.fields).length > 0) {
      const current = readFiles(dir)
      const applied = applyPersonaFields(
        { identity: current.identity, tools: current.tools },
        payload.fields,
      )
      const changed: Partial<PersonaFiles> = {}
      if (applied.identity !== current.identity) changed.identity = applied.identity
      if (applied.tools !== current.tools) changed.tools = applied.tools
      if (Object.keys(changed).length > 0) writeFiles(dir, changed)
    }

    // Mirror the three rendered fields into the record. The markdown stays the
    // prompt; the record is what a client renders without reading markdown.
    const recordPatch: Parameters<typeof updatePersonaRecord>[2] = {}
    if (payload.fields && 'name' in payload.fields) recordPatch.displayName = payload.fields.name ?? null
    if (payload.fields && 'color' in payload.fields) recordPatch.color = payload.fields.color ?? null
    if (payload.fields && 'badge' in payload.fields) recordPatch.badge = payload.fields.badge ?? null
    if (payload.archived !== undefined) recordPatch.archived = payload.archived
    if (payload.isDefault === true) recordPatch.isDefault = true
    if (payload.isDefault === false && getPersonaRecord(db, agentId)?.isDefault) {
      throw new PersonaServiceError(
        400,
        'default_required',
        'One persona must stay the default — promote another persona instead of clearing this flag',
      )
    }
    if (Object.keys(recordPatch).length > 0) updatePersonaRecord(db, agentId, recordPatch)

    invalidatePersonaCache(agentId)
    return getPersona(agentId)
  }

  /**
   * Default template content for new persona files (German).
   */
  const TEMPLATE_FILES: PersonaFiles = {
    identity: `# IDENTITY.md

- **Name:** (Dein Agent-Name)
- **Role:** KI-Assistent
- **Tone:** Hilfsbereit, kompetent, freundlich
- **Emoji:** 🤖
`,
    soul: `# SOUL.md

Du bist ein hilfreicher KI-Assistent mit eigener Persönlichkeit.

## Grundprinzipien

- Sei hilfreich und antworte klar
- Bleib in deiner Rolle
- Gib gut durchdachte Antworten

## Kommunikationsstil

- Freundlich und nahbar
- Prägnant, aber gründlich wenn nötig
`,
    user: `# USER.md

## Benutzerprofil

(Beschreibe den Hauptbenutzer, mit dem dieser Agent interagiert)
`,
    tools: `# TOOLS.md

## Verfügbare Werkzeuge

Dieser Agent kann die Standard-OpenAgent-Werkzeuge nutzen.
`,
    agents: `# AGENTS.md

## Agent-Regeln

Standardmäßige Agent-Regeln gelten.
`,
    heartbeat: `# HEARTBEAT.md

## Heartbeat-Aufgaben

(Definiere periodische Aufgaben für diesen Agent)
`,
  }

  /**
   * Create a persona: template files first, then the caller's raw files, then
   * the structured fields. A create is an update against a fresh directory, so
   * the same precedence applies.
   */
  function createPersona(payload: CreatePersonaPayloadContract): PersonaDetail {
    const agentId = payload.id
    const dir = safePersonaDir(agentId)

    if (fs.existsSync(dir) || getPersonaRecord(db, agentId) !== null) {
      throw new PersonaServiceError(409, 'persona_exists', `Persona "${agentId}" already exists`)
    }

    fs.mkdirSync(dir, { recursive: true })
    writeFiles(dir, TEMPLATE_FILES)
    ensurePersonaRecord(db, agentId)

    if (payload.files || payload.fields) {
      updatePersona(agentId, { files: payload.files, fields: payload.fields })
    }

    invalidatePersonaCache(agentId)
    return getPersona(agentId)
  }

  /** What a hard delete would remove (SPEC 13.5). Read only. */
  function deletePreview(agentId: string): PersonaDeletePreview {
    requireExists(agentId)
    return previewPersonaDelete(db, agentId)
  }

  /**
   * Hard delete. Archive is the default removal (`PUT { archived: true }`);
   * this one really removes the files and the record, so it asks for four
   * things first: the persona exists, it is not the default, nothing is
   * running, and no bot is bound to it. Rows keyed by `agent_id` are NOT
   * cascaded — strands and facts outlive the persona the same way they outlive
   * a deleted strand's facts (SPEC 7.5b), and the preview says so.
   */
  function deletePersona(agentId: string): void {
    requireExists(agentId)

    if (agentId === getDefaultPersonaId(db)) {
      throw new PersonaServiceError(
        403,
        'persona_is_default',
        'The default persona cannot be deleted — promote another persona first',
      )
    }

    assertNotBusy(agentId)

    if (getTelegramBindings(db).has(agentId)) {
      throw new PersonaServiceError(
        409,
        'telegram_bound',
        `Persona "${agentId}" has an active Telegram binding — remove the bot binding first`,
      )
    }

    const dir = safePersonaDir(agentId)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    deletePersonaRecord(db, agentId)
    invalidatePersonaCache(agentId)
  }

  return {
    listPersonas,
    getPersona,
    updatePersona,
    createPersona,
    deletePreview,
    deletePersona,
  }
}

export type PersonasService = ReturnType<typeof createPersonasService>
