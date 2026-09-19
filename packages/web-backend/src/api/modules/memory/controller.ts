import type { Response } from 'express'
import type { AuthenticatedRequest } from '../../../auth.js'
import {
  createMemoryService,
  InvalidInputError,
  MemoryFileNotFoundError,
  MemorySchedulerUnavailableError,
  NotFoundError,
} from './service.js'
import {
  parseContentBody,
  parseDateParam,
  parseMemoryPathParam,
  parseFactIdParam,
  parseFactsQuery,
  parseProjectNameParam,
  parseWikiFilenameParam,
} from './schema.js'
import type { MemoryModuleOptions } from './types.js'

export interface MemoryController {
  getFileTree: (req: AuthenticatedRequest, res: Response) => void
  getFile: (req: AuthenticatedRequest, res: Response) => void
  putFile: (req: AuthenticatedRequest, res: Response) => void
  deleteFile: (req: AuthenticatedRequest, res: Response) => void
  getSoul: (req: AuthenticatedRequest, res: Response) => void
  putSoul: (req: AuthenticatedRequest, res: Response) => void
  getCoreMemory: (req: AuthenticatedRequest, res: Response) => void
  putCoreMemory: (req: AuthenticatedRequest, res: Response) => void
  getAgentRules: (req: AuthenticatedRequest, res: Response) => void
  putAgentRules: (req: AuthenticatedRequest, res: Response) => void
  getDefaultAgentRules: (req: AuthenticatedRequest, res: Response) => void
  listDailyFiles: (req: AuthenticatedRequest, res: Response) => void
  getDailyFile: (req: AuthenticatedRequest, res: Response) => void
  putDailyFile: (req: AuthenticatedRequest, res: Response) => void
  listWikiPages: (req: AuthenticatedRequest, res: Response) => void
  getWikiPage: (req: AuthenticatedRequest, res: Response) => void
  putWikiPage: (req: AuthenticatedRequest, res: Response) => void
  deleteWikiPage: (req: AuthenticatedRequest, res: Response) => void
  listProjects: (req: AuthenticatedRequest, res: Response) => void
  getProject: (req: AuthenticatedRequest, res: Response) => void
  putProject: (req: AuthenticatedRequest, res: Response) => void
  getHeartbeat: (req: AuthenticatedRequest, res: Response) => void
  putHeartbeat: (req: AuthenticatedRequest, res: Response) => void
  getDefaultHeartbeat: (req: AuthenticatedRequest, res: Response) => void
  getProfile: (req: AuthenticatedRequest, res: Response) => void
  putProfile: (req: AuthenticatedRequest, res: Response) => void
  listFacts: (req: AuthenticatedRequest, res: Response) => void
  getUsageStats: (req: AuthenticatedRequest, res: Response) => void
  putFact: (req: AuthenticatedRequest, res: Response) => void
  deleteFact: (req: AuthenticatedRequest, res: Response) => void
  getConsolidationRules: (req: AuthenticatedRequest, res: Response) => void
  putConsolidationRules: (req: AuthenticatedRequest, res: Response) => void
  getDefaultConsolidationRules: (req: AuthenticatedRequest, res: Response) => void
  getTasksGuidelines: (req: AuthenticatedRequest, res: Response) => void
  putTasksGuidelines: (req: AuthenticatedRequest, res: Response) => void
  getDefaultTasksGuidelines: (req: AuthenticatedRequest, res: Response) => void
  getConsolidationStatus: (req: AuthenticatedRequest, res: Response) => void
  runConsolidation: (req: AuthenticatedRequest, res: Response) => Promise<void>
}

