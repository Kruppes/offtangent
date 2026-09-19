import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { ensureProjectAssignmentTables } from './project-assignment-schema.js'
import {
  PROJECT_ASSIGNMENT_MAX_DISMISSALS,
  PROJECT_ASSIGN_MIN_CONFIDENCE,
  PROJECT_SUGGEST_MIN_CONFIDENCE,
  assignProjectIfUnset,
  countStrandMessages,
  dismissStrandProject,
  getProjectAssignmentRun,
  getStrandProjectSuggestion,
  isProjectDismissedForStrand,
  putStrandProjectSuggestion,
} from './project-assignment-store.js'
import {
  PROJECT_ASSIGNMENT_MESSAGE_INTERVAL,
  PROJECT_ASSIGNMENT_MIN_MESSAGES,
  buildProjectAssignmentInput,
  buildProjectAssignmentPrompt,
  evaluateStrandProject,
  listAssignmentProjects,
  parseProjectAssignmentOutput,
  planProjectAssignment,
  runProjectAssignment,
} from './project-assignment.js'
import type { ProjectAssignmentInput } from './project-assignment.js'
import type { ResolvedRouterModel } from './router-model.js'

const USER = '1'
const HAUS = 'prj_haus'
const AUTO = 'prj_auto'

let db: Database

function addProject(id: string, name: string, archived = false): void {
  db.prepare(
    `INSERT INTO projects (id, user_id, name, color, archived, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, datetime('now'), datetime('now'))`,
  ).run(id, USER, name, archived ? 1 : 0)
}

function addStrand(id: string, options: { projectId?: string | null; archived?: boolean; type?: string; title?: string } = {}): void {
  db.prepare(
    `INSERT INTO sessions (id, user_id, session_user, source, type, started_at, last_activity, message_count, summary_written, agent_id, title, project_id, archived)
     VALUES (?, 1, ?, 'web', ?, datetime('now'), datetime('now'), 0, 0, 'main', ?, ?, ?)`,
  ).run(
    id,
    USER,
    options.type ?? 'interactive',
    options.title ?? 'Dachrinne',
    options.projectId ?? null,
    options.archived ? 1 : 0,
  )
}

