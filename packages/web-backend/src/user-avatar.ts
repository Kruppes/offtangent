import fs from 'node:fs'
import path from 'node:path'
import type { Database } from '@axiom/core'

/** Directory the Telegram integration stores profile pictures in. */
export function avatarDir(): string {
  return path.resolve(process.env.DATA_DIR ?? '/data', 'avatars')
}

/**
 * Absolute path of the stored avatar of one Telegram account, or null when
 * none was downloaded (no Telegram in use, or the account has no picture).
 */
export function findTelegramAvatarFile(telegramId: string): string | null {
  const dir = avatarDir()
  try {
    const match = fs.readdirSync(dir).find(f => f.startsWith(`telegram-${telegramId}.`))
    if (!match) return null
    const filePath = path.resolve(dir, match)
    return fs.existsSync(filePath) ? filePath : null
  } catch {
    return null // directory does not exist
  }
}

/**
 * Whether `GET /api/telegram-users/avatar-by-user-id/:userId` has a picture to
 * serve. Clients ask this first instead of requesting the image blindly and
 * getting a 404 on every page.
 */
export function userHasAvatar(db: Database, userId: number): boolean {
  const row = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(userId) as
    | { telegram_id: string | null }
    | undefined
  if (!row?.telegram_id) return false
  return findTelegramAvatarFile(row.telegram_id) !== null
}
