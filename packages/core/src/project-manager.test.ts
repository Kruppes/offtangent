/**
 * Projects light (Offtangent Stufe 2): CRUD, per-user scoping, validation and
 * the detach-on-delete rule.
 *
 * Runs against a real SQLite file (no stubs) because what matters here is
 * exactly what SQL does: ownership scoping, the thread counter and the fact
 * that deleting a project must never delete a conversation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectManager, resolveAssignableProjectId } from './project-manager.js'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { InvalidInputError, ProjectNotFoundError, isProjectNotFoundError } from './errors.js'

describe('ProjectManager', () => {
  let db: Database
  let tmpDir: string
  let projects: ProjectManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-projects-'))
    db = initDatabase(path.join(tmpDir, 'db.sqlite'))
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
    db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')
    projects = new ProjectManager(db)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** Insert a thread row directly — SessionManager is tested elsewhere. */
  function addThread(userId: string, projectId: string | null, options: { archived?: boolean; type?: string } = {}): string {
    const id = `t-${Math.random().toString(16).slice(2)}`
    db.prepare(
      `INSERT INTO sessions (id, source, type, session_user, agent_id, archived, project_id)
       VALUES (?, 'web', ?, ?, 'bob', ?, ?)`,
    ).run(id, options.type ?? 'interactive', userId, options.archived ? 1 : 0, projectId)
    return id
  }

  describe('createProject', () => {
    it('creates a project with a UUID, ISO timestamps and no threads', () => {
      const project = projects.createProject('1', { name: '  Umzug  ', color: '#4F46E5' })

      expect(project.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(project.name).toBe('Umzug')
      expect(project.color).toBe('#4f46e5')
      expect(project.archived).toBe(false)
      expect(project.threadCount).toBe(0)
      expect(project.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
      expect(project.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    })

    it('defaults the colour to null and accepts an empty colour string', () => {
      expect(projects.createProject('1', { name: 'A' }).color).toBeNull()
      expect(projects.createProject('1', { name: 'B', color: '' }).color).toBeNull()
      expect(projects.createProject('1', { name: 'C', color: null }).color).toBeNull()
    })

    it('rejects an empty, over-long or non-string name', () => {
      expect(() => projects.createProject('1', { name: '   ' })).toThrow(InvalidInputError)
      expect(() => projects.createProject('1', { name: 'x'.repeat(81) })).toThrow(/at most 80/)
      expect(() => projects.createProject('1', { name: 42 as unknown as string })).toThrow(InvalidInputError)
      expect(projects.createProject('1', { name: 'x'.repeat(80) }).name).toHaveLength(80)
    })

    it('rejects a malformed colour', () => {
      expect(() => projects.createProject('1', { name: 'A', color: 'red' })).toThrow(/hex string/)
      expect(() => projects.createProject('1', { name: 'A', color: '#fff' })).toThrow(/hex string/)
      expect(() => projects.createProject('1', { name: 'A', color: '#12345g' })).toThrow(/hex string/)
    })
  })

  describe('listProjects', () => {
    it('lists own projects only, active first then alphabetically', () => {
      projects.createProject('1', { name: 'beta' })
      projects.createProject('1', { name: 'Alpha' })
      const archived = projects.createProject('1', { name: 'aardvark' })
      projects.updateProject('1', archived.id, { archived: true })
      projects.createProject('2', { name: 'foreign' })

      expect(projects.listProjects('1').map(p => p.name)).toEqual(['Alpha', 'beta'])
      expect(projects.listProjects('1', { includeArchived: true }).map(p => p.name))
        .toEqual(['Alpha', 'beta', 'aardvark'])
      expect(projects.listProjects('2').map(p => p.name)).toEqual(['foreign'])
    })

    it('counts only the owner\'s non-archived interactive threads', () => {
      const project = projects.createProject('1', { name: 'Counted' })
      addThread('1', project.id)
      addThread('1', project.id)
      addThread('1', project.id, { archived: true })
      addThread('1', project.id, { type: 'task' })
      addThread('2', project.id)
      addThread('1', null)

      expect(projects.listProjects('1')[0].threadCount).toBe(2)
      expect(projects.getProject('1', project.id)?.threadCount).toBe(2)
    })
  })

  describe('getProject', () => {
    it('returns null for unknown and foreign projects', () => {
      const mine = projects.createProject('1', { name: 'mine' })
      expect(projects.getProject('1', mine.id)?.name).toBe('mine')
      expect(projects.getProject('1', 'nope')).toBeNull()
      expect(projects.getProject('2', mine.id)).toBeNull()
    })
  })

  describe('updateProject', () => {
    it('renames, recolours and archives, leaving omitted fields alone', () => {
      const project = projects.createProject('1', { name: 'before', color: '#111111' })

      const renamed = projects.updateProject('1', project.id, { name: ' after ' })
      expect(renamed).toMatchObject({ name: 'after', color: '#111111', archived: false })

      const recoloured = projects.updateProject('1', project.id, { color: null })
      expect(recoloured).toMatchObject({ name: 'after', color: null })

      const archived = projects.updateProject('1', project.id, { archived: true })
      expect(archived).toMatchObject({ archived: true, name: 'after' })

      expect(projects.updateProject('1', project.id, { archived: false })?.archived).toBe(false)
    })

    it('keeps thread assignments when archiving', () => {
      const project = projects.createProject('1', { name: 'Parked' })
      const thread = addThread('1', project.id)
      projects.updateProject('1', project.id, { archived: true })
      expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(thread)).toEqual({ project_id: project.id })
    })

    it('returns null for unknown/foreign projects and validates the patch', () => {
      const project = projects.createProject('1', { name: 'mine' })
      expect(projects.updateProject('1', 'nope', { name: 'x' })).toBeNull()
      expect(projects.updateProject('2', project.id, { name: 'hijacked' })).toBeNull()
      expect(projects.getProject('1', project.id)?.name).toBe('mine')

      expect(() => projects.updateProject('1', project.id, { name: '' })).toThrow(InvalidInputError)
      expect(() => projects.updateProject('1', project.id, { color: 'nope' })).toThrow(InvalidInputError)
      expect(() => projects.updateProject('1', project.id, { archived: 1 as unknown as boolean })).toThrow(InvalidInputError)
    })
  })

  describe('deleteProject', () => {
    it('deletes the project and detaches its threads instead of deleting them', () => {
      const project = projects.createProject('1', { name: 'Doomed' })
      const grouped = addThread('1', project.id)
      const ungrouped = addThread('1', null)

      expect(projects.deleteProject('1', project.id)).toBe(true)
      expect(projects.getProject('1', project.id)).toBeNull()
      expect(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(grouped)).toEqual({ project_id: null })
      expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 2 })
      expect(db.prepare('SELECT id FROM sessions WHERE id = ?').get(ungrouped)).toBeDefined()
    })

    it('refuses unknown and foreign projects', () => {
      const project = projects.createProject('1', { name: 'mine' })
      expect(projects.deleteProject('1', 'nope')).toBe(false)
      expect(projects.deleteProject('2', project.id)).toBe(false)
      expect(projects.getProject('1', project.id)).not.toBeNull()
    })
  })

  describe('resolveAssignableProjectId', () => {
    it('passes through null/undefined/empty as "no project"', () => {
      expect(resolveAssignableProjectId(db, '1', null)).toBeNull()
      expect(resolveAssignableProjectId(db, '1', undefined)).toBeNull()
      expect(resolveAssignableProjectId(db, '1', '')).toBeNull()
    })

    it('accepts an own, active project', () => {
      const project = projects.createProject('1', { name: 'Active' })
      expect(resolveAssignableProjectId(db, '1', project.id)).toBe(project.id)
    })

    it('refuses unknown, foreign and archived projects with project_not_found', () => {
      const foreign = projects.createProject('2', { name: 'foreign' })
      const archived = projects.createProject('1', { name: 'archived' })
      projects.updateProject('1', archived.id, { archived: true })

      for (const id of ['nope', foreign.id, archived.id]) {
        let caught: unknown
        try {
          resolveAssignableProjectId(db, '1', id)
        } catch (err) {
          caught = err
        }
        expect(caught).toBeInstanceOf(ProjectNotFoundError)
        expect(isProjectNotFoundError(caught)).toBe(true)
        expect((caught as ProjectNotFoundError).code).toBe('project_not_found')
      }
    })
  })
})
