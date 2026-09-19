/**
 * Offtangent Stufe 2: threads carry a `projectId`.
 *
 * The thread side of projects light — creating/moving a thread into a project,
 * the refusal rules (foreign / archived / unknown project) and the list
 * filters ("in project X" and "without a project").
 *
 * `scopedAgentMemory: false` + a temp `memoryDir`: these tests must never
 * write into a real persona memory directory under /data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from './session-manager.js'
import { ProjectManager } from './project-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ProjectNotFoundError } from './errors.js'

describe('SessionManager threads × projects', () => {
  let db: Database
  let tmpDir: string
  let memoryDir: string
  let sm: SessionManager
  let projects: ProjectManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-thread-projects-'))
    memoryDir = path.join(tmpDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')
    sm = new SessionManager({
      db,
      memoryDir,
      timeoutMinutes: 15,
      scopedAgentMemory: false,
      agentsBaseDir: path.join(tmpDir, 'agents'),
    })
    projects = new ProjectManager(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates threads without a project by default', () => {
    expect(sm.createThread('1', 'bob', 'Loose').projectId).toBeNull()
  })

  it('creates a thread inside an own, active project', () => {
    const project = projects.createProject('1', { name: 'Umzug' })
    const thread = sm.createThread('1', 'bob', 'Kisten', project.id)

    expect(thread.projectId).toBe(project.id)
    expect(sm.getThread('1', thread.id)?.projectId).toBe(project.id)
    expect(projects.getProject('1', project.id)?.threadCount).toBe(1)
  })

  it('refuses to create a thread in an unknown/foreign/archived project and leaves no row behind', () => {
    const foreign = projects.createProject('2', { name: 'foreign' })
    const archived = projects.createProject('1', { name: 'archived' })
    projects.updateProject('1', archived.id, { archived: true })

    for (const id of ['nope', foreign.id, archived.id]) {
      expect(() => sm.createThread('1', 'bob', 'nope', id)).toThrow(ProjectNotFoundError)
    }
    expect(db.prepare("SELECT COUNT(*) AS c FROM sessions").get()).toEqual({ c: 0 })
  })

  it('moves a thread into a project and back out again', () => {
    const project = projects.createProject('1', { name: 'Umzug' })
    const thread = sm.createThread('1', 'bob', 'Kisten')

    expect(sm.updateThread('1', thread.id, { projectId: project.id })?.projectId).toBe(project.id)
    expect(sm.updateThread('1', thread.id, { projectId: null })?.projectId).toBeNull()
  })

  it('refuses a foreign/archived project on update without changing the thread', () => {
    const project = projects.createProject('1', { name: 'Umzug' })
    const foreign = projects.createProject('2', { name: 'foreign' })
    const thread = sm.createThread('1', 'bob', 'Kisten', project.id)

    expect(() => sm.updateThread('1', thread.id, { projectId: foreign.id })).toThrow(ProjectNotFoundError)
    expect(() => sm.updateThread('1', thread.id, { projectId: 'nope' })).toThrow(ProjectNotFoundError)
    projects.updateProject('1', project.id, { archived: true })
    const other = projects.createProject('1', { name: 'other' })
    projects.updateProject('1', other.id, { archived: true })
    expect(() => sm.updateThread('1', thread.id, { projectId: other.id })).toThrow(ProjectNotFoundError)

    expect(sm.getThread('1', thread.id)?.projectId).toBe(project.id)
  })

  it('leaves the project untouched when the patch omits projectId', () => {
    const project = projects.createProject('1', { name: 'Umzug' })
    const thread = sm.createThread('1', 'bob', 'Kisten', project.id)
    expect(sm.updateThread('1', thread.id, { title: 'Kisten packen' })?.projectId).toBe(project.id)
  })

  it('filters the thread list by project and by "no project"', () => {
    const project = projects.createProject('1', { name: 'Umzug' })
    const otherProject = projects.createProject('1', { name: 'Steuer' })
    const inProject = sm.createThread('1', 'bob', 'Kisten', project.id)
    const inOther = sm.createThread('1', 'bob', 'Belege', otherProject.id)
    const loose = sm.createThread('1', 'bob', 'Loose')

    expect(sm.listThreads('1').map(t => t.id).sort()).toEqual([inProject.id, inOther.id, loose.id].sort())
    expect(sm.listThreads('1', { projectId: project.id }).map(t => t.id)).toEqual([inProject.id])
    expect(sm.listThreads('1', { projectId: null }).map(t => t.id)).toEqual([loose.id])
    expect(sm.listThreads('1', { projectId: 'unknown' })).toEqual([])
  })

  it('detaches threads when the project is deleted (thread survives)', () => {
    const project = projects.createProject('1', { name: 'Doomed' })
    const thread = sm.createThread('1', 'bob', 'Kisten', project.id)

    expect(projects.deleteProject('1', project.id)).toBe(true)
    expect(sm.getThread('1', thread.id)?.projectId).toBeNull()
    expect(sm.listThreads('1').map(t => t.id)).toEqual([thread.id])
  })
})
