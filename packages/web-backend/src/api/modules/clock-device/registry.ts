/**
 * Device tokens for the LED clock (TC002 Berry app "Offtangent", stage 1+2).
 *
 * A clock token is NOT a user JWT. It carries exactly two scopes,
 * `clock:state` (read the reduced panel state) and `clock:answer` (answer a
 * clock-eligible choice/confirm card), and nothing else: no chat, no feed, no
 * memory, no strands. Only its SHA-256 is stored, so a database dump does not
 * hand out working tokens. Revoking sets `revoked_at`; the next request with
 * that token is a 401.
 */
import crypto from 'node:crypto'
import type { Database } from '@axiom/core'

export const CLOCK_SCOPES = ['clock:state', 'clock:answer'] as const
export type ClockScope = typeof CLOCK_SCOPES[number]

/** Prefix makes a leaked token recognisable in logs and secret scanners. */
const TOKEN_PREFIX = 'otc_'
const NAME_MAX = 40

export interface ClockDevice {
  id: string
  userId: number
  name: string
  scopes: ClockScope[]
  privacy: boolean
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

interface ClockDeviceRow {
  id: string
  user_id: number
  name: string
  scopes: string
  privacy: number
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

function toDevice(row: ClockDeviceRow): ClockDevice {
  const scopes = row.scopes.split(/\s+/).filter((s): s is ClockScope => (CLOCK_SCOPES as readonly string[]).includes(s))
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scopes,
    privacy: row.privacy === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

export function normaliseDeviceName(raw: unknown): string | null {
  if (raw === undefined || raw === null) return 'TC002'
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name || name.length > NAME_MAX) return null
  return name
}

export class ClockDeviceRegistry {
  constructor(private readonly db: Database) {}

  /** Creates a device and returns the plaintext token ONCE. */
  create(userId: number, input: { name: string; privacy?: boolean }): { device: ClockDevice; token: string } {
    const id = `clk_${crypto.randomBytes(6).toString('hex')}`
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`
    this.db.prepare(
      `INSERT INTO clock_devices (id, user_id, name, token_hash, scopes, privacy)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, input.name, hashToken(token), CLOCK_SCOPES.join(' '), input.privacy ? 1 : 0)
    return { device: this.get(userId, id)!, token }
  }

  get(userId: number, id: string): ClockDevice | null {
    const row = this.db.prepare('SELECT * FROM clock_devices WHERE id = ? AND user_id = ?').get(id, userId) as ClockDeviceRow | undefined
    return row ? toDevice(row) : null
  }

  listForUser(userId: number): ClockDevice[] {
    const rows = this.db.prepare('SELECT * FROM clock_devices WHERE user_id = ? ORDER BY created_at DESC, id').all(userId) as ClockDeviceRow[]
    return rows.map(toDevice)
  }

  /** True when an active device of this user was revoked now. */
  revoke(userId: number, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE clock_devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).run(id, userId)
    return result.changes === 1
  }

  setPrivacy(userId: number, id: string, privacy: boolean): ClockDevice | null {
    const result = this.db.prepare(
      'UPDATE clock_devices SET privacy = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    ).run(privacy ? 1 : 0, id, userId)
    return result.changes === 1 ? this.get(userId, id) : null
  }

  /**
   * The active device a bearer token belongs to, or null. Constant work per
   * lookup (hash + unique index), so timing does not leak token prefixes.
   */
  verify(token: string): ClockDevice | null {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return null
    const row = this.db.prepare(
      'SELECT * FROM clock_devices WHERE token_hash = ? AND revoked_at IS NULL',
    ).get(hashToken(token)) as ClockDeviceRow | undefined
    return row ? toDevice(row) : null
  }

  touch(id: string): void {
    this.db.prepare("UPDATE clock_devices SET last_seen_at = datetime('now') WHERE id = ?").run(id)
  }
}
