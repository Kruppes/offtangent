export interface ArtifactRef {
  id: string
  strandId: string
  messageId: number
  agentId: string | null
  kind: 'html' | 'svg' | 'png'
  title: string
  source: string
  mimeType: string
  size: number
  createdAt: string
}

export interface ArtifactDetail {
  artifact: ArtifactRef
  contentUrl: string
  contentExpiresAt: string
  embed: { iframeSandbox: string; iframeReferrerPolicy: string; separateOrigin: boolean; denies: string[] }
}

// srcdoc has no response headers: repeat the content endpoint's restrictive
// policy before any model-authored bytes. Never pass credentials into it.
export const ARTIFACT_DOCUMENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'"

export async function artifactDocument(blob: Blob, kind: ArtifactRef['kind']): Promise<string> {
  const head = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_DOCUMENT_CSP}"><meta name="referrer" content="no-referrer">`
  if (kind === 'html') return head + await blob.text()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const mime = kind === 'svg' ? 'image/svg+xml' : 'image/png'
  return `${head}<img alt="" style="max-width:100%;height:auto" src="data:${mime};base64,${btoa(binary)}">`
}

export function useArtifactsApi() {
  const { apiFetch } = useApi()
  const config = useRuntimeConfig()

  async function loadArtifact(id: string): Promise<{ detail: ArtifactDetail; blob: Blob; document: string }> {
    const detail = await apiFetch<ArtifactDetail>(`/api/artifacts/${encodeURIComponent(id)}`)
    const base = new URL(config.public.apiBase || '/', window.location.origin)
    const url = new URL(detail.contentUrl, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== `/api/artifacts/${id}/content` || !url.searchParams.has('t')
      || url.searchParams.has('token')) throw new Error('Invalid artifact content URL')
    // Fetch bytes through the API host: the optional artifact host need not
    // enable CORS. No app bearer token/cookie reaches the document or request.
    const contentUrl = new URL(url.pathname + url.search, base)
    const response = await fetch(contentUrl, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
    if (!response.ok) throw new Error(`Artifact content: ${response.status}`)
    const blob = await response.blob()
    return { detail, blob, document: await artifactDocument(blob, detail.artifact.kind) }
  }

  return { loadArtifact }
}
