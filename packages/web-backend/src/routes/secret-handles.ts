/**
 * `/api/secrets/handles` — admin-only management of sealed secret handles
 * (plan 2026-09-26, step 1, task T4).
 *
 * Hard rules of this router:
 *
 * 1. **A value never leaves the process.** `GET` answers with metadata only
 *    (`listSecrets()`), `POST` answers with the slug. There is no endpoint that
 *    returns a value, not even partially and not masked with real characters —
 *    a mask built from the plaintext would leak its shape.
 * 2. **No value in a log line or an error message.** Every failure is answered
 *    with a static reason plus, at most, a length or the list of allowed kinds.
 * 3. **Renaming is refused while the old handle is still referenced** in
 *    `chat_messages`, `tool_calls`, `captures` or `router_decisions` (409).
 *    `renameSecret()` does not rewrite stored rows (report T2, decision 10), so
 *    a rename would silently break every transcript that carries the old
 *    handle. Conservative choice: refuse instead of rewriting history.
 *
 * The path is a sub-resource of the existing `/api/secrets` (encrypted
 * environment variables), which is a different feature and stays untouched.
 */

import { Router } from 'express'
import type { Database } from '@axiom/core'
import {
  isSecretHandleKind,
  isSecretHandleSlug,
  listSecrets,
  removeSecret,
  renameSecret,
  sealSecret,
  secretHandle,
  SECRET_HANDLE_KINDS,
  SECRET_HANDLE_MAX_VALUE_LENGTH,
  SECRET_HANDLE_MIN_VALUE_LENGTH,
} from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

export interface SecretHandlesRouterOptions {
  db: Database
}

/** Where a handle can still be referenced. Column list per table. */
const USAGE_TABLES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'chat_messages', columns: ['content'] },
  { table: 'tool_calls', columns: ['input', 'output'] },
  { table: 'captures', columns: ['text'] },
  { table: 'router_decisions', columns: ['part_text'] },
]

/**
 * Rate limit for `POST`: a form submit is a human action, so a handful per
 * minute is plenty. There is no rate-limit middleware in this repository, so
 * this is a local in-process counter (fixed window per user) instead of a new
 * dependency.
 */
const POST_WINDOW_MS = 60_000
const POST_MAX_PER_WINDOW = 30

interface PostWindow {
  startedAt: number
  count: number
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?')
    .get(table) as { name?: string } | undefined
  return !!row?.name
}

/**
 * Count the rows that still contain `{{secret:<slug>}}`.
 *
 * Parameterised `LIKE` with an escape character, so a slug is data and never
 * SQL. Slugs are validated against the contract regex before they get here,
 * which already excludes `%` and `_`; the escape clause is belt and braces.
 */
export function countHandleUsage(db: Database, slug: string): { total: number; tables: Record<string, number> } {
  const needle = `%${secretHandle(slug)}%`
  const tables: Record<string, number> = {}
  let total = 0

  for (const { table, columns } of USAGE_TABLES) {
    if (!tableExists(db, table)) continue
    const where = columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .get(...columns.map(() => needle)) as { n?: number } | undefined
    const n = Number(row?.n ?? 0)
    if (n > 0) {
      tables[table] = n
      total += n
    }
  }

  return { total, tables }
}

