import type { Capture, Decision, UploadDescriptor } from '@axiom/core'
export type { Capture, Decision, UploadDescriptor }
/** One topic part of a capture (split on intake); a single part capture has exactly one. */
export interface CapturePart { index: number; title: string | null; text: string; sentenceIds: number[]; decision: Decision }
/** `parts`/`partCount` are additive: an older backend omits them, which means one part. */
export interface CaptureResult { capture: Capture; decision: Decision; parts?: CapturePart[]; partCount?: number }
/** `destination: 'new_strand'` makes the server open a strand instead of routing; `strandTitle` names it. */
/** `kind: 'voice'` marks a dictated capture (only the transcript is stored, never audio); absent means typed text. */
export interface CaptureInput { text: string; clientMessageId: string; source: 'web'; attachments: UploadDescriptor[]; kind?: 'text' | 'voice'; agentId?: string; modelProviderId?: string; modelId?: string; destination?: 'new_strand'; strandTitle?: string }
export interface ApplyCaptureInput { decisionId?: string; action?: Decision['action']; strandId?: string; title?: string; partIndex?: number }
/** `total` is additive: captures matching the status filter across all pages (an older backend omits it). */
export interface CaptureListPage { captures: Capture[]; decisions: Decision[]; parts?: Record<string, CapturePart[]>; total?: number }
export interface ClientPersona { id: string; displayName: string; emoji: string | null; color: string | null; isDefault: boolean }
export function newestDecision(captureId: string, decisions: Decision[]) {
  return decisions.filter(d => d.captureId === captureId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}
export function useCapturesApi() {
  const { apiFetch } = useApi()
  return {
    personas: async () => (await apiFetch<{ personas: ClientPersona[] }>('/api/personas/client')).personas,
    create: (body: CaptureInput) => apiFetch<CaptureResult>('/api/captures', { method: 'POST', body: JSON.stringify(body) }),
    list: (status: Capture['status'], offset = 0) => apiFetch<CaptureListPage>(`/api/captures?status=${status}&limit=50&offset=${offset}`),
    /** Newest captures of every status (the server caps `limit` at 200). */
    recent: (limit = 200) => apiFetch<CaptureListPage>(`/api/captures?status=all&limit=${limit}&offset=0`),
    apply: (id: string, body: ApplyCaptureInput) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
    undo: (id: string, partIndex?: number) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/undo`, { method: 'POST', body: partIndex === undefined ? '{}' : JSON.stringify({ partIndex }) }),
    /** Undo every part and route the original text as one capture. */
    keepAsOne: (id: string) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/keep-as-one`, { method: 'POST', body: '{}' }),
    // Throw a tray card away. Undo restores it, so this is not a delete.
    dismiss: (id: string) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }),
    upload: async (files: File[]) => {
      const body = new FormData()
      files.forEach(file => body.append('files', file))
      return (await apiFetch<{ uploads: UploadDescriptor[] }>('/api/uploads', { method: 'POST', body })).uploads
    },
  }
}

/** Idempotency key; `crypto.randomUUID` only exists in a secure context (not on http to a LAN address). */
export function captureClientKey(cryptoRef: { randomUUID?: () => string } | undefined = globalThis.crypto): string {
  try { if (typeof cryptoRef?.randomUUID === 'function') return cryptoRef.randomUUID() } catch { /* fall through */ }
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`
}
