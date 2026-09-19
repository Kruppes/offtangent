import type { Response as ExpressResponse } from 'express'
import { PROVIDER_TYPE_PRESETS } from '@axiom/core'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  mapCreatedProviderResponse,
  mapFallbackSetResponse,
  mapOllamaModelsResponse,
  mapOAuthProviderResponse,
  mapProviderActivationResponse,
  mapProvidersListResponse,
  mapUpdatedProviderResponse,
} from './mapper.js'
import {
  parseFallbackPayload,
  parseModelNamePayload,
  parseOAuthCodePayload,
  parseOAuthLoginPayload,
  parseOpenAiCompatibleModelsProbePayload,
  parseOllamaProbePayload,
  parseOllamaPullPayload,
  parseProviderCreatePayload,
  parseProviderModelSelectionPayload,
  parseProviderModelUpdatePayload,
  parseProviderTypeParam,
  parseProviderUpdatePayload,
} from './schema.js'
import {
  createProvidersService,
  ProvidersExternalError,
  ProvidersNotFoundError,
  ProvidersRuntimeError,
  ProvidersValidationError,
} from './service.js'
import type { ProvidersRouterOptions } from './types.js'

export interface ProvidersController {
  putFallback: (req: AuthenticatedRequest, res: ExpressResponse) => void
  getProviders: (req: AuthenticatedRequest, res: ExpressResponse) => void
  getModelsByProviderType: (req: AuthenticatedRequest, res: ExpressResponse) => void
  getLiveModels: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postOAuthLogin: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  getOAuthStatus: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postOAuthCode: (req: AuthenticatedRequest, res: ExpressResponse) => void
  postProvider: (req: AuthenticatedRequest, res: ExpressResponse) => void
  postOpenAiCompatibleModelsProbe: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postOllamaProbe: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postOllamaProbePull: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  getOllamaModels: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postOllamaPull: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  deleteOllamaModel: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  putProvider: (req: AuthenticatedRequest, res: ExpressResponse) => void
  patchProviderModel: (req: AuthenticatedRequest, res: ExpressResponse) => void
  deleteProvider: (req: AuthenticatedRequest, res: ExpressResponse) => void
  postProviderTest: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
  postProviderActivate: (req: AuthenticatedRequest, res: ExpressResponse) => void
  postRefreshQuota: (req: AuthenticatedRequest, res: ExpressResponse) => Promise<void>
}

