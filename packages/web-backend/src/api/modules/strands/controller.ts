import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  parseDeleteStrandQuery,
  parseFlag,
  parseListStrandsQuery,
  parseNowSetBody,
  parsePatchStrandBody,
  parsePatchStrandModelBody,
  parseResurfaceQuery,
  parseSnoozeBody,
  parseStrandTagsBody,
  parseStrandTasksQuery,
  parseTagBody,
} from './schema.js'
import { StrandServiceError, type StrandsService } from './service.js'

export interface StrandsController {
  listStrands: (req: AuthenticatedRequest, res: Response) => void
  getStrand: (req: AuthenticatedRequest, res: Response) => void
  markStrandRead: (req: AuthenticatedRequest, res: Response) => void
  patchStrandModel: (req: AuthenticatedRequest, res: Response) => void
  patchStrand: (req: AuthenticatedRequest, res: Response) => void
  deletePreview: (req: AuthenticatedRequest, res: Response) => void
  deleteStrand: (req: AuthenticatedRequest, res: Response) => void
  strandTasks: (req: AuthenticatedRequest, res: Response) => void
  setStrandTags: (req: AuthenticatedRequest, res: Response) => void
  listTags: (req: AuthenticatedRequest, res: Response) => void
  createTag: (req: AuthenticatedRequest, res: Response) => void
  patchTag: (req: AuthenticatedRequest, res: Response) => void
  getNow: (req: AuthenticatedRequest, res: Response) => void
  putNow: (req: AuthenticatedRequest, res: Response) => void
  resurface: (req: AuthenticatedRequest, res: Response) => void
  snooze: (req: AuthenticatedRequest, res: Response) => void
  acceptProjectSuggestion: (req: AuthenticatedRequest, res: Response) => void
  dismissProjectSuggestion: (req: AuthenticatedRequest, res: Response) => void
}

function run(res: Response, context: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    if (err instanceof StrandServiceError) {
      res.status(err.status).json({ error: err.message, code: err.code })
      return
    }
    console.error(`[strands] ${context}:`, err)
    res.status(500).json({ error: `${context}: ${(err as Error).message}` })
  }
}

export function createStrandsController(service: StrandsService): StrandsController {
  return {
    listStrands(req, res) {
      const parsed = parseListStrandsQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to list strands', () => {
        res.json({ strands: service.listStrands(req.user!.userId, parsed.value) })
      })
    },

    getStrand(req, res) {
      run(res, 'Failed to read strand', () => {
        res.json({ strand: service.getStrand(req.user!.userId, String(req.params.id)) })
      })
    },

    markStrandRead(req, res) {
      run(res, 'Failed to mark strand as read', () => {
        service.markRead(req.user!.userId, String(req.params.id))
        res.status(204).end()
      })
    },

    patchStrandModel(req, res) {
      const parsed = parsePatchStrandModelBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to update strand model', () => {
        res.json(service.patchStrandModel(req.user!.userId, String(req.params.id), parsed.value))
      })
    },

    patchStrand(req, res) {
      const parsed = parsePatchStrandBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to update strand', () => {
        res.json({ strand: service.patchStrand(req.user!.userId, String(req.params.id), parsed.value) })
      })
    },

    deletePreview(req, res) {
      run(res, 'Failed to build the delete preview', () => {
        const preview = service.deletePreview(req.user!.userId, String(req.params.id))
        res.json(preview)
      })
    },

    deleteStrand(req, res) {
      const query = parseDeleteStrandQuery(req.query as Record<string, unknown>)
      run(res, 'Failed to delete strand', () => {
        res.json({ deleted: service.removeStrand(req.user!.userId, String(req.params.id), query) })
      })
    },

    strandTasks(req, res) {
      const parsed = parseStrandTasksQuery(req.query as Record<string, unknown>)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to list strand tasks', () => {
        const tree = service.strandTasks(req.user!.userId, String(req.params.id), parsed.value)
        res.json({ ...tree, generatedAt: new Date().toISOString() })
      })
    },

    setStrandTags(req, res) {
      const parsed = parseStrandTagsBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to set tags', () => {
        res.json({ strand: service.setTags(req.user!.userId, String(req.params.id), parsed.value) })
      })
    },

    listTags(req, res) {
      run(res, 'Failed to list tags', () => {
        res.json({ tags: service.tags(req.user!.userId, parseFlag(req.query.include_archived)) })
      })
    },

    createTag(req, res) {
      run(res, 'Failed to create tag', () => {
        const result = service.createTag(req.user!.userId, parseTagBody(req.body))
        res.status(result.created ? 201 : 200).json({ tag: result.tag })
      })
    },

    patchTag(req, res) {
      run(res, 'Failed to update tag', () => {
        res.json({ tag: service.patchTag(req.user!.userId, String(req.params.id), parseTagBody(req.body)) })
      })
    },

    getNow(req, res) {
      run(res, 'Failed to read now set', () => {
        res.json({
          strands: service.nowSet(req.user!.userId),
          max: service.nowSetMax(),
          mode: service.nowSetMode(),
        })
      })
    },

    putNow(req, res) {
      const parsed = parseNowSetBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      // A refusal because the set is computed carries the machine-readable
      // `now_set_auto` in BOTH `error` and `code`: the clients of this route
      // (web, app) were built against `{ error: 'now_set_auto' }`, every other
      // error of this router puts the identifier in `code`. `message` keeps
      // the sentence that tells a human what to do about it.
      try {
        const strands = service.replaceNowSet(req.user!.userId, parsed.value)
        res.json({ strands, max: service.nowSetMax(), mode: service.nowSetMode() })
      } catch (err) {
        if (err instanceof StrandServiceError && err.code === 'now_set_auto') {
          res.status(409).json({ error: 'now_set_auto', code: 'now_set_auto', message: err.message })
          return
        }
        run(res, 'Failed to update now set', () => { throw err })
      }
    },

    resurface(req, res) {
      run(res, 'Failed to list resurface items', () => {
        const { limit } = parseResurfaceQuery(req.query as Record<string, unknown>)
        res.json({ items: service.resurface(req.user!.userId, limit) })
      })
    },

    snooze(req, res) {
      const parsed = parseSnoozeBody(req.body)
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code })
        return
      }
      run(res, 'Failed to snooze strand', () => {
        service.snooze(req.user!.userId, String(req.params.strandId), parsed.value)
        res.status(204).end()
      })
    },

    acceptProjectSuggestion(req, res) {
      run(res, 'Failed to accept the project suggestion', () => {
        res.json({ strand: service.acceptProjectSuggestion(req.user!.userId, String(req.params.id)) })
      })
    },

    dismissProjectSuggestion(req, res) {
      run(res, 'Failed to dismiss the project suggestion', () => {
        res.json({ strand: service.dismissProjectSuggestion(req.user!.userId, String(req.params.id)) })
      })
    },
  }
}
