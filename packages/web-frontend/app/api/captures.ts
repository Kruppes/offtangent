import type { Capture, Decision, UploadDescriptor } from '@axiom/core'
export type { Capture, Decision, UploadDescriptor }
export interface CaptureResult { capture: Capture; decision: Decision }
export interface CaptureInput { text: string; clientMessageId: string; source: 'web'; attachments: UploadDescriptor[]; agentId?: string; modelProviderId?: string; modelId?: string }
export interface ApplyCaptureInput { decisionId?: string; action?: Decision['action']; strandId?: string; title?: string }
export interface ClientPersona { id: string; displayName: string; emoji: string | null; color: string | null; isDefault: boolean }
export function newestDecision(captureId: string, decisions: Decision[]) {
  return decisions.filter(d => d.captureId === captureId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}
export function useCapturesApi() {
  const { apiFetch } = useApi()
  return {
    personas: async () => (await apiFetch<{ personas: ClientPersona[] }>('/api/personas/client')).personas,
    create: (body: CaptureInput) => apiFetch<CaptureResult>('/api/captures', { method: 'POST', body: JSON.stringify(body) }),
    list: (status: Capture['status'], offset = 0) => apiFetch<{ captures: Capture[]; decisions: Decision[] }>(`/api/captures?status=${status}&limit=50&offset=${offset}`),
    apply: (id: string, body: ApplyCaptureInput) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify(body) }),
    undo: (id: string) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/undo`, { method: 'POST', body: '{}' }),
    // Throw a tray card away. Undo restores it, so this is not a delete.
    dismiss: (id: string) => apiFetch<CaptureResult>(`/api/captures/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: '{}' }),
    upload: async (files: File[]) => {
      const body = new FormData()
      files.forEach(file => body.append('files', file))
      return (await apiFetch<{ uploads: UploadDescriptor[] }>('/api/uploads', { method: 'POST', body })).uploads
    },
  }
}
