/**
 * Unsaved-changes detection for the shared settings form.
 *
 * The form is a plain JSON-shaped object (it is what PUT /api/settings gets),
 * so a stable serialisation is enough: keys are sorted so that an object
 * rebuilt in a different key order does not count as a change.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, stable((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

export function formSnapshot(value: unknown): string {
  return JSON.stringify(stable(value))
}

/** No baseline yet (still loading) or no form means nothing can be lost. */
export function isFormDirty(baseline: string | null, current: unknown): boolean {
  if (baseline === null || current === null || current === undefined) return false
  return formSnapshot(current) !== baseline
}
