/**
 * General device tokens: the LED clock, the Pi dashboard and whatever screen
 * or knob comes next.
 *
 * A device token is NOT a user JWT. It carries a small set of scopes and
 * nothing else: no chat, no feed, no memory, no strand content.
 *
 *   status:read          read the reduced status (`GET /api/status`,
 *                        `GET /api/device/clock/state`)
 *   interactions:answer  answer a device-answerable choice/confirm card
 *                        (`POST /api/status/answer`, `POST /api/device/clock/answer`)
 *
 * Only the SHA-256 of a token is stored, so a database dump does not hand out
 * working tokens. Revoking sets `revoked_at`; the next request with that token
 * is a 401.
 *
 * Storage: the rows live in the table `clock_devices` (historical name, the
 * clock was the first device). Clock tokens issued before this generalisation
 * carry the scope names `clock:state` / `clock:answer`; they are read as
 * aliases of `status:read` / `interactions:answer`, so no clock has to be
 * re-provisioned and no row is rewritten. Clock tokens keep the prefix `otc_`,
 * every other device gets `otd_`; both are verified the same way.
 */
import crypto from 'node:crypto'
import type { Database } from '@axiom/core'

export const DEVICE_SCOPES = ['status:read', 'interactions:answer'] as const
export type DeviceScope = typeof DEVICE_SCOPES[number]

/** Scope names of the first clock build, read as aliases (migration without re-issue). */
export const LEGACY_SCOPE_ALIASES: Readonly<Record<string, DeviceScope>> = {
  'clock:state': 'status:read',
  'clock:answer': 'interactions:answer',
}

/** Kinds a device may be registered as. Only `clock` changes behaviour (wake calls, clock owner routes). */
export const DEVICE_KINDS = ['clock', 'dashboard', 'generic'] as const
export type DeviceKind = typeof DEVICE_KINDS[number]

/** Prefixes make a leaked token recognisable in logs and secret scanners. */
export const CLOCK_TOKEN_PREFIX = 'otc_'
export const DEVICE_TOKEN_PREFIX = 'otd_'
const TOKEN_MAX = 128
export const DEVICE_NAME_MAX = 40

export interface Device {
  id: string
  userId: number
  kind: DeviceKind
  name: string
  /** Canonical scopes (legacy names already mapped). */
  scopes: DeviceScope[]
  privacy: boolean
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

interface DeviceRow {
  id: string
  user_id: number
  kind: string | null
  name: string
  scopes: string
  privacy: number
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Canonical scopes of a stored scope string; unknown names are dropped (fail closed). */
export function parseStoredScopes(raw: string): DeviceScope[] {
  const out = new Set<DeviceScope>()
  for (const name of raw.split(/\s+/).filter(Boolean)) {
    const canonical = (DEVICE_SCOPES as readonly string[]).includes(name)
      ? name as DeviceScope
      : LEGACY_SCOPE_ALIASES[name]
    if (canonical) out.add(canonical)
  }
  // Stable order, whatever the stored order was.
  return DEVICE_SCOPES.filter(scope => out.has(scope))
}

/** Owner input -> canonical scope list, or null when anything is not a known scope. */
export function parseScopeInput(raw: unknown): DeviceScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out = new Set<DeviceScope>()
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    const canonical = (DEVICE_SCOPES as readonly string[]).includes(entry)
      ? entry as DeviceScope
      : LEGACY_SCOPE_ALIASES[entry]
    if (!canonical) return null
    out.add(canonical)
  }
  return DEVICE_SCOPES.filter(scope => out.has(scope))
}

export function parseDeviceKind(raw: unknown): DeviceKind | null {
  if (raw === undefined || raw === null) return 'generic'
  return typeof raw === 'string' && (DEVICE_KINDS as readonly string[]).includes(raw) ? raw as DeviceKind : null
}

function toDevice(row: DeviceRow): Device {
  const kind = (DEVICE_KINDS as readonly string[]).includes(row.kind ?? '') ? row.kind as DeviceKind : 'clock'
  return {
    id: row.id,
    userId: row.user_id,
    kind,
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    privacy: row.privacy === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  }
}

