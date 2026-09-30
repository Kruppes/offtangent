import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { Database } from '@axiom/core'
import type { TelegramBot } from '@axiom/telegram'
import { jwtMiddleware, verifyAccessToken } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

interface TelegramUserRow {
  id: number
  telegram_id: string
  telegram_username: string | null
  telegram_display_name: string | null
  status: string
  user_id: number | null
  created_at: string
  updated_at: string
}

interface UserRow {
  id: number
  username: string
}

export interface TelegramUsersRouterOptions {
  db: Database
  getTelegramBot?: () => TelegramBot | null
}

export function createTelegramUsersRouter(options: TelegramUsersRouterOptions): Router {
  const { db, getTelegramBot } = options
  const router = Router()

  /**
   * Serve a telegram avatar file by telegram_id string.
   * Shared logic for both endpoints.
   */
  function serveAvatar(telegramId: string, res: import('express').Response): void {
    const avatarDir = path.resolve(process.env.DATA_DIR ?? '/data', 'avatars')
    try {
      const files = fs.readdirSync(avatarDir)
      const match = files.find(f => f.startsWith(`telegram-${telegramId}.`))
      if (match) {
        const filePath = path.resolve(avatarDir, match)
        if (fs.existsSync(filePath)) {
          const ext = path.extname(match).slice(1)
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
          const data = fs.readFileSync(filePath)
          res.setHeader('Content-Type', mime)
          res.setHeader('Cache-Control', 'public, max-age=3600')
          res.setHeader('Content-Length', data.length)
          res.end(data)
          return
        }
      }
    } catch { /* directory doesn't exist */ }

    res.status(404).json({ error: 'No avatar' })
  }

  /**
   * Authenticate via Authorization header or ?token= query param.
   * Returns the payload if valid admin, otherwise sends 401 and returns null.
   */
  function authenticateAdmin(req: import('express').Request, res: import('express').Response): boolean {
    const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null
    const token = headerToken ?? queryToken
    const payload = token ? verifyAccessToken(token) : null
    if (!payload || payload.role !== 'admin') {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    return true
  }

  /**
   * GET /api/telegram-users/avatar-by-telegram-id/:telegramId — serve avatar by raw telegram ID
   * Used by the Users page where we only have the telegram_id string.
   */
  router.get('/avatar-by-telegram-id/:telegramId', (req, res) => {
    if (!authenticateAdmin(req, res)) return
    const telegramId = Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId
    serveAvatar(telegramId, res)
  })

  /**
   * GET /api/telegram-users/avatar-by-user-id/:userId — serve avatar by Axiom user ID
   * Used by the sidebar account button where we only know the logged-in user's ID.
   * Any authenticated user can fetch their own avatar; admins can fetch any.
   */
  router.get('/avatar-by-user-id/:userId', (req, res) => {
    const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    const queryToken = typeof req.query.token === 'string' ? req.query.token : null
    const token = headerToken ?? queryToken
    const payload = token ? verifyAccessToken(token) : null
    if (!payload) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }

    const rawUserId = req.params.userId
    const userId = parseInt(Array.isArray(rawUserId) ? rawUserId[0] : rawUserId, 10)
    if (isNaN(userId)) {
      res.status(400).json({ error: 'Invalid user ID' })
      return
    }

    // Users can only fetch their own avatar, admins can fetch any
    if (payload.role !== 'admin' && payload.userId !== userId) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }

    const row = db.prepare(
      'SELECT telegram_id FROM users WHERE id = ?'
    ).get(userId) as { telegram_id: string | null } | undefined

    if (!row?.telegram_id) {
      res.status(404).json({ error: 'No avatar' })
      return
    }

    serveAvatar(row.telegram_id, res)
  })

  /**
   * GET /api/telegram-users/:id/avatar — serve avatar by DB row id
   * Used by the Settings > Telegram page.
   */
  router.get('/:id/avatar', (req, res) => {
    if (!authenticateAdmin(req, res)) return

    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const row = db.prepare(
      'SELECT telegram_id FROM telegram_users WHERE id = ?'
    ).get(id) as { telegram_id: string } | undefined

    if (!row) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    serveAvatar(row.telegram_id, res)
  })

  // All remaining routes require admin JWT
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/telegram-users — list all telegram users
   */
  router.get('/', (_req, res) => {
    try {
      const rows = db.prepare(
        `SELECT tu.*, u.username as linked_username
         FROM telegram_users tu
         LEFT JOIN users u ON tu.user_id = u.id
         ORDER BY
           CASE tu.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
           tu.created_at DESC`
      ).all() as (TelegramUserRow & { linked_username: string | null })[]

      const avatarDir = path.join(process.env.DATA_DIR ?? '/data', 'avatars')
      let avatarFiles: string[] = []
      try { avatarFiles = fs.readdirSync(avatarDir) } catch { /* */ }

      const telegramUsers = rows.map(row => ({
        id: row.id,
        telegramId: row.telegram_id,
        telegramUsername: row.telegram_username,
        telegramDisplayName: row.telegram_display_name,
        status: row.status,
        userId: row.user_id,
        linkedUsername: row.linked_username,
        hasAvatar: avatarFiles.some(f => f.startsWith(`telegram-${row.telegram_id}.`)),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))

      res.json({ telegramUsers })
    } catch (err) {
      res.status(500).json({ error: `Failed to list telegram users: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/telegram-users/:id — update status and/or user assignment
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const existing = db.prepare(
      'SELECT * FROM telegram_users WHERE id = ?'
    ).get(id) as TelegramUserRow | undefined

    if (!existing) {
      res.status(404).json({ error: 'Telegram user not found' })
      return
    }

    const { status, userId } = req.body as {
      status?: string
      userId?: number | null
    }

    try {
      const previousStatus = existing.status

      if (status !== undefined) {
        if (!['pending', 'approved', 'rejected'].includes(status)) {
          res.status(400).json({ error: 'Status must be pending, approved, or rejected' })
          return
        }
        db.prepare(
          "UPDATE telegram_users SET status = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(status, id)
      }

      if (userId !== undefined) {
        if (userId !== null) {
          const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId) as UserRow | undefined
          if (!user) {
            res.status(400).json({ error: 'User not found' })
            return
          }
        }

        // Clear previous user link (if this telegram user was assigned to a different user)
        if (existing.user_id && existing.user_id !== userId) {
          db.prepare(
            "UPDATE users SET telegram_id = NULL, updated_at = datetime('now') WHERE id = ?"
          ).run(existing.user_id)
        }

        db.prepare(
          "UPDATE telegram_users SET user_id = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(userId, id)

        // Sync: update users.telegram_id so the Users page reflects the link
        if (userId !== null) {
          // Clear any other user that had this telegram_id
          db.prepare(
            "UPDATE users SET telegram_id = NULL, updated_at = datetime('now') WHERE telegram_id = ?"
          ).run(existing.telegram_id)
          // Set the new link
          db.prepare(
            "UPDATE users SET telegram_id = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(existing.telegram_id, userId)
        } else {
          // Unassign: clear telegram_id from the previously linked user
          db.prepare(
            "UPDATE users SET telegram_id = NULL, updated_at = datetime('now') WHERE telegram_id = ?"
          ).run(existing.telegram_id)
        }
      }

      // Return updated row
      const updated = db.prepare(
        `SELECT tu.*, u.username as linked_username
         FROM telegram_users tu
         LEFT JOIN users u ON tu.user_id = u.id
         WHERE tu.id = ?`
      ).get(id) as TelegramUserRow & { linked_username: string | null }

      // Notify user via Telegram when status changes
      const bot = getTelegramBot?.()
      if (status && status !== previousStatus && bot?.isRunning()) {
        const chatId = updated.telegram_id
        if (status === 'approved') {
          bot.sendDirectMessage(chatId,
            '✅ Your access has been approved! You can now send messages to the bot.'
          ).catch(() => {})
        } else if (status === 'rejected') {
          bot.sendDirectMessage(chatId,
            '❌ Your access request has been declined.'
          ).catch(() => {})
        }
      }

      res.json({
        telegramUser: {
          id: updated.id,
          telegramId: updated.telegram_id,
          telegramUsername: updated.telegram_username,
          telegramDisplayName: updated.telegram_display_name,
          status: updated.status,
          userId: updated.user_id,
          linkedUsername: updated.linked_username,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update telegram user: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/telegram-users/:id — remove a telegram user record
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid ID' })
      return
    }

    const existing = db.prepare('SELECT id FROM telegram_users WHERE id = ?').get(id)
    if (!existing) {
      res.status(404).json({ error: 'Telegram user not found' })
      return
    }

    try {
      // Clear linked user's telegram_id before deleting
      const row = db.prepare('SELECT telegram_id, user_id FROM telegram_users WHERE id = ?').get(id) as TelegramUserRow | undefined
      if (row?.user_id) {
        db.prepare(
          "UPDATE users SET telegram_id = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run(row.user_id)
      }

      db.prepare('DELETE FROM telegram_users WHERE id = ?').run(id)
      res.json({ message: 'Telegram user deleted' })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete telegram user: ${(err as Error).message}` })
    }
  })

  return router
}
