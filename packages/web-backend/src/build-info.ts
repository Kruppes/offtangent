/**
 * Build commit of the running image (W6b). The Docker build passes it as
 * `GIT_SHA` (build arg, kept as ENV in the image). Only a plain hex commit id
 * of at most 40 chars is accepted and shortened to 7; anything else is ''.
 */
const SHA = /^[0-9a-f]{1,40}$/

export function normalizeBuildSha(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().toLowerCase()
  return SHA.test(value) ? value.slice(0, 7) : ''
}

/** `{ buildSha }` when the process knows its commit, `{}` otherwise (additive field). */
export function buildShaField(env: NodeJS.ProcessEnv = process.env): { buildSha?: string } {
  const sha = normalizeBuildSha(env.GIT_SHA)
  return sha ? { buildSha: sha } : {}
}
