/**
 * Build commit shown next to the version (W6b). The commit arrives as the
 * Docker build arg `GIT_SHA` (the build context has no `.git`), or from
 * `git rev-parse` in a local build. Only a plain hex commit id is accepted;
 * anything else is dropped, so a stray value never reaches the UI.
 */
const SHA = /^[0-9a-f]{1,40}$/

/** A hex commit id (max 40 chars) shortened to 7, or '' for empty/invalid input. */
export function normalizeBuildSha(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().toLowerCase()
  if (!SHA.test(value)) return ''
  return value.slice(0, 7)
}

/** "v0.30.0 · abc1234", or just "v0.30.0" without a (valid) commit. */
export function formatVersionLabel(version: string, sha: unknown): string {
  const short = normalizeBuildSha(sha)
  return short ? `v${version} · ${short}` : `v${version}`
}
