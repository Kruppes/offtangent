/**
 * user-settings.ts: small per-user key/value preferences.
 *
 * `settings.json` holds what the INSTANCE does; this table holds what one
 * user wants. The first tenant is the voice-reply switch: whether every
 * finished answer gets a spoken version. It has to live server side (and not
 * only in the app) because answers are also produced without any app in the
 * loop — finished background tasks, router turns — and those should be
 * spoken too when the switch is on.
 *
 * Deliberately a generic key/value table instead of a column per preference:
 * a new preference is then a constant here, not a migration.
 */

import type { Database } from './database.js'

/** Whether finished assistant answers of this user get an automatic voice note. */
export const VOICE_REPLIES_SETTING = 'voiceReplies'

export function ensureUserSettingsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, key)
    );
  `)
}

export function getUserSetting(db: Database, userId: number, key: string): string | null {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?')
    .get(userId, key) as { value: string } | undefined
  return row?.value ?? null
}

export function setUserSetting(db: Database, userId: number, key: string, value: string): void {
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, value)
}

/** Off unless the user switched it on. */
export function getVoiceRepliesEnabled(db: Database, userId: number): boolean {
  return getUserSetting(db, userId, VOICE_REPLIES_SETTING) === '1'
}

export function setVoiceRepliesEnabled(db: Database, userId: number, enabled: boolean): void {
  setUserSetting(db, userId, VOICE_REPLIES_SETTING, enabled ? '1' : '0')
}
