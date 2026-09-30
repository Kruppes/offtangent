import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { saveUploadFromFile, getUploadsDir } from '@axiom/core'
import type { UploadDescriptor } from '@axiom/core'
import { jwtMiddleware } from '../auth.js'
import type { AuthenticatedRequest } from '../auth.js'
import { sendUploadedFile, uploadArray, cleanupRequestUploads } from '../uploads.js'

/**
 * Best effort removal of files this request already moved into the uploads dir
 * before a later file of the same request failed. They are referenced by
 * nothing (the caller never saw the descriptors), so leaving them would just
 * be garbage waiting for the retention sweep.
 */
function removeStoredUploads(uploads: UploadDescriptor[]): void {
  const uploadsDir = path.resolve(getUploadsDir())
  for (const upload of uploads) {
    const absolutePath = path.resolve(uploadsDir, upload.relativePath)
    if (!absolutePath.startsWith(uploadsDir + path.sep)) continue
    try {
      fs.rmSync(absolutePath, { force: true })
    } catch {
      // The cleanup cron sweeps whatever survives here.
    }
  }
}

export function createUploadsRouter(): Router {
  const router = Router()

  /**
   * POST /api/uploads  (multipart/form-data, field `files`, repeatable)
   * -> 201 { uploads: UploadDescriptor[] }
   *
   * Stores files and hands back the descriptors, nothing else. That is what
   * makes it platform neutral: `POST /api/captures` (JSON field `attachments`)
   * and `POST /api/chat/message` (multipart field `attachments`, JSON encoded)
   * both take these descriptors as already stored attachments, so a client can
   * upload once and then decide what the bytes become — a capture, a chat
   * message, or nothing at all.
   *
   * Auth: `jwtMiddleware`, NOT the `jwtHeaderOrQueryMiddleware` this router is
   * mounted behind. The query token exists because `<img src>` / `<a href>`
   * cannot send an Authorization header, i.e. for reads. A `?token=` travels
   * in URLs, referrers, proxy logs and browser history; that is an acceptable
   * exposure for fetching one file the holder may read anyway, but not for a
   * write that consumes disk. Requiring the header here also keeps the write
   * path authenticated if this router is ever mounted without the outer
   * middleware. Effect: header Bearer is mandatory for POST, a query token
   * alone gets 401 — and it is rejected before multer streams a single byte.
   *
   * Error contract (identical to the multipart path of /api/chat/message,
   * which shares `uploadArray`): no file 400, file too large 413, too many
   * files 400, not enough free disk 507.
   */
  router.post('/', jwtMiddleware, uploadArray('files'), (req: AuthenticatedRequest, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      // Non-file parts may still have been buffered; drop whatever is there.
      cleanupRequestUploads(req)
      res.status(400).json({ error: 'At least one file is required', code: 'no_files' })
      return
    }

    const userId = req.user!.userId
    const uploads: UploadDescriptor[] = []
    try {
      for (const file of files) {
        uploads.push(saveUploadFromFile({
          sourcePath: file.path,
          originalName: file.originalname,
          mimeType: file.mimetype,
          source: 'web',
          userId,
        }))
      }
    } catch (err) {
      // Part files of the not-yet-moved rest plus the already moved ones.
      cleanupRequestUploads(req)
      removeStoredUploads(uploads)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOSPC' || code === 'EDQUOT') {
        res.status(507).json({
          error: 'Not enough free disk space on the server to store this upload.',
          code: 'insufficient_storage',
        })
        return
      }
      res.status(500).json({ error: `Upload failed: ${(err as Error).message}` })
      return
    }

    res.status(201).json({ uploads })
  })

  router.get('/*path', sendUploadedFile)
  return router
}