export function createMemoryController(options: MemoryModuleOptions): MemoryController {
  const service = createMemoryService(options)

  return {
    getFileTree(_req, res) {
      try {
        res.json({ files: service.listFileTree() })
      } catch (err) {
        res.status(500).json({ error: `Failed to list memory files: ${(err as Error).message}` })
      }
    },

    getFile(req, res) {
      const parsedPath = parseMemoryPathParam(req.query.path)
      if (!parsedPath.ok) {
        res.status(400).json({ error: parsedPath.error })
        return
      }

      try {
        const content = service.readFileByPath(parsedPath.value)
        res.json({ path: parsedPath.value, content })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to read memory file: ${(err as Error).message}` })
      }
    },

    putFile(req, res) {
      const parsedPath = parseMemoryPathParam(req.query.path)
      if (!parsedPath.ok) {
        res.status(400).json({ error: parsedPath.error })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeFileByPath(parsedPath.value, parsedContent.value)
        res.json({ message: `Memory file "${parsedPath.value}" updated`, path: parsedPath.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write memory file: ${(err as Error).message}` })
      }
    },

    deleteFile(req, res) {
      const parsedPath = parseMemoryPathParam(req.query.path)
      if (!parsedPath.ok) {
        res.status(400).json({ error: parsedPath.error })
        return
      }

      try {
        service.deleteFileByPath(parsedPath.value)
        res.json({ message: `Memory file "${parsedPath.value}" deleted`, path: parsedPath.value })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to delete memory file: ${(err as Error).message}` })
      }
    },

    getSoul(_req, res) {
      try {
        const content = service.readSoul()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read SOUL.md: ${(err as Error).message}` })
      }
    },

    putSoul(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeSoul(parsedContent.value)
        res.json({ message: 'SOUL.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write SOUL.md: ${(err as Error).message}` })
      }
    },

    getCoreMemory(_req, res) {
      try {
        const content = service.readCoreMemory()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read MEMORY.md: ${(err as Error).message}` })
      }
    },

    putCoreMemory(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeCoreMemory(parsedContent.value)
        res.json({ message: 'MEMORY.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write MEMORY.md: ${(err as Error).message}` })
      }
    },

    getAgentRules(_req, res) {
      try {
        const content = service.readAgentRules()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read AGENTS.md: ${(err as Error).message}` })
      }
    },

    putAgentRules(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeAgentRules(parsedContent.value)
        res.json({ message: 'AGENTS.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write AGENTS.md: ${(err as Error).message}` })
      }
    },

    getDefaultAgentRules(_req, res) {
      try {
        res.json({ content: service.readDefaultAgentRules() })
      } catch (err) {
        res.status(500).json({ error: `Failed to load AGENTS.md default: ${(err as Error).message}` })
      }
    },

    listDailyFiles(_req, res) {
      try {
        res.json({ files: service.listDailyFiles() })
      } catch (err) {
        res.status(500).json({ error: `Failed to list daily files: ${(err as Error).message}` })
      }
    },

    getDailyFile(req, res) {
      const parsedDate = parseDateParam(req.params.date)
      if (!parsedDate.ok) {
        res.status(400).json({ error: parsedDate.error })
        return
      }

      try {
        const content = service.readDailyFile(parsedDate.value)
        res.json({ date: parsedDate.value, content })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to read daily file: ${(err as Error).message}` })
      }
    },

    putDailyFile(req, res) {
      const parsedDate = parseDateParam(req.params.date)
      if (!parsedDate.ok) {
        res.status(400).json({ error: parsedDate.error })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeDailyFile(parsedDate.value, parsedContent.value)
        res.json({
          message: `Daily file for ${parsedDate.value} updated`,
          date: parsedDate.value,
          content: parsedContent.value,
        })
      } catch (err) {
        res.status(500).json({ error: `Failed to write daily file: ${(err as Error).message}` })
      }
    },

    listWikiPages(_req, res) {
      try {
        res.json({ files: service.listWikiPages() })
      } catch (err) {
        res.status(500).json({ error: `Failed to list wiki pages: ${(err as Error).message}` })
      }
    },

    getWikiPage(req, res) {
      const parsedFilename = parseWikiFilenameParam(req.params.filename)
      if (!parsedFilename.ok) {
        res.status(400).json({ error: parsedFilename.error })
        return
      }

      try {
        const content = service.readWikiPage(parsedFilename.value.safeFilename)
        res.json({ name: parsedFilename.value.name, content })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to read wiki page: ${(err as Error).message}` })
      }
    },

    putWikiPage(req, res) {
      const parsedFilename = parseWikiFilenameParam(req.params.filename)
      if (!parsedFilename.ok) {
        res.status(400).json({ error: parsedFilename.error })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeWikiPage(parsedFilename.value.safeFilename, parsedContent.value)
        res.json({
          message: `Wiki page "${parsedFilename.value.name}" updated`,
          name: parsedFilename.value.name,
          content: parsedContent.value,
        })
      } catch (err) {
        res.status(500).json({ error: `Failed to write wiki page: ${(err as Error).message}` })
      }
    },

    deleteWikiPage(req, res) {
      const parsedFilename = parseWikiFilenameParam(req.params.filename)
      if (!parsedFilename.ok) {
        res.status(400).json({ error: 'Invalid filename.' })
        return
      }

      try {
        service.deleteWikiPage(parsedFilename.value.safeFilename)
        res.json({ message: `Wiki page "${parsedFilename.value.name}" deleted`, name: parsedFilename.value.name })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to delete wiki page: ${(err as Error).message}` })
      }
    },

    listProjects(_req, res) {
      try {
        res.json({ files: service.listLegacyProjectFiles() })
      } catch (err) {
        res.status(500).json({ error: `Failed to list project files: ${(err as Error).message}` })
      }
    },

    getProject(req, res) {
      const parsedProjectName = parseProjectNameParam(req.params.name)
      if (!parsedProjectName.ok) {
        res.status(400).json({ error: parsedProjectName.error })
        return
      }

      try {
        const content = service.readLegacyProjectFile(parsedProjectName.value)
        res.json({ name: parsedProjectName.value, content })
      } catch (err) {
        if (err instanceof MemoryFileNotFoundError) {
          res.status(404).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to read project file: ${(err as Error).message}` })
      }
    },

    putProject(req, res) {
      const parsedProjectName = parseProjectNameParam(req.params.name)
      if (!parsedProjectName.ok) {
        res.status(400).json({ error: parsedProjectName.error })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeLegacyProjectFile(parsedProjectName.value, parsedContent.value)
        res.json({
          message: `Project file "${parsedProjectName.value}" updated`,
          name: parsedProjectName.value,
          content: parsedContent.value,
        })
      } catch (err) {
        res.status(500).json({ error: `Failed to write project file: ${(err as Error).message}` })
      }
    },

    getHeartbeat(_req, res) {
      try {
        const content = service.readHeartbeat()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read HEARTBEAT.md: ${(err as Error).message}` })
      }
    },

    putHeartbeat(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeHeartbeat(parsedContent.value)
        res.json({ message: 'HEARTBEAT.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write HEARTBEAT.md: ${(err as Error).message}` })
      }
    },

    getDefaultHeartbeat(_req, res) {
      try {
        res.json({ content: service.readDefaultHeartbeat() })
      } catch (err) {
        res.status(500).json({ error: `Failed to load HEARTBEAT.md default: ${(err as Error).message}` })
      }
    },

    getProfile(req, res) {
      const username = req.user?.username
      if (!username) {
        res.status(400).json({ error: 'Username not available from auth' })
        return
      }

      try {
        const content = service.readProfile(username)
        res.json({ username, content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read user profile: ${(err as Error).message}` })
      }
    },

    putProfile(req, res) {
      const username = req.user?.username
      if (!username) {
        res.status(400).json({ error: 'Username not available from auth' })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeProfile(username, parsedContent.value)
        res.json({ message: `Profile for ${username} updated`, username, content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write user profile: ${(err as Error).message}` })
      }
    },

    listFacts(req, res) {
      const parsedQuery = parseFactsQuery(req.query as Record<string, unknown>)
      if (!parsedQuery.ok) {
        res.status(400).json({ error: parsedQuery.error })
        return
      }

      try {
        const result = service.listFacts(parsedQuery.value)
        res.json(result)
      } catch (err) {
        if (err instanceof InvalidInputError) {
          res.status(400).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Failed to list facts: ${(err as Error).message}` })
      }
    },

    getUsageStats(req, res) {
      const rawDays = Number(req.query.days ?? 7)
      const days = Number.isFinite(rawDays) && rawDays >= 1 ? Math.floor(rawDays) : 7

      try {
        res.json(service.getUsageStats(days))
      } catch (err) {
        res.status(500).json({ error: `Failed to load memory usage stats: ${(err as Error).message}` })
      }
    },

    putFact(req, res) {
      const parsedId = parseFactIdParam(req.params.id)
      if (!parsedId.ok) {
        res.status(400).json({ error: parsedId.error })
        return
      }

      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok || !parsedContent.value.trim()) {
        res.status(400).json({ error: 'Content is required' })
        return
      }

      try {
        service.updateFact(parsedId.value, parsedContent.value.trim())
        res.json({ message: 'Fact updated' })
      } catch (err) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: 'Fact not found' })
          return
        }

        res.status(500).json({ error: `Failed to update fact: ${(err as Error).message}` })
      }
    },

    deleteFact(req, res) {
      const parsedId = parseFactIdParam(req.params.id)
      if (!parsedId.ok) {
        res.status(400).json({ error: parsedId.error })
        return
      }

      try {
        service.deleteFact(parsedId.value)
        res.json({ message: 'Fact deleted' })
      } catch (err) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: 'Fact not found' })
          return
        }

        res.status(500).json({ error: `Failed to delete fact: ${(err as Error).message}` })
      }
    },

    getConsolidationRules(_req, res) {
      try {
        const content = service.readConsolidationRules()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read CONSOLIDATION.md: ${(err as Error).message}` })
      }
    },

    putConsolidationRules(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeConsolidationRules(parsedContent.value)
        res.json({ message: 'CONSOLIDATION.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write CONSOLIDATION.md: ${(err as Error).message}` })
      }
    },

    getDefaultConsolidationRules(_req, res) {
      try {
        res.json({ content: service.readDefaultConsolidationRules() })
      } catch (err) {
        res.status(500).json({ error: `Failed to load CONSOLIDATION.md default: ${(err as Error).message}` })
      }
    },

    getTasksGuidelines(_req, res) {
      try {
        const content = service.readTasksGuidelines()
        res.json({ content })
      } catch (err) {
        res.status(500).json({ error: `Failed to read TASKS.md: ${(err as Error).message}` })
      }
    },

    putTasksGuidelines(req, res) {
      const parsedContent = parseContentBody(req.body)
      if (!parsedContent.ok) {
        res.status(400).json({ error: parsedContent.error })
        return
      }

      try {
        service.writeTasksGuidelines(parsedContent.value)
        res.json({ message: 'TASKS.md updated', content: parsedContent.value })
      } catch (err) {
        res.status(500).json({ error: `Failed to write TASKS.md: ${(err as Error).message}` })
      }
    },

    getDefaultTasksGuidelines(_req, res) {
      try {
        res.json({ content: service.readDefaultTasksGuidelines() })
      } catch (err) {
        res.status(500).json({ error: `Failed to load TASKS.md default: ${(err as Error).message}` })
      }
    },

    getConsolidationStatus(_req, res) {
      res.json(service.getConsolidationStatus())
    },

    async runConsolidation(_req, res) {
      try {
        const result = await service.runConsolidation()
        res.json(result)
      } catch (err) {
        if (err instanceof MemorySchedulerUnavailableError) {
          res.status(503).json({ error: err.message })
          return
        }

        res.status(500).json({ error: `Consolidation failed: ${(err as Error).message}` })
      }
    },
  }
}
