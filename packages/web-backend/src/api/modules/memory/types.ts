import type { AgentCore, Database } from '@axiom/core'
import type { MemoryConsolidationScheduler } from '../../../memory-consolidation-scheduler.js'

export interface MemoryModuleOptions {
  db: Database
  getAgentCore?: () => AgentCore | null
  consolidationScheduler?: MemoryConsolidationScheduler | null
}

export interface DailyFileSummary {
  filename: string
  date: string
  size: number
  modifiedAt: string
}

export interface WikiFileSummary {
  filename: string
  name: string
  title: string
  aliases: string[]
  size: number
  modifiedAt: string
}

export interface LegacyProjectFileSummary {
  filename: string
  name: string
  size: number
  modifiedAt: string
}

export interface MemoryTreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  modifiedAt?: string
  children?: MemoryTreeNode[]
}

export interface FactsQuery {
  query?: string
  userId?: number
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
}
