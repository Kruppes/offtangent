/**
 * The `push_devices` table, in code (PROTOCOL chapter 7, slice 1).
 *
 * A token addresses exactly one device, so it is the natural key. When a token
 * shows up under a different user the row is re-pointed rather than duplicated:
 * that is a device changing hands (or an account switch on the same phone),
 * and the previous owner must stop receiving doorbells for it immediately.
 */
import crypto from 'node:crypto'
import type { Database } from '@axiom/core'

export interface PushDevice {
  id: string
  userId: number
  token: string
  platform: string
  appVersion: string | null
  createdAt: string
  lastSeenAt: string
  lastSuccessAt: string | null
  failureCount: number
  disabledAt: string | null
}

interface PushDeviceRow {
  id: string
  user_id: number
  token: string
  platform: string
  app_version: string | null
  created_at: string
  last_seen_at: string
  last_success_at: string | null
  failure_count: number
  disabled_at: string | null
}

export interface RegisterDeviceInput {
  token: string
  platform?: string
  appVersion?: string | null
}

function toDevice(row: PushDeviceRow): PushDevice {
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    platform: row.platform,
    appVersion: row.app_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastSuccessAt: row.last_success_at,
    failureCount: row.failure_count,
    disabledAt: row.disabled_at,
  }
}

export class PushDeviceRegistry {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /**
   * Upsert by token. An existing row is re-pointed to `userId`, its
   * `last_seen_at` refreshed and its failure history cleared: a device that
   * just told us its token is alive, whatever FCM said about it before.
   */
  register(userId: number, input: RegisterDeviceInput): PushDevice {
    const token = input.token.trim()
    const platform = (input.platform ?? 'android').trim() || 'android'
    const appVersion = input.appVersion?.trim() || null
    const timestamp = this.now()

    const existing = this.db
      .prepare('SELECT * FROM push_devices WHERE token = ?')
      .get(token) as PushDeviceRow | undefined

    if (existing) {
      this.db
        .prepare(`
          UPDATE push_devices
             SET user_id = ?, platform = ?, app_version = ?, last_seen_at = ?,
                 failure_count = 0, disabled_at = NULL
           WHERE token = ?
        `)
        .run(userId, platform, appVersion, timestamp, token)
    } else {
      this.db
        .prepare(`
          INSERT INTO push_devices (id, user_id, token, platform, app_version, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(crypto.randomUUID(), userId, token, platform, appVersion, timestamp, timestamp)
    }

    const row = this.db
      .prepare('SELECT * FROM push_devices WHERE token = ?')
      .get(token) as PushDeviceRow
    return toDevice(row)
  }

  /** Returns true when a row was removed. Only the owner can unregister. */
  unregister(userId: number, token: string): boolean {
    const result = this.db
      .prepare('DELETE FROM push_devices WHERE token = ? AND user_id = ?')
      .run(token.trim(), userId)
    return result.changes > 0
  }

  listForUser(userId: number): PushDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM push_devices WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(userId) as PushDeviceRow[]
    return rows.map(toDevice)
  }

  /** The devices a doorbell actually goes to. */
  activeForUser(userId: number): PushDevice[] {
    const rows = this.db
      .prepare('SELECT * FROM push_devices WHERE user_id = ? AND disabled_at IS NULL ORDER BY last_seen_at DESC')
      .all(userId) as PushDeviceRow[]
    return rows.map(toDevice)
  }

  markSuccess(token: string): void {
    const timestamp = this.now()
    this.db
      .prepare('UPDATE push_devices SET last_success_at = ?, failure_count = 0 WHERE token = ?')
      .run(timestamp, token)
  }

  /** A transient failure. The device stays enabled; the counter is evidence. */
  markFailure(token: string): void {
    this.db
      .prepare('UPDATE push_devices SET failure_count = failure_count + 1 WHERE token = ?')
      .run(token)
  }

  /** FCM says the token is gone. No retry loop, no delete: the row is parked. */
  disable(token: string): void {
    const timestamp = this.now()
    this.db
      .prepare('UPDATE push_devices SET disabled_at = ?, failure_count = failure_count + 1 WHERE token = ? AND disabled_at IS NULL')
      .run(timestamp, token)
  }
}
