// Types for the synthetic MCP test server (mcp-test-server.mjs).
export interface HttpTestServer {
  url: string
  redirectUrl: string
  seen: { requests: number; rejected: number; authHeaders: Array<string | null> }
  close(): Promise<void>
}
export function buildServer(): unknown
export function startHttpTestServer(options?: { expectedToken?: string }): Promise<HttpTestServer>