export function createSecretHandlesRouter(options: SecretHandlesRouterOptions): Router {
  const router = Router()
  const postWindows = new Map<number, PostWindow>()

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/secrets/handles
   * Metadata of every sealed secret. Never a value.
   */
  router.get('/', (_req, res) => {
    try {
      res.json({ handles: listSecrets(), kinds: SECRET_HANDLE_KINDS })
    } catch (err) {
      res.status(500).json({ error: `Failed to read secret handles: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/secrets/handles
   * Body: { value: string, kind: SecretHandleKind, slug?: string }
   * Answer: { slug, handle, kind }
   *
   * F7 (triage 2026-09-26 19:25): the answer deliberately does NOT say whether
   * the value was already stored. `deduplicated: true` let a caller test a
   * candidate value against the store without ever decrypting anything.
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId ?? 0
    const now = Date.now()
    const window = postWindows.get(userId)
    if (!window || now - window.startedAt > POST_WINDOW_MS) {
      postWindows.set(userId, { startedAt: now, count: 1 })
    } else {
      window.count += 1
      if (window.count > POST_MAX_PER_WINDOW) {
        res.status(429).json({ error: 'Too many secrets created in a short time. Wait a minute and try again.' })
        return
      }
    }

    const body = (req.body ?? {}) as { value?: unknown; kind?: unknown; slug?: unknown }

    if (typeof body.value !== 'string' || body.value.length === 0) {
      res.status(400).json({ error: 'A value is required.' })
      return
    }
    // F5 (review triage 2026-09-26 19:25): a value shorter than six characters
    // is not redactable globally (a 4-digit PIN would rewrite dates and ports
    // in every tool output), so the form refuses it instead of storing a handle
    // that only works when it is resolved explicitly.
    if (body.value.length < SECRET_HANDLE_MIN_VALUE_LENGTH) {
      res.status(400).json({
        code: 'value_too_short',
        error: `Value is too short (minimum ${SECRET_HANDLE_MIN_VALUE_LENGTH} characters).`,
      })
      return
    }
    if (body.value.length > SECRET_HANDLE_MAX_VALUE_LENGTH) {
      res.status(400).json({ error: `Value is too long (maximum ${SECRET_HANDLE_MAX_VALUE_LENGTH} characters).` })
      return
    }
    if (!isSecretHandleKind(body.kind)) {
      res.status(400).json({ error: `Unknown kind. Allowed: ${SECRET_HANDLE_KINDS.join(', ')}.` })
      return
    }
    const wantedSlug = body.slug === undefined || body.slug === null || body.slug === '' ? null : body.slug
    if (wantedSlug !== null && !isSecretHandleSlug(wantedSlug)) {
      res.status(400).json({ error: 'Invalid slug. Allowed: lowercase letters, digits and dashes, starting with a letter or digit, up to 64 characters.' })
      return
    }
    if (wantedSlug !== null && listSecrets().some(entry => entry.slug === wantedSlug)) {
      res.status(409).json({ error: 'A secret with this name already exists.' })
      return
    }

    try {
      const before = new Set(listSecrets().map(entry => entry.slug))
      // The store deduplicates by SHA-256: sealing a value that is already
      // filed returns the existing slug instead of a second entry.
      let slug = sealSecret(body.value, body.kind, 'form')
      const deduplicated = before.has(slug)

      if (wantedSlug !== null && !deduplicated && slug !== wantedSlug) {
        renameSecret(slug, wantedSlug)
        slug = wantedSlug
      }

      const info = listSecrets().find(entry => entry.slug === slug)
      res.status(201).json({
        slug,
        handle: secretHandle(slug),
        kind: info?.kind ?? body.kind,
      })
    } catch {
      // Deliberately not forwarding the thrown message: it may quote input.
      res.status(500).json({ error: 'Failed to store the secret.' })
    }
  })

  /**
   * PATCH /api/secrets/handles/:slug
   * Body: { slug: string } — the new name.
   */
  router.patch('/:slug', (req: AuthenticatedRequest, res) => {
    const current = req.params.slug as string
    const body = (req.body ?? {}) as { slug?: unknown }

    if (!isSecretHandleSlug(current) || !isSecretHandleSlug(body.slug)) {
      res.status(400).json({ error: 'Invalid slug. Allowed: lowercase letters, digits and dashes, starting with a letter or digit, up to 64 characters.' })
      return
    }
    const next = body.slug
    const all = listSecrets()
    if (!all.some(entry => entry.slug === current)) {
      res.status(404).json({ error: 'Unknown secret.' })
      return
    }
    if (next === current) {
      res.json({ slug: current, handle: secretHandle(current) })
      return
    }
    if (all.some(entry => entry.slug === next)) {
      res.status(409).json({ error: 'A secret with this name already exists.' })
      return
    }

    // Conservative rule (see file header): a handle that is already written
    // into a transcript cannot be renamed, because nothing rewrites those rows.
    const usage = countHandleUsage(options.db, current)
    if (usage.total > 0) {
      res.status(409).json({
        error: 'This secret is already referenced in stored messages and cannot be renamed. Create a new secret instead, or delete this one.',
        code: 'handle_in_use',
        usage: usage.tables,
      })
      return
    }

    try {
      renameSecret(current, next)
      res.json({ slug: next, handle: secretHandle(next) })
    } catch {
      res.status(500).json({ error: 'Failed to rename the secret.' })
    }
  })

  /**
   * DELETE /api/secrets/handles/:slug
   *
   * Allowed even when the handle is referenced: the reference then stops
   * resolving, which is the safe direction (the value is gone).
   */
  router.delete('/:slug', (req: AuthenticatedRequest, res) => {
    const slug = req.params.slug as string
    if (!isSecretHandleSlug(slug)) {
      res.status(400).json({ error: 'Invalid slug.' })
      return
    }
    try {
      const removed = removeSecret(slug)
      if (!removed) {
        res.status(404).json({ error: 'Unknown secret.' })
        return
      }
      res.json({ slug, removed: true, usage: countHandleUsage(options.db, slug).tables })
    } catch {
      res.status(500).json({ error: 'Failed to delete the secret.' })
    }
  })

  return router
}
