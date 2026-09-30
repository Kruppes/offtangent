/**
 * GET /api/personas/client — the persona list every logged-in client needs to
 * render a chat (name, emoji, colour), NOT the admin surface.
 *
 * `/api/personas` is admin-only and answers with operational detail (Telegram
 * bindings, file counts, full file contents). A normal user — and the Android
 * app in particular — only needs to know which personas exist and how to label
 * them, so this route is deliberately a separate, minimal projection:
 *
 *   { "personas": [ { "id", "displayName", "emoji", "color" } ] }
 *
 * `main` is always first (it is the orchestrator), the rest is sorted by id.
 * Source of truth is the persona directory (`/data/agents/<id>/`) plus a
 * best-effort parse of its `IDENTITY.md`; anything unparseable falls back to
 * the id, never to an error.
 *
 * Mounted BEFORE the admin router so `/api/personas/client` is not swallowed
 * by its `GET /:id` route.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { getDefaultPersonaId, getPersonaRecord, listPersonaRecords } from '@axiom/core'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'

/** Wire shape — intentionally free of any operational detail. */
export interface ClientPersona {
  id: string
  displayName: string
  emoji: string | null
  color: string | null
  /** SPEC 13.2: which persona catches everything, without a hardcoded id. */
  isDefault: boolean
}

/** Only the head of IDENTITY.md is parsed; the rest is prose. */
const IDENTITY_PARSE_LIMIT = 4000
/** Upper bound for a rendered persona name. */
const DISPLAY_NAME_MAX_LENGTH = 80
/** Emojis are short; anything longer is prose that leaked into the field. */
const EMOJI_MAX_LENGTH = 8
/** Placeholder values used in the persona templates for "not set". */
const PLACEHOLDERS = new Set(['—', '–', '-', '', 'n/a', 'none', 'keine', 'tbd'])
/** Colours are plain 6-digit hex, same as projects. */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function agentsBaseDir(): string {
  return path.resolve(process.env.DATA_DIR ?? '/data', 'agents')
}

/**
 * Pull `- **Label:** value` out of an IDENTITY.md. Defensive by design: the
 * file is user-edited Markdown, so a missing field, a different label or a
 * placeholder value must simply yield `null`.
 */
function parseIdentityField(content: string, labels: string[]): string | null {
  for (const label of labels) {
    // Horizontal whitespace only ([ \t], not \s): `\s` would jump over the
    // line break and read the NEXT line's value into an empty field.
    const pattern = new RegExp(`^[ \\t]*[-*][ \\t]*\\*\\*[ \\t]*${label}[ \\t]*:?[ \\t]*\\*\\*[ \\t]*:?[ \\t]*(.*)`, 'im')
    const match = pattern.exec(content)
    if (!match) continue
    const value = match[1]?.trim() ?? ''
    if (PLACEHOLDERS.has(value.toLowerCase())) continue
    if (value) return value
  }
  return null
}

function readIdentity(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, 'IDENTITY.md'), 'utf-8').slice(0, IDENTITY_PARSE_LIMIT)
  } catch {
    return ''
  }
}

/**
 * Build the client projection of one persona. The persona record wins where it
 * has a value (SPEC 13.2 — colour and badge belong in the record, not in the
 * app), and IDENTITY.md is the fallback, so an install that predates the
 * record renders exactly as it did before.
 */
function toClientPersona(id: string, baseDir: string, db: Database | null, defaultId: string): ClientPersona {
  const identity = readIdentity(path.join(baseDir, id))
  const name = parseIdentityField(identity, ['Name', 'Nickname'])
  const emoji = parseIdentityField(identity, ['Emoji'])
  const color = parseIdentityField(identity, ['Color', 'Colour', 'Farbe'])
  const record = db ? getPersonaRecord(db, id) : null

  const resolvedName = record?.displayName ?? name
  const resolvedEmoji = record?.badge ?? emoji
  const resolvedColor = record?.color ?? color

  return {
    id,
    displayName: resolvedName ? resolvedName.slice(0, DISPLAY_NAME_MAX_LENGTH) : id,
    emoji: resolvedEmoji && resolvedEmoji.length <= EMOJI_MAX_LENGTH ? resolvedEmoji : null,
    color: resolvedColor && COLOR_PATTERN.test(resolvedColor) ? resolvedColor.toLowerCase() : null,
    isDefault: record?.isDefault ?? id === defaultId,
  }
}

/**
 * Persona ids a client may pick: the default first, then every other
 * directory, sorted. Archived personas are left out — they are exactly the
 * ones that should disappear from a picker (SPEC 13.5).
 */
function listClientPersonaIds(baseDir: string, db: Database | null, defaultId: string): string[] {
  let others: string[] = []
  try {
    others = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== defaultId)
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // Directory missing or unreadable → the default persona only.
  }
  if (db) {
    const archived = new Set(listPersonaRecords(db).filter(r => r.archived).map(r => r.id))
    others = others.filter(id => !archived.has(id))
  }
  return [defaultId, ...others]
}

export interface PersonasClientRouterOptions {
  /** Optional: without it the route falls back to the markdown-only reading. */
  db?: Database | null
}

export function createPersonasClientRouter(options?: PersonasClientRouterOptions): Router {
  const router = Router()
  const db = options?.db ?? null

  // Any authenticated user, no admin check: picking a persona is a normal
  // chat action, not an administrative one.
  router.use(jwtMiddleware)

  router.get('/', (_req, res) => {
    const baseDir = agentsBaseDir()
    const defaultId = db ? getDefaultPersonaId(db) : 'main'
    res.json({
      personas: listClientPersonaIds(baseDir, db, defaultId).map(id => toClientPersona(id, baseDir, db, defaultId)),
    })
  })

  return router
}