/** 1-40 characters, whitespace collapsed; `fallback` when absent. */
export function normaliseName(raw: unknown, fallback: string): string | null {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name || name.length > DEVICE_NAME_MAX) return null
  return name
}

export interface CreateDeviceInput {
  name: string
  kind: DeviceKind
  scopes: DeviceScope[]
  privacy?: boolean
  /**
   * The exact scope string to store. Only the clock wrapper uses it, so new
   * clocks keep the stored form of the first build (`clock:state clock:answer`).
   */
  storedScopes?: string
}

export class DeviceRegistry {
  constructor(protected readonly db: Database) {}

  /** Creates a device and returns the plaintext token ONCE. */
  create(userId: number, input: CreateDeviceInput): { device: Device; token: string } {
    const clock = input.kind === 'clock'
    const id = `${clock ? 'clk' : 'dev'}_${crypto.randomBytes(6).toString('hex')}`
    const token = `${clock ? CLOCK_TOKEN_PREFIX : DEVICE_TOKEN_PREFIX}${crypto.randomBytes(24).toString('base64url')}`
    this.db.prepare(
      `INSERT INTO clock_devices (id, user_id, kind, name, token_hash, scopes, privacy)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, input.kind, input.name, hashDeviceToken(token), input.storedScopes ?? input.scopes.join(' '), input.privacy ? 1 : 0)
    return { device: this.get(userId, id)!, token }
  }

  get(userId: number, id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM clock_devices WHERE id = ? AND user_id = ?').get(id, userId) as DeviceRow | undefined
    return row ? toDevice(row) : null
  }

  listForUser(userId: number): Device[] {
    const rows = this.db.prepare('SELECT * FROM clock_devices WHERE user_id = ? ORDER BY created_at DESC, id').all(userId) as DeviceRow[]
    return rows.map(toDevice)
  }

  /** True when an active device of this user was revoked now. */
  revoke(userId: number, id: string): boolean {
    const result = this.db.prepare(
      "UPDATE clock_devices SET revoked_at = datetime('now') WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).run(id, userId)
    return result.changes === 1
  }

  /** Changes privacy and/or scopes of an active device; null when there is none. */
  update(userId: number, id: string, change: { privacy?: boolean; scopes?: DeviceScope[] }): Device | null {
    const current = this.get(userId, id)
    if (!current || current.revokedAt !== null) return null
    if (change.privacy !== undefined) {
      this.db.prepare('UPDATE clock_devices SET privacy = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .run(change.privacy ? 1 : 0, id, userId)
    }
    if (change.scopes !== undefined) {
      this.db.prepare('UPDATE clock_devices SET scopes = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
        .run(change.scopes.join(' '), id, userId)
    }
    return this.get(userId, id)
  }

  /**
   * The active device a bearer token belongs to, or null. Constant work per
   * lookup (hash + unique index), so timing does not leak token prefixes.
   */
  verify(token: string): Device | null {
    if (!isDeviceToken(token) || token.length > TOKEN_MAX) return null
    const row = this.db.prepare(
      'SELECT * FROM clock_devices WHERE token_hash = ? AND revoked_at IS NULL',
    ).get(hashDeviceToken(token)) as DeviceRow | undefined
    return row ? toDevice(row) : null
  }

  touch(id: string): void {
    this.db.prepare("UPDATE clock_devices SET last_seen_at = datetime('now') WHERE id = ?").run(id)
  }
}

/** Does this bearer value look like a device token (as opposed to a user JWT)? */
export function isDeviceToken(token: string): boolean {
  return token.startsWith(CLOCK_TOKEN_PREFIX) || token.startsWith(DEVICE_TOKEN_PREFIX)
}

/** The view of a device for its owner. Never contains the token or its hash. */
export function deviceOwnerView(device: Device) {
  return {
    id: device.id,
    kind: device.kind,
    name: device.name,
    scopes: device.scopes,
    privacy: device.privacy,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  }
}
