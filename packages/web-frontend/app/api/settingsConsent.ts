export interface ConsentWarning {
  fingerprint: string
  providerName: string
  destination: string
  modelId: string
  role: string
  variant: string
  policy: { region: string; training: string }
  explicitlySelected: boolean
}

/** Retry once, only after the user accepts the exact server-returned scope. */
export async function saveWithModelConsent<T>(
  save: (updates: Record<string, unknown>) => Promise<T>,
  updates: Record<string, unknown>,
  confirm: (warnings: ConsentWarning[]) => boolean | Promise<boolean>,
): Promise<T> {
  try {
    return await save(updates)
  } catch (err) {
    const error = err as { status?: number; body?: { error?: string; selections?: ConsentWarning[] } }
    const warnings = error.body?.selections
    if (error.status !== 409 || error.body?.error !== 'model_consent_required' || !warnings?.length) throw err
    if (!await confirm(warnings)) throw err
    return save({ ...updates, modelConsentTokens: warnings.map(w => w.fingerprint) })
  }
}