export function createProvidersController(options: ProvidersRouterOptions = {}): ProvidersController {
  const service = createProvidersService(options)

  return {
    putFallback(req, res) {
      const parsed = parseFallbackPayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const fallback = service.setFallback(parsed.value)
        res.json(mapFallbackSetResponse(fallback.fallbackProvider, fallback.fallbackModel))
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(400).json({ error: (err as Error).message })
      }
    },

    getProviders(_req, res) {
      try {
        const data = service.listProviders()
        res.json(mapProvidersListResponse(data.masked, data.decrypted, options.getQuotaSnapshot?.()))
      } catch (err) {
        res.status(500).json({ error: `Failed to load providers: ${(err as Error).message}` })
      }
    },

    getModelsByProviderType(req, res) {
      const parsedProviderType = parseProviderTypeParam(req.params.providerType)
      if (!parsedProviderType.ok) {
        res.status(400).json({ error: parsedProviderType.error })
        return
      }

      try {
        const models = service.getModelsByProviderType(parsedProviderType.value)
        res.json({ models })
      } catch (err) {
        if (err instanceof ProvidersRuntimeError) {
          res.status(500).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to get models: ${(err as Error).message}` })
      }
    },

    async getLiveModels(req, res) {
      try {
        const models = await service.getLiveModels(String(req.params.id ?? ''))
        res.json({ models })
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(502).json({ error: `Failed to load models: ${(err as Error).message}` })
      }
    },

    async postOAuthLogin(req, res) {
      const parsed = parseOAuthLoginPayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const response = await service.startOAuthLogin(parsed.value)
        res.json(response)
      } catch (err) {
        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    async getOAuthStatus(req, res) {
      try {
        const status = await service.getOAuthStatus(String(req.params.loginId ?? ''))

        if (status.status === 'completed' && status.provider) {
          res.json({
            status: 'completed',
            provider: mapOAuthProviderResponse(status.provider).provider,
          })
          return
        }

        if (status.status === 'error') {
          res.json({ status: 'error', error: status.error })
          return
        }

        res.json({ status: 'pending' })
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ status: 'error', error: err.message })
          return
        }

        res.status(500).json({ status: 'error', error: (err as Error).message })
      }
    },

    postOAuthCode(req, res) {
      const parsedCode = parseOAuthCodePayload(req.body)
      if (!parsedCode.ok) {
        res.status(400).json({ error: parsedCode.error })
        return
      }

      try {
        service.submitOAuthCode(String(req.params.loginId ?? ''), parsedCode.value.code)
        res.json({ status: 'pending', message: 'Code submitted, processing...' })
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    postProvider(req, res) {
      const parsed = parseProviderCreatePayload(req.body, PROVIDER_TYPE_PRESETS)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const provider = service.createProvider(parsed.value)
        res.status(201).json(mapCreatedProviderResponse(provider, parsed.value.apiKey))
      } catch (err) {
        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    async postOpenAiCompatibleModelsProbe(req, res) {
      const parsed = parseOpenAiCompatibleModelsProbePayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const models = await service.probeOpenAiCompatibleModels(parsed.value.baseUrl, parsed.value.apiKey)
        res.json({ models })
      } catch (err) {
        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }
        res.status(502).json({ error: `Failed to load models: ${(err as Error).message}` })
      }
    },

    async postOllamaProbe(req, res) {
      const parsed = parseOllamaProbePayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const data = await service.probeOllamaModels(parsed.value.baseUrl)
        res.json(mapOllamaModelsResponse(data))
      } catch (err) {
        res.status(502).json({ error: `Failed to reach Ollama API: ${(err as Error).message}` })
      }
    },

    async postOllamaProbePull(req, res) {
      const parsed = parseOllamaPullPayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      await streamOllamaPullResponse({
        req,
        res,
        logTag: 'ollama-probe-pull',
        requestPull: (signal) => service.requestOllamaProbePull(parsed.value.baseUrl, parsed.value.modelName, signal),
      })
    },

    async getOllamaModels(req, res) {
      try {
        const data = await service.listOllamaModels(String(req.params.id ?? ''))
        res.json(mapOllamaModelsResponse(data))
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(502).json({ error: `Failed to reach Ollama API: ${(err as Error).message}` })
      }
    },

    async postOllamaPull(req, res) {
      const parsedModelName = parseModelNamePayload(req.body)
      if (!parsedModelName.ok) {
        res.status(400).json({ error: parsedModelName.error })
        return
      }

      await streamOllamaPullResponse({
        req,
        res,
        logTag: 'ollama-pull',
        requestPull: (signal) =>
          service.requestOllamaPull(String(req.params.id ?? ''), parsedModelName.value.modelName, signal),
      })
    },

    async deleteOllamaModel(req, res) {
      try {
        const providerId = String(req.params.id ?? '')
        const modelName = String(req.params.modelName ?? '')
        await service.deleteOllamaModel(providerId, modelName)
        res.json({ message: `Model ${modelName} deleted` })
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(502).json({ error: `Failed to delete model: ${(err as Error).message}` })
      }
    },

    putProvider(req, res) {
      const parsed = parseProviderUpdatePayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      try {
        const provider = service.updateProvider(String(req.params.id ?? ''), parsed.value)
        res.json(mapUpdatedProviderResponse(provider, parsed.value.apiKey))
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    patchProviderModel(req, res) {
      const parsed = parseProviderModelUpdatePayload(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error })
        return
      }

      const providerId = String(req.params.id ?? '')
      const modelId = String(req.params.modelId ?? '')
      if (!providerId || !modelId) {
        res.status(400).json({ error: 'providerId and modelId are required' })
        return
      }

      try {
        const provider = service.updateProviderModel(providerId, modelId, parsed.value)
        res.json(mapUpdatedProviderResponse(provider))
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    deleteProvider(req, res) {
      try {
        service.deleteProvider(String(req.params.id ?? ''))
        res.json({ message: 'Provider deleted' })
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    async postProviderTest(req, res) {
      try {
        const result = await service.testProvider(
          String(req.params.id ?? ''),
          parseProviderModelSelectionPayload(req.body),
        )

        if (!result.success) {
          res.status(200).json({ success: false, error: result.error, modelId: result.modelId })
          return
        }

        res.json(result)
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ success: false, error: `Test failed: ${(err as Error).message}` })
      }
    },

    postProviderActivate(req, res) {
      try {
        const payload = parseProviderModelSelectionPayload(req.body)
        const activation = service.activateProvider(String(req.params.id ?? ''), payload)
        res.json(mapProviderActivationResponse(activation.activeProvider, activation.activeModel))
      } catch (err) {
        if (err instanceof ProvidersNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        if (err instanceof ProvidersValidationError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: (err as Error).message })
      }
    },

    async postRefreshQuota(req, res) {
      if (!options.refreshQuota) {
        res.status(501).json({ error: 'Quota refresh is not available' })
        return
      }

      try {
        const quota = await options.refreshQuota(String(req.params.id ?? ''))
        res.json({ quota })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    },
  }
}

interface StreamPullOptions {
  req: AuthenticatedRequest
  res: ExpressResponse
  logTag: string
  requestPull: (signal: AbortSignal) => Promise<globalThis.Response>
}

async function streamOllamaPullResponse(options: StreamPullOptions): Promise<void> {
  try {
    const abortController = new AbortController()
    options.req.on('close', () => abortController.abort())

    const pullResponse = await options.requestPull(abortController.signal)

    options.res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    options.res.flushHeaders()

    const reader = pullResponse.body?.getReader()
    if (!reader) {
      options.res.write(`data: ${JSON.stringify({ error: 'No response body from Ollama' })}\n\n`)
      options.res.end()
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            options.res.write(`data: ${JSON.stringify(event)}\n\n`)
            if (typeof (options.res as ExpressResponse & { flush?: () => void }).flush === 'function') {
              ;(options.res as ExpressResponse & { flush: () => void }).flush()
            }
          } catch {
            console.warn(`[${options.logTag}] Skipping malformed NDJSON line: ${line.substring(0, 200)}`)
          }
        }
      }

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer)
          options.res.write(`data: ${JSON.stringify(event)}\n\n`)
        } catch {
          console.warn(`[${options.logTag}] Skipping malformed trailing NDJSON: ${buffer.substring(0, 200)}`)
        }
      }
    } finally {
      reader.releaseLock()
    }

    options.res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
    options.res.end()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      if (!options.res.writableEnded) {
        options.res.end()
      }
      return
    }

    if (!options.res.headersSent) {
      if (err instanceof ProvidersNotFoundError) {
        options.res.status(404).json({ error: err.message })
        return
      }

      if (err instanceof ProvidersValidationError) {
        options.res.status(400).json({ error: err.message })
        return
      }

      if (err instanceof ProvidersExternalError) {
        options.res.status(502).json({ error: `Failed to pull model: ${err.message}` })
        return
      }

      options.res.status(502).json({ error: `Failed to pull model: ${(err as Error).message}` })
      return
    }

    options.res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`)
    options.res.end()
  }
}
