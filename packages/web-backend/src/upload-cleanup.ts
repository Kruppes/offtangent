import type { Database } from '@axiom/core'
import { cleanupExpiredUploads } from '@axiom/core'

export class UploadCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private db: Database) {}

  start(): void {
    this.runOnce()
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.runOnce(), 6 * 60 * 60 * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  runOnce(): void {
    const result = cleanupExpiredUploads(this.db)
    if (result.deletedFiles > 0 || result.deletedMessages > 0) {
      console.log(`[uploads] cleanup removed ${result.deletedFiles} files from ${result.deletedMessages} chat messages`)
    }
  }
}
