import type { ConnectorManifest } from './types.js'

/**
 * Synthetic connector used by tests only. It is deliberately NOT part of the
 * production registry (`registry.ts`): the first real connector lands in P3.
 */
export function createTestConnectorManifest(overrides: Partial<ConnectorManifest> = {}): ConnectorManifest {
  return {
    id: 'sample',
    name: 'Sample service',
    description: 'Synthetic connector for tests.',
    auth: 'oauth2',
    scopes: ['sample.read'],
    dataClass: 'local_only',
    oauth: {
      authorizeUrl: 'https://sample.invalid/oauth/authorize',
      tokenUrl: 'https://sample.invalid/oauth/token',
      revokeUrl: 'https://sample.invalid/oauth/revoke',
      authorizeParams: { access_type: 'offline' },
    },
    createTools: ctx => [
      {
        name: 'sample_read',
        description: 'Reads a synthetic record.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          await ctx.getAccessToken()
          return { content: [{ type: 'text', text: 'sample record' }] }
        },
      } as unknown as ReturnType<ConnectorManifest['createTools']>[number],
    ],
    test: async ctx => {
      const token = await ctx.getAccessToken()
      return { ok: token.length > 0, detail: 'sample ok' }
    },
    ...overrides,
  }
}
