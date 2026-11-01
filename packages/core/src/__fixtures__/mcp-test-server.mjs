/* global process, setTimeout, Buffer, Headers, Request */
// Synthetic MCP server for the MCP client integration tests. Never talks to
// anything real. Run as `node mcp-test-server.mjs stdio` for the stdio
// transport; tests import `startHttpTestServer` for Streamable HTTP.
import { createServer } from 'node:http'
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import * as z from 'zod'

export function buildServer() {
  const server = new McpServer({ name: 'offtangent-test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('echo', {
    // Runtime probe (review P1-1): a server may smuggle any text into its metadata.
    description: 'Echo the given text back.' + (process.env.MCP_TEST_DESCRIPTION_SUFFIX ?? ''),
    inputSchema: z.object({ text: z.string() }),
  }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }))
  server.registerTool('env_probe', {
    description: 'Report which environment variables are visible.',
    inputSchema: z.object({}),
  }, async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        token: process.env.MCP_TEST_TOKEN ?? null,
        leak: process.env.OFFTANGENT_LEAK_PROBE ?? null,
      }),
    }],
  }))
  server.registerTool('slow', {
    description: 'Sleep for ms milliseconds.',
    inputSchema: z.object({ ms: z.number() }),
  }, async ({ ms }) => {
    await new Promise(resolve => setTimeout(resolve, ms))
    return { content: [{ type: 'text', text: 'done' }] }
  })
  server.registerTool('fail', {
    description: 'Always returns a tool error.',
    inputSchema: z.object({}),
  }, async () => ({ isError: true, content: [{ type: 'text', text: 'tool failed on purpose' }] }))
  server.registerTool('big', {
    description: 'Return a large text.',
    inputSchema: z.object({ size: z.number() }),
  }, async ({ size }) => ({ content: [{ type: 'text', text: 'x'.repeat(size) }] }))
  server.registerTool('image', {
    description: 'Return an image block.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'caption' }] }))
  server.registerTool('dangerous', {
    description: 'A tool that a config may deny.',
    inputSchema: z.object({}),
  }, async () => ({ content: [{ type: 'text', text: 'should not run' }] }))
  return server
}

/**
 * Stateless Streamable HTTP server on 127.0.0.1 (random port). Requests must
 * carry `Authorization: Bearer <expectedToken>` when one is given.
 */
export async function startHttpTestServer({ expectedToken } = {}) {
  const seen = { requests: 0, rejected: 0, authHeaders: [] }
  const http = createServer(async (req, res) => {
    seen.requests++
    seen.authHeaders.push(req.headers.authorization ?? null)
    if (expectedToken && req.headers.authorization !== `Bearer ${expectedToken}`) {
      seen.rejected++
      res.writeHead(401).end('unauthorized')
      return
    }
    if (req.url === '/redirect') {
      res.writeHead(307, { location: '/mcp' }).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body })
    const server = buildServer()
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
    res.end(Buffer.from(await response.arrayBuffer()))
    await server.close().catch(() => {})
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address()
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    redirectUrl: `http://127.0.0.1:${port}/redirect`,
    seen,
    close: () => new Promise(resolve => { http.closeAllConnections?.(); http.close(() => resolve()) }),
  }
}

if (process.argv[2] === 'stdio') {
  const { StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
  await buildServer().connect(new StdioServerTransport())
}
