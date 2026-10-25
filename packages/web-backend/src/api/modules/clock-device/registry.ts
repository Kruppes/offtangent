/**
 * Device tokens for the LED clock (TC002 Berry app "Offtangent", stage 1-3).
 *
 * Since the status API the clock is one device kind of the general device
 * registry (`../devices/registry.ts`, same table `clock_devices`). This
 * wrapper keeps the clock's view of it unchanged:
 *
 * - only devices of kind `clock` are visible here (list, get, verify, wake);
 * - the scopes keep their clock names, `clock:state` (read the reduced panel
 *   state) and `clock:answer` (answer a clock-eligible choice/confirm card).
 *   In the general registry they are aliases of `status:read` and
 *   `interactions:answer`; a clock token of the first build is valid for
 *   `GET /api/status` without being re-issued;
 * - `clock:voice` (stage 3, ask by voice) is a clock-only scope: a new token
 *   gets it only when requested explicitly (review M2), never by default, and
 *   `/api/devices` can neither grant nor check it;
 * - new clock tokens keep the prefix `otc_` and the stored scope string in
 *   clock names (`clock:state clock:answer` by default), byte for byte what
 *   the first build wrote.
 *
 * A clock token is NOT a user JWT: no chat, no feed, no memory, no strands.
 * Only its SHA-256 is stored; revoking sets `revoked_at`, the next request
 * with that token is a 401. Existing rows are never touched.
 */
import type { Database } from '@axiom/core'
import {
  DeviceRegistry,
  LEGACY_SCOPE_ALIASES,
  normaliseName,
  type Device,
  type DeviceScope,
  type StoredDeviceScope,
} from '../devices/registry.js'

export const CLOCK_SCOPES = ['clock:state', 'clock:answer', 'clock:voice'] as const
export type ClockScope = typeof CLOCK_SCOPES[number]

/**
 * Scopes a new token gets when the caller names none (review M2): the stage
 * 1+2 pair. `clock:voice` (stage 3, push-to-talk) is never implied; it must be
 * asked for explicitly. Existing rows are never touched.
 */
export const CLOCK_DEFAULT_SCOPES: readonly ClockScope[] = ['clock:state', 'clock:answer']

export class ClockScopeError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/**
 * Validates a requested scope list against the whitelist {@link CLOCK_SCOPES}.
 * `undefined` -> the defaults; anything else must be a non-empty array of
 * known scope strings (duplicates collapse, order is canonical).
 */
export function normaliseClockScopes(raw: unknown): ClockScope[] {
  if (raw === undefined) return [...CLOCK_DEFAULT_SCOPES]
  if (!Array.isArray(raw) || raw.length === 0) throw new ClockScopeError('scopes must be a non-empty array')
  const known = CLOCK_SCOPES as readonly string[]
  for (const scope of raw) {
    if (typeof scope !== 'string' || !known.includes(scope)) {
      throw new ClockScopeError(`unknown scope: ${String(scope).slice(0, 40)}`)
    }
  }
  return CLOCK_SCOPES.filter(scope => (raw as string[]).includes(scope))
}

const CLOCK_NAME_OF: Record<StoredDeviceScope, ClockScope> = {
  'status:read': 'clock:state',
  'interactions:answer': 'clock:answer',
  'clock:voice': 'clock:voice',
}

/** Canonical device scopes of a clock scope list (`clock:voice` has none). */
function deviceScopesOf(scopes: readonly ClockScope[]): DeviceScope[] {
  return scopes.map(scope => LEGACY_SCOPE_ALIASES[scope]).filter((scope): scope is DeviceScope => scope !== undefined)
}

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

function toClockDevice(device: Device): ClockDevice {
  return {
    id: device.id,
    userId: device.userId,
    name: device.name,
    scopes: device.scopes.map(scope => CLOCK_NAME_OF[scope]),
    privacy: device.privacy,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
  }
}

export function normaliseDeviceName(raw: unknown): string | null {
  return normaliseName(raw, 'TC002')
}

export class ClockDeviceRegistry {
  private readonly devices: DeviceRegistry

  constructor(db: Database) {
    this.devices = new DeviceRegistry(db)
  }

  /**
   * Creates a clock and returns the plaintext token ONCE. `scopes` is the raw
   * owner input (see {@link normaliseClockScopes}); throws
   * {@link ClockScopeError} for an invalid list.
   */
  create(userId: number, input: { name: string; privacy?: boolean; scopes?: unknown }): { device: ClockDevice; token: string } {
    const scopes = normaliseClockScopes(input.scopes)
    const { device, token } = this.devices.create(userId, {
      name: input.name,
      kind: 'clock',
      scopes: deviceScopesOf(scopes),
      storedScopes: scopes.join(' '),
      privacy: input.privacy,
    })
    return { device: toClockDevice(device), token }
  }

  get(userId: number, id: string): ClockDevice | null {
    const device = this.devices.get(userId, id)
    return device && device.kind === 'clock' ? toClockDevice(device) : null
  }

  listForUser(userId: number): ClockDevice[] {
    return this.devices.listForUser(userId).filter(device => device.kind === 'clock').map(toClockDevice)
  }

  /** True when an active clock of this user was revoked now. */
  revoke(userId: number, id: string): boolean {
    if (!this.get(userId, id)) return false
    return this.devices.revoke(userId, id)
  }

  setPrivacy(userId: number, id: string, privacy: boolean): ClockDevice | null {
    if (!this.get(userId, id)) return null
    const device = this.devices.update(userId, id, { privacy })
    return device ? toClockDevice(device) : null
  }

  /**
   * The active clock a bearer token belongs to, or null. Tokens of other
   * device kinds (dashboard, ...) are not clocks and get null here; they use
   * `/api/status`.
   */
  verify(token: string): ClockDevice | null {
    const device = this.devices.verify(token)
    return device && device.kind === 'clock' ? toClockDevice(device) : null
  }

  touch(id: string): void {
    this.devices.touch(id)
  }
}
