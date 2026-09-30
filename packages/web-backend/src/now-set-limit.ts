/**
 * The effective now-set size (SPEC 2.8 / 6.2). The limit used to be the
 * constant `NOW_SET_MAX`; it is now the setting `offtangent.nowSetMax` in
 * `settings.json`, with the constant as its default.
 *
 * Reads are deliberately forgiving: a missing, malformed or out-of-range
 * value on disk falls back to the default instead of failing a request. The
 * API rejects an invalid value on write (`PUT /api/settings` -> 400), so a
 * bad value can only reach the file through a hand edit.
 */
import { DEFAULT_NOW_SET_MODE, loadConfig, NOW_SET_MAX, NOW_SET_MAX_RANGE, parseNowSetMode, type NowSetMode } from '@axiom/core'

export interface NowSetLimitSettings {
  offtangent?: { nowSetMax?: unknown; nowSetMode?: unknown }
}

export type LoadNowSetLimitSettings = () => NowSetLimitSettings

const defaultLoadSettings: LoadNowSetLimitSettings = () =>
  loadConfig<NowSetLimitSettings>('settings.json')

export function resolveNowSetMax(loadSettings: LoadNowSetLimitSettings = defaultLoadSettings): number {
  let raw: unknown
  try {
    raw = loadSettings().offtangent?.nowSetMax
  } catch {
    return NOW_SET_MAX
  }
  if (
    typeof raw !== 'number'
    || !Number.isInteger(raw)
    || raw < NOW_SET_MAX_RANGE.min
    || raw > NOW_SET_MAX_RANGE.max
  ) {
    return NOW_SET_MAX
  }
  return raw
}

/**
 * How the now set is filled (`offtangent.nowSetMode`, default `auto`): the
 * computed activity ranking or the hand-curated `now_set` table. Read with
 * the same forgiving rule as the size above — anything but the two known
 * values falls back to the default, and `PUT /api/settings` is what rejects a
 * bad value (400).
 */
export function resolveNowSetMode(loadSettings: LoadNowSetLimitSettings = defaultLoadSettings): NowSetMode {
  let raw: unknown
  try {
    raw = loadSettings().offtangent?.nowSetMode
  } catch {
    return DEFAULT_NOW_SET_MODE
  }
  return parseNowSetMode(raw) ?? DEFAULT_NOW_SET_MODE
}
