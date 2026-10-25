/**
 * Device tokens for the LED clock (TC002 Berry app "Offtangent", stage 1+2).
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
 * - new clock tokens keep the prefix `otc_` and the stored scope string
 *   `clock:state clock:answer`, byte for byte what the first build wrote.
 *
 * A clock token is NOT a user JWT: no chat, no feed, no memory, no strands.
 * Only its SHA-256 is stored; revoking sets `revoked_at`, the next request
 * with that token is a 401.
 */
import type { Database } from '@axiom/core'
import {
  DeviceRegistry,
  normaliseName,
  type Device,
  type DeviceScope,
} from '../devices/registry.js'

export const CLOCK_SCOPES = ['clock:state', 'clock:answer'] as const
export type ClockScope = typeof CLOCK_SCOPES[number]

const CLOCK_NAME_OF: Record<DeviceScope, ClockScope> = {
  'status:read': 'clock:state',
  'interactions:answer': 'clock:answer',
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

  /** Creates a clock and returns the plaintext token ONCE. */
  create(userId: number, input: { name: string; privacy?: boolean }): { device: ClockDevice; token: string } {
    const { device, token } = this.devices.create(userId, {
      name: input.name,
      kind: 'clock',
      scopes: ['status:read', 'interactions:answer'],
      storedScopes: CLOCK_SCOPES.join(' '),
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
