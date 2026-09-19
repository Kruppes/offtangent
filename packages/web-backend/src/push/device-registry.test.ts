import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from '@axiom/core'
import type { Database } from '@axiom/core'
import { PushDeviceRegistry } from './device-registry.js'

let db: Database
let registry: PushDeviceRegistry

function seedUser(id: number, name: string): void {
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, name, 'x')
}

beforeEach(() => {
  db = initDatabase(':memory:')
  seedUser(1, 'alice')
  seedUser(2, 'bob')
  registry = new PushDeviceRegistry(db)
})

afterEach(() => {
  db.close()
})

describe('push device registry', () => {
  it('creates the table with every column the sender needs', () => {
    const columns = (db.prepare('PRAGMA table_info(push_devices)').all() as { name: string }[]).map(c => c.name)
    expect(columns.sort()).toEqual([
      'app_version',
      'created_at',
      'disabled_at',
      'failure_count',
      'id',
      'last_seen_at',
      'last_success_at',
      'platform',
      'token',
      'user_id',
    ])
  })

  it('registers a device and lists it for its owner only', () => {
    const device = registry.register(1, { token: 'tok-a', appVersion: '0.7.3' })
    expect(device.userId).toBe(1)
    expect(device.appVersion).toBe('0.7.3')
    expect(device.platform).toBe('android')
    expect(registry.listForUser(1)).toHaveLength(1)
    expect(registry.listForUser(2)).toHaveLength(0)
  })

  it('upserts on the token instead of creating a second row', () => {
    const first = registry.register(1, { token: 'tok-a', appVersion: '0.7.2' })
    const second = registry.register(1, { token: 'tok-a', appVersion: '0.7.3' })
    expect(second.id).toBe(first.id)
    expect(second.appVersion).toBe('0.7.3')
    expect(registry.listForUser(1)).toHaveLength(1)
  })

  it('re-points a token that shows up under another user', () => {
    registry.register(1, { token: 'tok-a' })
    registry.register(2, { token: 'tok-a' })
    expect(registry.listForUser(1)).toHaveLength(0)
    expect(registry.activeForUser(2)).toHaveLength(1)
  })

  it('only lets the owner unregister', () => {
    registry.register(1, { token: 'tok-a' })
    expect(registry.unregister(2, 'tok-a')).toBe(false)
    expect(registry.unregister(1, 'tok-a')).toBe(true)
    expect(registry.listForUser(1)).toHaveLength(0)
  })

  it('disables a dead token and keeps the row out of the active set', () => {
    registry.register(1, { token: 'tok-a' })
    registry.disable('tok-a')
    expect(registry.activeForUser(1)).toHaveLength(0)
    const [row] = registry.listForUser(1)
    expect(row.disabledAt).not.toBeNull()
    expect(row.failureCount).toBe(1)
  })

  it('revives a disabled device when it registers again', () => {
    registry.register(1, { token: 'tok-a' })
    registry.markFailure('tok-a')
    registry.disable('tok-a')
    const revived = registry.register(1, { token: 'tok-a' })
    expect(revived.disabledAt).toBeNull()
    expect(revived.failureCount).toBe(0)
    expect(registry.activeForUser(1)).toHaveLength(1)
  })

  it('records a success and clears the failure counter', () => {
    registry.register(1, { token: 'tok-a' })
    registry.markFailure('tok-a')
    registry.markFailure('tok-a')
    expect(registry.listForUser(1)[0].failureCount).toBe(2)
    registry.markSuccess('tok-a')
    const [row] = registry.listForUser(1)
    expect(row.failureCount).toBe(0)
    expect(row.lastSuccessAt).not.toBeNull()
  })

  it('is idempotent across a second initDatabase on the same file', () => {
    // The migration runs on every boot; running it twice must not throw and
    // must not drop rows (the live database is large, no rebuilds).
    registry.register(1, { token: 'tok-a' })
    expect(() => db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL DEFAULT 'android',
        app_version TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_success_at TEXT,
        failure_count INTEGER NOT NULL DEFAULT 0,
        disabled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, disabled_at);
    `)).not.toThrow()
    expect(registry.listForUser(1)).toHaveLength(1)
  })
})
