import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import { parseAgentId, parseCreatePersonaPayload, parseUpdatePersonaPayload } from './schema.js'
import { PersonaServiceError } from './service.js'
import type { PersonasService } from './service.js'

export interface PersonasController {
  list: (req: AuthenticatedRequest, res: Response) => void
  get: (req: AuthenticatedRequest, res: Response) => void
  update: (req: AuthenticatedRequest, res: Response) => void
  create: (req: AuthenticatedRequest, res: Response) => void
  deletePreview: (req: AuthenticatedRequest, res: Response) => void
  remove: (req: AuthenticatedRequest, res: Response) => void
}

/**
 * One audit line per write. Persona files carry tool access, so who changed
 * which persona when is worth a log line even on a single user install.
 */
function audit(action: string, agentId: string, req: AuthenticatedRequest): void {
  console.log(JSON.stringify({
    prefix: '[personas-audit]',
    action,
    agentId,
    user: req.user?.username ?? 'unknown',
    timestamp: new Date().toISOString(),
  }))
}

/**
 * Turn any thrown value into a response. A {@link PersonaServiceError} carries
 * its own status and code; anything else becomes a flat 500 whose message is
 * deliberately generic — a filesystem path or a stack trace in an API error is
 * a small information leak with no upside for the user.
 */
function fail(res: Response, error: unknown, fallback: string): void {
  if (error instanceof PersonaServiceError) {
    res.status(error.status).json({ error: error.message, code: error.code })
    return
  }
  console.error('[personas]', fallback, error)
  res.status(500).json({ error: fallback, code: 'internal_error' })
}

export function createPersonasController(service: PersonasService): PersonasController {
  /** Validate `:id` once, answer 400 with a code if it is not an id at all. */
  function readId(req: AuthenticatedRequest, res: Response): string | null {
    const result = parseAgentId(req.params.id)
    if (!result.ok) {
      res.status(400).json({ error: result.error, code: 'invalid_id' })
      return null
    }
    return result.value
  }

  return {
    list(_req, res) {
      try {
        res.json(service.listPersonas())
      } catch (error) {
        fail(res, error, 'Failed to list personas')
      }
    },

    get(req, res) {
      const id = readId(req, res)
      if (!id) return
      try {
        res.json(service.getPersona(id))
      } catch (error) {
        fail(res, error, 'Failed to read persona')
      }
    },

    update(req, res) {
      const id = readId(req, res)
      if (!id) return

      const bodyResult = parseUpdatePersonaPayload(req.body)
      if (!bodyResult.ok) {
        res.status(400).json({ error: bodyResult.error, code: 'invalid_body' })
        return
      }

      try {
        const persona = service.updatePersona(id, bodyResult.value)
        audit('update', id, req)
        res.json(persona)
      } catch (error) {
        fail(res, error, 'Failed to update persona')
      }
    },

    create(req, res) {
      const bodyResult = parseCreatePersonaPayload(req.body)
      if (!bodyResult.ok) {
        res.status(400).json({ error: bodyResult.error, code: 'invalid_body' })
        return
      }

      try {
        const persona = service.createPersona(bodyResult.value)
        audit('create', bodyResult.value.id, req)
        res.status(201).json(persona)
      } catch (error) {
        fail(res, error, 'Failed to create persona')
      }
    },

    deletePreview(req, res) {
      const id = readId(req, res)
      if (!id) return
      try {
        res.json(service.deletePreview(id))
      } catch (error) {
        fail(res, error, 'Failed to read delete preview')
      }
    },

    remove(req, res) {
      const id = readId(req, res)
      if (!id) return

      // SPEC 13.5: archive is what people usually mean. A hard delete is only
      // reachable with an explicit confirmation, exactly like a strand delete.
      const confirm = req.query.confirm
      if (confirm !== '1' && confirm !== 'true') {
        res.status(400).json({
          error: 'Deleting a persona requires confirm=1. Archive it instead with PUT { "archived": true }.',
          code: 'confirm_required',
        })
        return
      }

      try {
        service.deletePersona(id)
        audit('delete', id, req)
        res.json({ message: `Persona "${id}" deleted` })
      } catch (error) {
        fail(res, error, 'Failed to delete persona')
      }
    },
  }
}
