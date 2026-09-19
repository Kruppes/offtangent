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
import { loadConfig, NOW_SET_MAX, NOW_SET_MAX_RANGE } from '@axiom/core'

export interface NowSetLimitSettings {
  offtangent?: { nowSetMax?: unknown }
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