function addMessages(strandId: string, count: number, text = 'Die Dachrinne am Haus ist durch'): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO chat_messages (session_id, user_id, role, content, agent_id, timestamp)
       VALUES (?, 1, ?, ?, 'main', datetime('now'))`,
    ).run(strandId, i % 2 === 0 ? 'user' : 'assistant', `${text} ${i}`)
  }
}

const ENTRY: ResolvedRouterModel = {
  spec: 'test-model',
  threshold: null,
  providerId: 'p1',
  providerName: 'Test',
  modelId: 'test-model',
  composite: 'p1:test-model',
}

/** A completion that always answers with the same object. */
function answering(body: unknown) {
  return async () => JSON.stringify(body)
}

beforeEach(() => {
  db = initDatabase(':memory:')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(1, 'tester', 'x')
  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(2, 'other', 'x')
  addProject(HAUS, 'Haus & Handwerk')
  addProject(AUTO, 'Auto')
})

afterEach(() => {
  db.close()
})

describe('migration', () => {
  it('creates the three assignment tables and is idempotent', () => {
    const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map(r => r.name)
    for (const t of ['strand_project_suggestions', 'strand_project_dismissals', 'strand_project_runs']) {
      expect(tables()).toContain(t)
    }
    ensureProjectAssignmentTables(db)
    ensureProjectAssignmentTables(db)
    for (const t of ['strand_project_suggestions', 'strand_project_dismissals', 'strand_project_runs']) {
      expect(tables()).toContain(t)
    }
  })

  it('adds nothing to sessions and keeps existing rows untouched', () => {
    addStrand('s1', { projectId: HAUS })
    const before = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1')
    const columnsBefore = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)

    ensureProjectAssignmentTables(db)

    const after = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1')
    const columnsAfter = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map(c => c.name)
    expect(after).toEqual(before)
    expect(columnsAfter).toEqual(columnsBefore)
    expect(columnsAfter).not.toContain('project_suggestion')
  })

  it('runs on a database that already holds sessions and messages', () => {
    for (let i = 0; i < 200; i += 1) addStrand(`bulk-${i}`)
    addMessages('bulk-0', 4)
    const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    ensureProjectAssignmentTables(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(sessions)
    expect(countStrandMessages(db, 'bulk-0')).toBe(4)
  })
})

describe('the gate', () => {
  it('waits for the third message', () => {
    addStrand('s1')
    addMessages('s1', PROJECT_ASSIGNMENT_MIN_MESSAGES - 1)
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: false, reason: 'too_few_messages' })

    addMessages('s1', 1)
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: true, messageCount: 3, userId: USER })
  })

  it('refuses a strand that already has a project', () => {
    addStrand('s1', { projectId: HAUS })
    addMessages('s1', 20)
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: false, reason: 'project_already_set' })
    expect(planProjectAssignment(db, 's1', 'session_end')).toEqual({ run: false, reason: 'project_already_set' })
  })

  it('refuses archived strands, background sessions and unknown ids', () => {
    addStrand('arch', { archived: true })
    addMessages('arch', 5)
    addStrand('task', { type: 'task' })
    addMessages('task', 5)
    expect(planProjectAssignment(db, 'arch', 'message')).toEqual({ run: false, reason: 'archived' })
    expect(planProjectAssignment(db, 'task', 'message')).toEqual({ run: false, reason: 'not_interactive' })
    expect(planProjectAssignment(db, 'nope', 'message')).toEqual({ run: false, reason: 'unknown_strand' })
  })

  it('throttles to one run per ten further messages', async () => {
    addStrand('s1')
    addMessages('s1', 3)
    await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: null, confidence: 0.1, reason: 'unklar' }),
    })
    expect(getProjectAssignmentRun(db, 's1')?.lastMessageCount).toBe(3)

    for (let extra = 1; extra < PROJECT_ASSIGNMENT_MESSAGE_INTERVAL; extra += 1) {
      addMessages('s1', 1)
      expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: false, reason: 'rate_limited' })
    }
    addMessages('s1', 1)
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({
      run: true,
      messageCount: 3 + PROJECT_ASSIGNMENT_MESSAGE_INTERVAL,
      userId: USER,
    })
  })

  it('gives a closing session one extra look inside the throttle window', async () => {
    addStrand('s1')
    addMessages('s1', 3)
    await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: null, confidence: 0.1, reason: 'unklar' }),
    })
    addMessages('s1', 2)
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: false, reason: 'rate_limited' })
    expect(planProjectAssignment(db, 's1', 'session_end')).toEqual({ run: true, messageCount: 5, userId: USER })
  })

  it('does not judge the same length twice, not even on session end', async () => {
    addStrand('s1')
    addMessages('s1', 4)
    await evaluateStrandProject(db, 's1', 'session_end', {
      chain: [ENTRY],
      complete: answering({ projectId: null, confidence: 0.1, reason: 'unklar' }),
    })
    expect(planProjectAssignment(db, 's1', 'session_end'))
      .toEqual({ run: false, reason: 'already_evaluated_at_this_length' })
  })

  it('stops for good once the user has thrown enough proposals away', () => {
    addStrand('s1')
    addMessages('s1', 40)
    for (let i = 0; i < PROJECT_ASSIGNMENT_MAX_DISMISSALS; i += 1) {
      addProject(`prj_x${i}`, `X${i}`)
      dismissStrandProject(db, 's1', `prj_x${i}`)
    }
    expect(planProjectAssignment(db, 's1', 'message')).toEqual({ run: false, reason: 'dismissed_often_enough' })
    expect(planProjectAssignment(db, 's1', 'session_end')).toEqual({ run: false, reason: 'dismissed_often_enough' })
  })
})

describe('the confidence bands', () => {
  beforeEach(() => {
    addStrand('s1')
    addMessages('s1', 4)
  })

  it('assigns the project at and above 0.75', async () => {
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: PROJECT_ASSIGN_MIN_CONFIDENCE, reason: 'Dachrinne am Haus' }),
    })
    expect(result.outcome).toBe('assigned')
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string }).project_id)
      .toBe(HAUS)
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
  })

  it('stores a proposal between 0.50 and 0.75 without touching the strand', async () => {
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.62, reason: 'klingt nach Haus' }),
    })
    expect(result.outcome).toBe('suggested')
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string | null }).project_id)
      .toBeNull()
    expect(getStrandProjectSuggestion(db, 's1')).toMatchObject({
      projectId: HAUS,
      projectName: 'Haus & Handwerk',
      confidence: 0.62,
      reason: 'klingt nach Haus',
    })
  })

  it('stores nothing below 0.50', async () => {
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: PROJECT_SUGGEST_MIN_CONFIDENCE - 0.01, reason: 'geraten' }),
    })
    expect(result.outcome).toBe('none')
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string | null }).project_id)
      .toBeNull()
  })

  it('stores nothing when the answer names no project at all', async () => {
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: null, confidence: 0.99, reason: 'gemischter Strand' }),
    })
    expect(result.outcome).toBe('none')
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
  })

  it('records every run, whatever it decided', async () => {
    await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.62, reason: 'klingt nach Haus' }),
    })
    const run = getProjectAssignmentRun(db, 's1')
    expect(run?.runs).toBe(1)
    expect(run?.lastOutcome).toBe('suggested')
    expect(run?.lastConfidence).toBe(0.62)
    expect(run?.lastModel).toBe('p1:test-model')
  })
})

describe('a set project is never overwritten', () => {
  it('leaves a strand that was filed by hand alone', async () => {
    addStrand('s1', { projectId: AUTO })
    addMessages('s1', 12)
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.99, reason: 'ganz sicher Haus' }),
    })
    expect(result.outcome).toBe('skipped')
    expect(result.reason).toBe('project_already_set')
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string }).project_id)
      .toBe(AUTO)
  })

  it('refuses the raw write too, so no caller can move a filed strand', () => {
    addStrand('s1', { projectId: AUTO })
    expect(assignProjectIfUnset(db, 's1', USER, HAUS)).toBe(false)
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string }).project_id)
      .toBe(AUTO)
  })

  it('refuses a project of another user', () => {
    addStrand('s1')
    db.prepare(
      `INSERT INTO projects (id, user_id, name, archived, created_at, updated_at)
       VALUES ('prj_foreign', '2', 'Foreign', 0, datetime('now'), datetime('now'))`,
    ).run()
    expect(assignProjectIfUnset(db, 's1', USER, 'prj_foreign')).toBe(false)
  })

  it('allows an archived project as a target', () => {
    addProject('prj_old', 'Olkus', true)
    addStrand('s1')
    expect(assignProjectIfUnset(db, 's1', USER, 'prj_old')).toBe(true)
  })

  it('drops the open proposal once a project is on the strand', async () => {
    addStrand('s1')
    addMessages('s1', 4)
    await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.6, reason: 'klingt nach Haus' }),
    })
    expect(getStrandProjectSuggestion(db, 's1')).not.toBeNull()
    expect(assignProjectIfUnset(db, 's1', USER, AUTO)).toBe(true)
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
  })
})

describe('a dismissed proposal stays dismissed', () => {
  beforeEach(() => {
    addStrand('s1')
    addMessages('s1', 4)
  })

  it('is never suggested again, however confident a later run is', async () => {
    await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.6, reason: 'klingt nach Haus' }),
    })
    dismissStrandProject(db, 's1', HAUS)
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
    expect(isProjectDismissedForStrand(db, 's1', HAUS)).toBe(true)

    addMessages('s1', PROJECT_ASSIGNMENT_MESSAGE_INTERVAL)
    const second = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.66, reason: 'immer noch Haus' }),
    })
    expect(second.outcome).toBe('none')
    expect(getStrandProjectSuggestion(db, 's1')).toBeNull()
  })

  it('is never assigned automatically either', async () => {
    dismissStrandProject(db, 's1', HAUS)
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: HAUS, confidence: 0.98, reason: 'ganz sicher Haus' }),
    })
    expect(result.outcome).toBe('none')
    expect((db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('s1') as { project_id: string | null }).project_id)
      .toBeNull()
  })

  it('survives a restart, because it lives in the database', () => {
    dismissStrandProject(db, 's1', HAUS)
    const rows = db.prepare('SELECT strand_id, project_id FROM strand_project_dismissals').all()
    expect(rows).toEqual([{ strand_id: 's1', project_id: HAUS }])
    expect(putStrandProjectSuggestion(db, {
      strandId: 's1', userId: USER, projectId: HAUS, confidence: 0.7, reason: 'nochmal',
    })).toBe(false)
  })

  it('does not block a different project', async () => {
    dismissStrandProject(db, 's1', HAUS)
    const result = await evaluateStrandProject(db, 's1', 'message', {
      chain: [ENTRY],
      complete: answering({ projectId: AUTO, confidence: 0.6, reason: 'doch das Auto' }),
    })
    expect(result.outcome).toBe('suggested')
    expect(getStrandProjectSuggestion(db, 's1')?.projectId).toBe(AUTO)
  })
})

describe('the prompt and its answer', () => {
  function input(): ProjectAssignmentInput {
    addStrand('s1')
    addMessages('s1', 4)
    const built = buildProjectAssignmentInput(db, 's1', USER)
    if (!built) throw new Error('no input')
    return built
  }

  it('offers archived projects, flagged', () => {
    addProject('prj_old', 'Olkus', true)
    const projects = listAssignmentProjects(db, USER)
    expect(projects.map(p => p.id)).toContain('prj_old')
    expect(projects.find(p => p.id === 'prj_old')?.archived).toBe(true)
    expect(projects[0]?.archived).toBe(false)
  })

  it('carries the project list, the title and the transcript', () => {
    const prompt = buildProjectAssignmentPrompt(input())
    expect(prompt).toContain(HAUS)
    expect(prompt).toContain('Haus & Handwerk')
    expect(prompt).toContain('Dachrinne')
    expect(prompt).toContain('Answer with the JSON object only.')
  })

  it('accepts a null answer and a fenced answer', () => {
    const built = input()
    expect(parseProjectAssignmentOutput('{"projectId": null, "confidence": 0.2, "reason": "x"}', built))
      .toEqual({ ok: true, proposal: { projectId: null, confidence: 0.2, reason: 'x' } })
    expect(parseProjectAssignmentOutput('```json\n{"projectId": "prj_haus", "confidence": 0.9, "reason": "y"}\n```', built))
      .toEqual({ ok: true, proposal: { projectId: HAUS, confidence: 0.9, reason: 'y' } })
  })

  it('rejects an invented project id, a missing confidence and non-JSON', () => {
    const built = input()
    expect(parseProjectAssignmentOutput('{"projectId": "prj_ghost", "confidence": 0.9}', built).ok).toBe(false)
    expect(parseProjectAssignmentOutput('{"projectId": null}', built).ok).toBe(false)
    expect(parseProjectAssignmentOutput('I think it is the house project.', built).ok).toBe(false)
  })

  it('retries a malformed answer once and then gives up without storing anything', async () => {
    const built = input()
    let calls = 0
    const result = await runProjectAssignment(built, {
      chain: [ENTRY],
      complete: async () => {
        calls += 1
        return 'no json here'
      },
    })
    expect(calls).toBe(2)
    expect(result.proposal).toBeNull()
  })

  it('takes the repaired answer of the second attempt', async () => {
    const built = input()
    let calls = 0
    const result = await runProjectAssignment(built, {
      chain: [ENTRY],
      complete: async () => {
        calls += 1
        return calls === 1 ? 'nonsense' : JSON.stringify({ projectId: HAUS, confidence: 0.8, reason: 'ok' })
      },
    })
    expect(result.proposal).toEqual({ projectId: HAUS, confidence: 0.8, reason: 'ok' })
  })

  it('survives a model that throws and stores nothing', async () => {
    addStrand('s2')
    addMessages('s2', 4)
    const result = await evaluateStrandProject(db, 's2', 'message', {
      chain: [ENTRY],
      complete: async () => {
        throw new Error('provider down')
      },
    })
    expect(result.outcome).toBe('none')
    expect(getStrandProjectSuggestion(db, 's2')).toBeNull()
  })

  it('does nothing at all when the user has no projects', async () => {
    db.prepare('DELETE FROM projects').run()
    addStrand('s3')
    addMessages('s3', 4)
    const result = await evaluateStrandProject(db, 's3', 'message', { chain: [ENTRY], complete: answering({}) })
    expect(result).toEqual({ outcome: 'skipped', reason: 'no_projects' })
  })
})
