import type { AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from '@earendil-works/pi-ai'
import type { Database } from './database.js'
import { logTokenUsage } from './token-logger.js'
import type { SendFileToolOptions } from './send-file-tool.js'
import { createSendFileTool } from './send-file-tool.js'
import { generateImages, loadGeneratorConfig } from './generators.js'

export function createGenerateTool(options: SendFileToolOptions & { db: Database }): AgentTool {
  const send = createSendFileTool(options)
  return {
    name: 'generate', label: 'Generate Image',
    description: 'Generate images using configured routes (ComfyUI, fal, or Codex subscription). Route is optional. Images are delivered as cards to the user. Returns only file paths, dimensions, elapsed seconds and EUR cost, never image bytes.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Image prompt.' }),
      route: Type.Optional(Type.String({ description: 'Route ID; defaults to the configured default or a trigger match.' })),
      ratio: Type.Optional(Type.String({ description: 'Aspect ratio, e.g. 16:9.' })),
      size: Type.Optional(Type.String({ description: 'Size preset or WxH, if route permits.' })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      steps: Type.Optional(Type.Integer({ minimum: 1 })),
      cfg: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('opaque'), Type.Literal('transparent')])),
    }),
    execute: async (id, params, signal, onUpdate) => {
      if (!options.getCurrentToolUserId()) return { content: [{ type: 'text', text: 'Error: no active user for image delivery' }], details: { error: true } }
      try {
        const { route, images } = await generateImages(loadGeneratorConfig(), params as Parameters<typeof generateImages>[1], {
          signal,
          // Book each completed image immediately, before any later generation or delivery can fail.
          // token_usage.estimated_cost is USD; sidecars and tool results use EUR.
          onImage: (image, generatedRoute) => logTokenUsage(options.db, { provider: 'image-generation', model: generatedRoute.id, kind: 'image_generation',
            promptTokens: 0, completionTokens: 0, cacheRead: 0, cacheWrite: 0,
            estimatedCost: image.cost_eur / (generatedRoute.cost.eur_per_usd ?? 0.93),
            sessionId: options.getCurrentInteractiveSessionId?.() || undefined }),
        })
        const delivered = []
        for (const image of images) {
          signal?.throwIfAborted()
          // Reuse the established upload/delivery path and transcript details.
          const result = await send.execute(id, { path: image.path }, signal, onUpdate)
          if ((result.details as { error?: boolean } | undefined)?.error) throw new Error('Image generated but delivery failed')
          delivered.push(...((result.details as { uploadedFiles?: unknown[]; uploadedFile?: unknown } | undefined)?.uploadedFiles ||
            [(result.details as { uploadedFile?: unknown } | undefined)?.uploadedFile].filter(Boolean)))
        }
        return { content: [{ type: 'text', text: JSON.stringify({ route: route.id, images }) }], details: { uploadedFiles: delivered } }
      } catch (e) {
        return { content: [{ type: 'text', text: `Image generation failed: ${e instanceof Error ? e.message : 'unknown error'}` }], details: { error: true } }
      }
    },
  }
}
