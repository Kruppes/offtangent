import { Router } from 'express'
import { jwtMiddleware } from '../../../auth.js'
import type { AuthenticatedRequest } from '../../../auth.js'
import { createProvidersController } from './controller.js'
import type { ProvidersRouterOptions } from './types.js'

export { type ProvidersRouterOptions } from './types.js'

export function createProvidersRouter(options: ProvidersRouterOptions = {}): Router {
  const router = Router()
  const controller = createProvidersController(options)

  router.use(jwtMiddleware)
  router.use((req: AuthenticatedRequest, res, next) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: 'Admin access required' })
      return
    }

    next()
  })

  router.put('/fallback', controller.putFallback)
  router.get('/', controller.getProviders)
  router.get('/models/:providerType', controller.getModelsByProviderType)

  router.post('/oauth/login', controller.postOAuthLogin)
  router.get('/oauth/status/:loginId', controller.getOAuthStatus)
  router.post('/oauth/code/:loginId', controller.postOAuthCode)

  router.post('/', controller.postProvider)

  router.post('/openai-compatible/models-probe', controller.postOpenAiCompatibleModelsProbe)
  router.post('/ollama-probe', controller.postOllamaProbe)
  router.post('/ollama-probe/pull', controller.postOllamaProbePull)

  router.get('/:id/live-models', controller.getLiveModels)
  router.get('/:id/ollama-models', controller.getOllamaModels)
  router.post('/:id/ollama-pull', controller.postOllamaPull)
  router.delete('/:id/ollama-models/:modelName', controller.deleteOllamaModel)

  router.put('/:id', controller.putProvider)
  router.patch('/:id/models/:modelId', controller.patchProviderModel)
  router.delete('/:id', controller.deleteProvider)
  router.post('/:id/test', controller.postProviderTest)
  router.post('/:id/activate', controller.postProviderActivate)
  router.post('/:id/refresh-quota', controller.postRefreshQuota)

  return router
}
