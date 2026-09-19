import { Router } from 'express'
import bcrypt from 'bcrypt'
import type { Database } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'

const SALT_ROUNDS = 10

interface UserRow {
  id: number
  username: string
  role: string
  telegram_id: string | null
  created_at: string
  updated_at: string
}

export function createUsersRouter(db: Database): Router {
  const router = Router()

  // All user routes require admin JWT
  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }
    next()
  })

  /**
   * GET /api/users — list all users
   */
  router.get('/', (_req, res) => {
    try {
      const rows = db.prepare(
        'SELECT id, username, role, telegram_id, created_at, updated_at FROM users ORDER BY id'
      ).all() as UserRow[]

      const users = rows.map(row => ({
        id: row.id,
        username: row.username,
        role: row.role,
        telegramId: row.telegram_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))

      res.json({ users })
    } catch (err) {
      res.status(500).json({ error: `Failed to list users: ${(err as Error).message}` })
    }
  })

  /**
   * POST /api/users — create user
   */
  router.post('/', (req: AuthenticatedRequest, res) => {
    const { username, password, role } = req.body as {
      username?: string
      password?: string
      role?: string
    }

    if (!username?.trim()) {
      res.status(400).json({ error: 'Username is required' })
      return
    }

    if (!password || password.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters' })
      return
    }

    const userRole = role === 'admin' ? 'admin' : 'user'

    // Check for duplicate username
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())
    if (existing) {
      res.status(409).json({ error: 'Username already exists' })
      return
    }

    try {
      const hash = bcrypt.hashSync(password, SALT_ROUNDS)
      const result = db.prepare(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
      ).run(username.trim(), hash, userRole)

      const user = db.prepare(
        'SELECT id, username, role, telegram_id, created_at, updated_at FROM users WHERE id = ?'
      ).get(result.lastInsertRowid) as UserRow

      res.status(201).json({
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          telegramId: user.telegram_id,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to create user: ${(err as Error).message}` })
    }
  })

  /**
   * PUT /api/users/:id — update user (change role, reset password)
   */
  router.put('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user ID' })
      return
    }

    const existing = db.prepare(
      'SELECT id, username, role FROM users WHERE id = ?'
    ).get(id) as UserRow | undefined

    if (!existing) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    const { role, password } = req.body as {
      role?: string
      password?: string
    }

    try {
      if (role !== undefined) {
        const newRole = role === 'admin' ? 'admin' : 'user'
        db.prepare(
          "UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newRole, id)
      }

      if (password) {
        if (password.length < 4) {
          res.status(400).json({ error: 'Password must be at least 4 characters' })
          return
        }
        const hash = bcrypt.hashSync(password, SALT_ROUNDS)
        db.prepare(
          "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(hash, id)
      }

      const updated = db.prepare(
        'SELECT id, username, role, telegram_id, created_at, updated_at FROM users WHERE id = ?'
      ).get(id) as UserRow

      res.json({
        user: {
          id: updated.id,
          username: updated.username,
          role: updated.role,
          telegramId: updated.telegram_id,
          createdAt: updated.created_at,
          updatedAt: updated.updated_at,
        },
      })
    } catch (err) {
      res.status(500).json({ error: `Failed to update user: ${(err as Error).message}` })
    }
  })

  /**
   * DELETE /api/users/:id — delete user (cannot delete self)
   */
  router.delete('/:id', (req: AuthenticatedRequest, res) => {
    const rawId = req.params.id
    const id = parseInt(Array.isArray(rawId) ? rawId[0] : rawId, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid user ID' })
      return
    }

    // Cannot delete self
    if (req.user?.userId === id) {
      res.status(400).json({ error: 'Cannot delete your own account' })
      return
    }

    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
    if (!existing) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    try {
      db.prepare('DELETE FROM users WHERE id = ?').run(id)
      res.json({ message: 'User deleted' })
    } catch (err) {
      res.status(500).json({ error: `Failed to delete user: ${(err as Error).message}` })
    }
  })

  return router
}
