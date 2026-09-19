import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import { SessionManager } from './session-manager.js'
import {
  confidenceBand,
  parseRouterOutput,
  runRouter,
  selectCandidates,
  listRouterProjects,
  captureKeywords,
  syntheticProposal,
  buildRepairPrompt,
  buildRouterUserPrompt,
  ROUTER_PROJECT_CAP,
  ROUTER_LAST_MESSAGE_CHARS,
  PROJECT_SUGGESTION_MIN_CONFIDENCE,
  LOW_CONFIDENCE_APPEND_MARKER,
  ROUTER_INTENT_RULES,
  ROUTER_SYSTEM_PROMPT,
  addressStrength,
  declaresSelfNote,
  captureLanguage,
} from './capture-router.js'
import type { RouterInput } from './capture-router.js'
import { parseRouterChain } from './router-model.js'
import type { ResolvedRouterModel } from './router-model.js'
import { addStrandTags, setNowSet } from './strand-store.js'

function input(overrides: Partial<RouterInput> = {}): RouterInput {
  return {
    capture: { id: 'cap_1', text: 'the roofer called back, 4200 for the north side', kind: 'text', personaHint: null, createdAt: '2026-09-13T10:00:00.000Z' },
    candidates: [
      { strandId: 's1', title: 'Haus Dach', personaId: 'main', projectId: null, projectName: null, tags: ['haus'], lastActivity: '2026-09-10T00:00:00.000Z', summary: '', tail: [], lastMessage: '' },
      { strandId: 's2', title: 'Budget', personaId: 'main', projectId: 'prj_geld', projectName: 'Geld', tags: ['geld'], lastActivity: '2026-09-09T00:00:00.000Z', summary: '', tail: [], lastMessage: '' },
    ],
    projects: [{ id: 'prj_haus', name: 'Haus' }, { id: 'prj_geld', name: 'Geld' }],
    nowSet: ['s1'],
    knownTags: ['haus', 'geld'],
    personas: ['main', 'bob'],
    defaultPersona: 'main',
    now: '2026-09-13T10:00:00.000Z',
    ...overrides,
  }
}

function entry(spec: string, threshold: number | null = null): ResolvedRouterModel {
  return { spec, threshold, providerId: 'p', providerName: 'P', modelId: spec, composite: `p:${spec}` }
}

describe('confidenceBand', () => {
  it('maps SPEC 4.4 bands', () => {
    expect(confidenceBand(0.7)).toBe('high')
    expect(confidenceBand(0.95)).toBe('high')
    expect(confidenceBand(0.4)).toBe('medium')
    expect(confidenceBand(0.69)).toBe('medium')
    expect(confidenceBand(0.39)).toBe('low')
    expect(confidenceBand(0)).toBe('low')
  })
})

describe('parseRouterChain', () => {
  it('parses specs with optional thresholds and keeps colons in model ids', () => {
    expect(parseRouterChain('claude-sonnet-5, gpt-5.4-nano:0.9, ministral-3:14b')).toEqual([
      { spec: 'claude-sonnet-5', threshold: null },
      { spec: 'gpt-5.4-nano', threshold: 0.9 },
      { spec: 'ministral-3:14b', threshold: null },
    ])
    expect(parseRouterChain(['a:1.0', ' ', 'b'])).toEqual([
      { spec: 'a', threshold: 1 },
      { spec: 'b', threshold: null },
    ])
    expect(parseRouterChain(undefined)).toEqual([])
  })
})

describe('parseRouterOutput', () => {
  it('accepts a valid append answer, also inside a code fence', () => {
    const text = '```json\n' + JSON.stringify({
      action: 'append', strandId: 's1', intent: 'note', confidence: 0.82, tags: ['Haus', 'handwerker'],
      rationale: 'same roofer thread',
      alternatives: [
        { action: 'append', strandId: 's2', confidence: 0.07, reason: 'budget' },
        { action: 'new_strand', title: 'Dach Angebot Nord', confidence: 0.11, reason: 'own thread' },
        { action: 'append', strandId: 's1', confidence: 0.5, reason: 'repeats the chosen target' },
        { action: 'append', strandId: 'unknown', confidence: 0.5, reason: 'unknown strand' },
      ],
    }) + '\n```'
    const parsed = parseRouterOutput(text, input())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.action).toBe('append')
    expect(parsed.proposal.strandId).toBe('s1')
    expect(parsed.proposal.tags).toEqual(['haus', 'handwerker'])
    expect(parsed.proposal.alternatives.map(a => [a.action, a.strandId, a.confidence])).toEqual([
      ['new_strand', null, 0.11],
      ['append', 's2', 0.07],
    ])
  })

  it('rejects append with an unknown strand and link without a distinct secondary', () => {
    expect(parseRouterOutput(JSON.stringify({ action: 'append', strandId: 'nope', confidence: 0.9 }), input()).ok).toBe(false)
    expect(parseRouterOutput(JSON.stringify({ action: 'link', strandId: 's1', secondaryStrandId: 's1', confidence: 0.9 }), input()).ok).toBe(false)
    const ok = parseRouterOutput(JSON.stringify({ action: 'link', strandId: 's1', secondaryStrandId: 's2', confidence: 0.9 }), input())
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.proposal.secondaryStrandId).toBe('s2')
  })

  it('requires a title for new_strand and falls back to a known persona', () => {
    expect(parseRouterOutput(JSON.stringify({ action: 'new_strand', newStrand: { title: '' }, confidence: 0.5 }), input()).ok).toBe(false)
    const parsed = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'x'.repeat(100), personaId: 'ghost', tags: ['a'] }, confidence: 1.4, tags: ['b'],
    }), input({ capture: { ...input().capture, personaHint: 'bob' } }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.newStrand?.title.length).toBe(60)
    expect(parsed.proposal.newStrand?.personaId).toBe('bob')
    expect(parsed.proposal.newStrand?.tags).toEqual(['a', 'b'])
    expect(parsed.proposal.confidence).toBe(1)
    expect(parsed.proposal.intent).toBe('note')
  })

  it('accepts a new_strand project from the list and rejects an unknown one (SPEC 4.2b)', () => {
    const ok = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Dach Nord', personaId: 'main', tags: [], projectId: 'prj_haus' }, confidence: 0.8,
    }), input())
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.proposal.newStrand?.projectId).toBe('prj_haus')

    const unknown = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Dach Nord', personaId: 'main', tags: [], projectId: 'prj_ghost' }, confidence: 0.8,
    }), input())
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('projectId')

    const wrongType = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Dach Nord', personaId: 'main', tags: [], projectId: 17 }, confidence: 0.8,
    }), input())
    expect(wrongType.ok).toBe(false)

    // No projects at all: any project id is unknown by definition.
    const noProjects = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Dach Nord', personaId: 'main', tags: [], projectId: 'prj_haus' }, confidence: 0.8,
    }), input({ projects: [] }))
    expect(noProjects.ok).toBe(false)

    // Explicit null and omission are both fine.
    for (const ns of [{ title: 'X', personaId: 'main', tags: [], projectId: null }, { title: 'X', personaId: 'main', tags: [] }]) {
      const parsed = parseRouterOutput(JSON.stringify({ action: 'new_strand', newStrand: ns, confidence: 0.5 }), input())
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.proposal.newStrand?.projectId).toBeNull()
    }
  })

  it('keeps a confident project suggestion for a project free strand and drops a weak one', () => {
    const strong = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', confidence: 0.8,
      projectSuggestion: { projectId: 'prj_haus', confidence: 0.72, reason: 'the whole strand is about the house' },
    }), input())
    expect(strong.ok).toBe(true)
    if (strong.ok) {
      expect(strong.proposal.projectSuggestion).toEqual({
        projectId: 'prj_haus', confidence: 0.72, reason: 'the whole strand is about the house',
      })
    }

    const justUnder = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', confidence: 0.8,
      projectSuggestion: { projectId: 'prj_haus', confidence: PROJECT_SUGGESTION_MIN_CONFIDENCE - 0.01, reason: 'maybe' },
    }), input())
    expect(justUnder.ok).toBe(true)
    if (justUnder.ok) expect(justUnder.proposal.projectSuggestion).toBeNull()

    const atThreshold = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', confidence: 0.8,
      projectSuggestion: { projectId: 'prj_haus', confidence: PROJECT_SUGGESTION_MIN_CONFIDENCE, reason: 'fits' },
    }), input())
    expect(atThreshold.ok).toBe(true)
    if (atThreshold.ok) expect(atThreshold.proposal.projectSuggestion?.projectId).toBe('prj_haus')
  })

  it('drops a project suggestion for a strand that already has a project, for new_strand and for unknown projects', () => {
    // s2 already belongs to prj_geld.
    const taken = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's2', confidence: 0.8,
      projectSuggestion: { projectId: 'prj_haus', confidence: 0.9, reason: 'move it' },
    }), input())
    expect(taken.ok).toBe(true)
    if (taken.ok) expect(taken.proposal.projectSuggestion).toBeNull()

    const onNewStrand = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Fresh', personaId: 'main', tags: [] }, confidence: 0.8,
      projectSuggestion: { projectId: 'prj_haus', confidence: 0.9, reason: 'belongs to the house' },
    }), input())
    expect(onNewStrand.ok).toBe(true)
    if (onNewStrand.ok) expect(onNewStrand.proposal.projectSuggestion).toBeNull()

    const unknownProject = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', confidence: 0.8,
      projectSuggestion: { projectId: 'prj_ghost', confidence: 0.9, reason: 'invented' },
    }), input())
    expect(unknownProject.ok).toBe(true)
    if (unknownProject.ok) expect(unknownProject.proposal.projectSuggestion).toBeNull()

    const garbage = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', confidence: 0.8, projectSuggestion: 'prj_haus',
    }), input())
    expect(garbage.ok).toBe(true)
    if (garbage.ok) expect(garbage.proposal.projectSuggestion).toBeNull()
  })

  it('accepts an answer without any project field unchanged (old model, old router)', () => {
    const parsed = parseRouterOutput(JSON.stringify({
      action: 'append', strandId: 's1', intent: 'note', confidence: 0.82, tags: ['haus'], rationale: 'same thread',
    }), input())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.proposal.projectSuggestion).toBeNull()
    expect(parsed.proposal.strandId).toBe('s1')
    expect(parsed.proposal.tags).toEqual(['haus'])

    const created = parseRouterOutput(JSON.stringify({
      action: 'new_strand', newStrand: { title: 'Fresh', personaId: 'main', tags: ['a'] }, confidence: 0.9,
    }), input())
    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.proposal.newStrand).toEqual({ title: 'Fresh', personaId: 'main', tags: ['a'], projectId: null })
      expect(created.proposal.projectSuggestion).toBeNull()
    }
  })

  it('rejects prose and non objects', () => {
    expect(parseRouterOutput('I think it belongs to Haus Dach', input()).ok).toBe(false)
    expect(parseRouterOutput('[1,2]', input()).ok).toBe(false)
    expect(parseRouterOutput(JSON.stringify({ action: 'append', strandId: 's1' }), input()).ok).toBe(false)
  })
})

describe('runRouter', () => {
  it('retries once with a repair prompt and then moves to the next chain entry', async () => {
    const calls: Array<{ model: string; repair: boolean }> = []
    const result = await runRouter(input(), {
      chain: [entry('bad'), entry('good')],
      complete: async (e, prompt) => {
        calls.push({ model: e.modelId, repair: prompt.includes('previous answer was rejected') })
        if (e.modelId === 'bad') return 'nope'
        return JSON.stringify({ action: 'append', strandId: 's1', confidence: 0.8, intent: 'ask' })
      },
    })
    expect(calls).toEqual([
      { model: 'bad', repair: false },
      { model: 'bad', repair: true },
      { model: 'good', repair: false },
    ])
    expect(result.model).toBe('p:good')
    expect(result.proposal.strandId).toBe('s1')
    expect(result.proposal.intent).toBe('ask')
    expect(result.notes.length).toBe(2)
  })

  it('honours the threshold and keeps the best proposal', async () => {
    const result = await runRouter(input(), {
      chain: [entry('cheap', 0.9), entry('strong')],
      complete: async (e) => JSON.stringify({
        action: 'append', strandId: e.modelId === 'cheap' ? 's2' : 's1', confidence: e.modelId === 'cheap' ? 0.6 : 0.85,
      }),
    })
    expect(result.model).toBe('p:strong')
    expect(result.proposal.strandId).toBe('s1')
  })

  it('degrades to the synthetic unsorted decision when every entry fails', async () => {
    const result = await runRouter(input(), {
      chain: [entry('down')],
      complete: async () => { throw new Error('connection refused') },
    })
    expect(result.model).toBe('synthetic')
    expect(result.proposal.action).toBe('new_strand')
    expect(result.proposal.confidence).toBe(0)
    expect(result.notes[0]).toContain('connection refused')
  })

  it('does not call a model when there are no candidates', async () => {
    let called = false
    const result = await runRouter(input({ candidates: [] }), {
      chain: [entry('x')],
      complete: async () => { called = true; return '{}' },
    })
    expect(called).toBe(false)
    expect(result.proposal.action).toBe('new_strand')
    expect(result.proposal.newStrand?.title).toBe('the roofer called back, 4200 for the north side')
  })

  it('turns an append below CONFIDENCE_HIGH into a new strand and keeps the target as an alternative', async () => {
    const result = await runRouter(input(), {
      chain: [entry('x')],
      complete: async () => JSON.stringify({
        action: 'append', strandId: 's1', intent: 'note', confidence: 0.66, tags: ['haus'],
        rationale: 'klingt nach dem Dach Strand',
        alternatives: [{ action: 'append', strandId: 's2', confidence: 0.2, reason: 'budget' }],
      }),
    })
    expect(result.proposal.action).toBe('new_strand')
    expect(result.proposal.strandId).toBeNull()
    expect(result.proposal.confidence).toBe(0.66)
    expect(result.proposal.newStrand?.title).toBe('the roofer called back, 4200 for the north side')
    expect(result.proposal.newStrand?.personaId).toBe('main')
    expect(result.proposal.newStrand?.tags).toEqual(['haus'])
    expect(result.proposal.newStrand?.projectId).toBeNull()
    // The model's target survives as a proposal the user can merge by hand.
    expect(result.proposal.alternatives[0]).toMatchObject({ action: 'append', strandId: 's1', confidence: 0.66 })
    expect(result.proposal.alternatives.map(a => a.strandId)).toContain('s2')
    expect(result.proposal.rationale).toContain(LOW_CONFIDENCE_APPEND_MARKER)
    expect(result.proposal.rationale).toContain('klingt nach dem Dach Strand')
    expect(result.notes.some(n => n.includes(LOW_CONFIDENCE_APPEND_MARKER))).toBe(true)
  })

  it('keeps an append at or above CONFIDENCE_HIGH untouched', async () => {
    const result = await runRouter(input(), {
      chain: [entry('x')],
      complete: async () => JSON.stringify({
        action: 'append', strandId: 's1', intent: 'ask', confidence: 0.85, rationale: 'same roofer thread',
      }),
    })
    expect(result.proposal.action).toBe('append')
    expect(result.proposal.strandId).toBe('s1')
    expect(result.proposal.confidence).toBe(0.85)
    expect(result.proposal.rationale).toBe('same roofer thread')
  })

  it('guards a low confidence link the same way and prefers a new_strand title the model already gave', async () => {
    const result = await runRouter(input(), {
      chain: [entry('x')],
      complete: async () => JSON.stringify({
        action: 'link', strandId: 's1', secondaryStrandId: 's2', confidence: 0.5, intent: 'note',
        alternatives: [{ action: 'new_strand', title: 'Dachangebot Nord', confidence: 0.4, reason: 'own thread' }],
      }),
    })
    expect(result.proposal.action).toBe('new_strand')
    expect(result.proposal.secondaryStrandId).toBeNull()
    expect(result.proposal.newStrand?.title).toBe('Dachangebot Nord')
    expect(result.proposal.alternatives.map(a => [a.action, a.strandId])).toEqual([
      ['append', 's1'],
      ['append', 's2'],
    ])
  })

  it('derives a capped title from the capture when the model offers none', async () => {
    const long = 'Die Strand Zuordnung ist immer noch extrem lueckenhaft und haengt an voellig unpassenden Strands'
    const result = await runRouter(input({ capture: { ...input().capture, text: long } }), {
      chain: [entry('x')],
      complete: async () => JSON.stringify({ action: 'append', strandId: 's1', confidence: 0.66 }),
    })
    const title = result.proposal.newStrand!.title
    expect(title.length).toBeLessThanOrEqual(60)
    expect(long.startsWith(title.replace(/…$/, ''))).toBe(true)
    expect(title.match(/…/g)?.length ?? 0).toBeLessThanOrEqual(1)
  })

  /**
   * The invariant the captures service leans on when it answers an `ask` in
   * the medium band (SPEC 4.4): below CONFIDENCE_HIGH no proposal ever comes
   * back pointing at an existing strand, so a medium band answer can only land
   * in a strand the capture itself just opened, never in a foreign history.
   * Checked across the whole band and both targeting actions, because a single
   * example would not say "never".
   */
  it('never returns an existing strand as the target below CONFIDENCE_HIGH', async () => {
    for (const confidence of [0.0, 0.2, 0.39, 0.4, 0.55, 0.66, 0.699]) {
      for (const action of ['append', 'link'] as const) {
        const result = await runRouter(input(), {
          chain: [entry('x')],
          complete: async () => JSON.stringify({
            action, strandId: 's1', secondaryStrandId: 's2', intent: 'ask', confidence,
          }),
        })
        expect(`${action}@${confidence}: ${result.proposal.action}`).toBe(`${action}@${confidence}: new_strand`)
        expect(result.proposal.strandId).toBeNull()
        expect(result.proposal.secondaryStrandId).toBeNull()
        expect(result.proposal.confidence).toBe(confidence)
      }
    }
    // The three ways the router degrades all open a new strand as well.
    const noCandidates = await runRouter(input({ candidates: [] }), { chain: [entry('x')], complete: async () => '{}' })
    expect(noCandidates.proposal.action).toBe('new_strand')
    const noChain = await runRouter(input(), { chain: [], complete: async () => '{}' })
    expect(noChain.proposal.action).toBe('new_strand')
    const garbage = await runRouter(input(), { chain: [entry('x')], complete: async () => 'nonsense' })
    expect(garbage.proposal.action).toBe('new_strand')
  })

  it('synthetic proposal uses the persona hint and the repair prompt carries the rejected text', () => {
    const p = syntheticProposal(input({ capture: { ...input().capture, personaHint: 'bob' } }), 'why')
    expect(p.newStrand?.personaId).toBe('bob')
    expect(p.newStrand?.projectId).toBeNull()
    expect(p.projectSuggestion).toBeNull()
    expect(buildRepairPrompt('task', 'garbage', 'not JSON')).toContain('garbage')
  })
})

describe('ROUTER_INTENT_RULES', () => {
  it('is part of the system prompt', () => {
    expect(ROUTER_SYSTEM_PROMPT).toContain(ROUTER_INTENT_RULES)
  })

  it('names direct address, imperative, question and bug report as "ask" markers in both languages', () => {
    // German second person, the language the product owner actually dictates in.
    for (const marker of ['"du"', '"dir"', '"dich"']) expect(ROUTER_INTENT_RULES).toContain(marker)
    // English second person, the language the prompt itself is written in.
    expect(ROUTER_INTENT_RULES).toContain('"you"')
    expect(ROUTER_INTENT_RULES.toLowerCase()).toContain('imperative')
    expect(ROUTER_INTENT_RULES.toLowerCase()).toContain('bug report')
  })

  it('carries at least two "ask" and two "note" examples, German and English', () => {
    const askBlock = ROUTER_INTENT_RULES.split('Examples of "note"')[0]
    const noteBlock = ROUTER_INTENT_RULES.split('Examples of "note"')[1] ?? ''
    const quoted = (block: string) => block.match(/"[^"]{12,}"/g) ?? []
    expect(quoted(askBlock).length).toBeGreaterThanOrEqual(2)
    expect(quoted(noteBlock).length).toBeGreaterThanOrEqual(2)
    // Both languages are covered on both sides, the capture box is mixed.
    expect(askBlock).toMatch(/Push Notification|schau dir/i)
    expect(askBlock).toMatch(/why|can you|is the/i)
    expect(noteBlock).toMatch(/Winterreifen|Bremsbel/i)
    expect(noteBlock).toMatch(/call|buy|book/i)
  })

  it('makes a real question an "ask" whatever it is about, and keeps the memo fragment a note', () => {
    // Measured on the live router (claude-sonnet-5, POST /api/router/preview,
    // 2026-09-15): "Wie viel kostet eigentlich ein neuer Dachstuhl?" came back
    // as intent=note, confidence=0.55 — a question filed in silence, which is
    // the complaint this rule answers. The instruction now says the subject
    // does not matter, and names the one exception that must stay a note.
    expect(ROUTER_INTENT_RULES).toContain('Wie viel kostet eigentlich ein neuer Dachstuhl?')
    expect(ROUTER_INTENT_RULES).toContain('Termin beim Zahnarzt am Montag?')
    expect(ROUTER_INTENT_RULES.toUpperCase()).toContain('NO MATTER WHAT IT IS ABOUT')
    // The question rule and its exception live in the same bullet, so a model
    // cannot read one without the other.
    const bullet = ROUTER_INTENT_RULES.split('\n').find(line => line.includes('NO MATTER WHAT IT IS ABOUT')) ?? ''
    expect(bullet).toContain('Termin beim Zahnarzt am Montag?')
  })

  it('counts a wish about your own work as an "ask", like a bug report', () => {
    expect(ROUTER_INTENT_RULES.toLowerCase()).toContain('wish')
    expect(ROUTER_INTENT_RULES).toContain('wir sollten X')
  })

  it('flips the tie break to "ask": silence is the expensive mistake', () => {
    expect(ROUTER_INTENT_RULES.toLowerCase()).toContain('when unsure, choose "ask"')
    expect(ROUTER_SYSTEM_PROMPT.toLowerCase()).not.toContain('when unsure, use "note"')
    // "note" only for a self-note without an addressee.
    expect(ROUTER_INTENT_RULES.toLowerCase()).toContain('no addressee')
  })
})

describe('addressStrength', () => {
  /** The capture that produced the incident, verbatim from the transcript. */
  const INCIDENT = 'Ich habe keine Push Notification bekommen, nachdem du deine Aufgabe gerade beendet hattest. Und der Zeilenumbruch im Recorder ist immer noch komisch. Schau dir den bitte mal auf einem Screenshot in Originalgröße an.'

  it('calls the capture that was filed in silence strong', () => {
    // Second person, imperative and "bitte": three classes, no doubt left.
    expect(addressStrength(INCIDENT)).toBe('strong')
  })

  it('needs two marker classes for strong', () => {
    expect(addressStrength('Kannst du den Zeilenumbruch fixen?')).toBe('strong') // second person + question
    expect(addressStrength('Schau dir das bitte mal an')).toBe('strong') // second person + imperative + please
    expect(addressStrength('please check the logs')).toBe('strong') // please + imperative
    expect(addressStrength('Can you look at the recorder')).toBe('strong') // second person + imperative
    expect(addressStrength('Could you fix the line break')).toBe('strong') // second person + imperative
    expect(addressStrength('Bitte fix das nochmal')).toBe('strong') // please + imperative
  })

  it('calls a single marker class weak: that is the doubt band', () => {
    expect(addressStrength('Termin beim Zahnarzt am Montag?')).toBe('weak') // only a question mark
    expect(addressStrength('Preis für die Dachrinne? nachfragen')).toBe('weak')
    expect(addressStrength('Reifen wechseln — oder erst im November?')).toBe('weak')
    expect(addressStrength('Bitte nicht vergessen: Müll rausstellen')).toBe('weak') // only "bitte"
    expect(addressStrength('Ihr Auto muss zum TÜV')).toBe('weak') // only a (misread) second person
    expect(addressStrength('Ich mach das morgen')).toBe('weak') // only an imperative stem
    expect(addressStrength('Why is the deploy still red?')).toBe('weak')
    expect(addressStrength('Deine Antwort kam nie an')).toBe('weak')
    expect(addressStrength('Your deploy is still red')).toBe('weak')
  })

  it('is case insensitive', () => {
    expect(addressStrength('DU MUSST DAS NOCHMAL ANSCHAUEN')).toBe('weak')
    expect(addressStrength('PLEASE CHECK THE LOGS')).toBe('strong')
    expect(addressStrength('Bitte')).toBe('weak')
  })

  it('leaves a self-note alone', () => {
    expect(addressStrength('Winterreifen kaufen.')).toBe('none')
    expect(addressStrength('Bremsbeläge hinten sind durch.')).toBe('none')
    expect(addressStrength('Call the roofer back next week, 4200 for the north side.')).toBe('none')
    expect(addressStrength('Dachrinne im Herbst reinigen lassen')).toBe('none')
    expect(addressStrength('')).toBe('none')
  })

  it('respects word boundaries: no marker may hide inside a longer word', () => {
    // The whole point of the backstop. Each of these contains a marker as a
    // substring and none of them addresses anybody.
    expect(addressStrength('Bremsbeläge hinten sind durch.')).toBe('none') // durch -> du
    expect(addressStrength('Der Termin ist direkt am Montag.')).toBe('none') // direkt -> dir
    expect(addressStrength('Dumme Idee, trotzdem notieren.')).toBe('none') // dumm -> du
    expect(addressStrength('Duft der Zedern im Flur festhalten')).toBe('none') // Duft -> du
    expect(addressStrength('Baustelle Nordseite fotografieren')).toBe('none') // Bau
    expect(addressStrength('Fixkosten für Oktober zusammenrechnen')).toBe('none') // fix
    expect(addressStrength('Checkliste für den Umzug anlegen')).toBe('none') // check
    expect(addressStrength('Machbarkeit der Garage klären')).toBe('none') // mach
    expect(addressStrength('Die Prüfung ist am Dienstag')).toBe('none') // prüf
    expect(addressStrength('Youtube-Abo kündigen')).toBe('none') // you
    expect(addressStrength('Dichtungsring nachbestellen')).toBe('none') // dich
    expect(addressStrength('Deinstallation der alten App')).toBe('none') // dein
    expect(addressStrength('Zeiger der Uhr steht still')).toBe('none') // zeig
    expect(addressStrength('Guckloch in der Haustür tauschen')).toBe('none') // guck
    expect(addressStrength('Lookalike Audience anlegen')).toBe('none') // look
  })

  it('does not mistake first person present for an imperative', () => {
    // German -e forms are homographs: "Ich prüfe das" is not "prüf das".
    expect(addressStrength('Ich prüfe das morgen noch mal.')).toBe('none')
    expect(addressStrength('Ich schaue am Wochenende nach.')).toBe('none')
    expect(addressStrength('Ich zeige es ihm nächste Woche.')).toBe('none')
  })

  it('yields to a capture that declares itself a note, whatever else it contains', () => {
    expect(addressStrength('Nur als Notiz: du musst noch die Reifen wechseln.')).toBe('none')
    expect(addressStrength('Nur zur Info, du brauchst den Schlüssel nicht.')).toBe('none')
    expect(addressStrength('Just for the record: your deploy was red all day.')).toBe('none')
    expect(addressStrength('Note to self: check the logs tomorrow')).toBe('none')
    expect(addressStrength('Nur notieren, bitte nichts machen.')).toBe('none')
    // Even the incident text loses its strength when the user says it is a note.
    expect(addressStrength(`Nur als Notiz: ${INCIDENT}`)).toBe('none')
  })

  it('finds the markers across line breaks and punctuation', () => {
    expect(addressStrength('Recorder-Bug.\nSchau ihn dir an')).toBe('strong')
    expect(addressStrength('(du)')).toBe('weak')
    expect(addressStrength('was ist mit dem Deploy?')).toBe('weak')
  })

  it('counts classes, not words: three imperatives are still one class', () => {
    expect(addressStrength('schau mach zeig')).toBe('weak')
    expect(addressStrength('du dir dein')).toBe('weak')
    expect(addressStrength('Wirklich? Sicher? Ganz sicher?')).toBe('weak')
  })
})

describe('captureLanguage', () => {
  it('reads German from its markers and its function words', () => {
    expect(captureLanguage('Termin beim Zahnarzt am Montag?')).toBe('de')
    expect(captureLanguage('Schau dir das bitte mal an')).toBe('de')
    expect(captureLanguage('Bitte nicht vergessen: Müll rausstellen')).toBe('de')
    expect(captureLanguage('Winterreifen kaufen.')).toBe('de')
  })

  it('reads English from its markers and its function words', () => {
    expect(captureLanguage('please check the logs')).toBe('en')
    expect(captureLanguage('Why is the deploy still red?')).toBe('en')
    expect(captureLanguage('Call the roofer back next week')).toBe('en')
    expect(captureLanguage('Can you look at the recorder')).toBe('en')
  })

  it('falls back to German when a capture carries no evidence at all', () => {
    // Deliberate: the captures of this instance are dictated in German, and a
    // German question to a German user is the cheaper miss.
    expect(captureLanguage('Dachrinne?')).toBe('de')
    expect(captureLanguage('')).toBe('de')
    expect(captureLanguage('4200')).toBe('de')
  })
})

describe('buildRouterUserPrompt', () => {
  it('carries the project list as a stable first block, and omits it without projects', () => {
    const withProjects = buildRouterUserPrompt(input())
    expect(withProjects).toContain('Projects of this user (id, name):')
    expect(withProjects).toContain('prj_haus')
    // SPEC 11.5: the project block sits before every volatile block, so the
    // cached prefix only breaks when the project list itself changes.
    expect(withProjects.indexOf('Projects of this user')).toBeLessThan(withProjects.indexOf('Route this capture.'))
    expect(withProjects.startsWith('Projects of this user')).toBe(true)

    const withoutProjects = buildRouterUserPrompt(input({ projects: [] }))
    expect(withoutProjects).not.toContain('Projects of this user')
    expect(withoutProjects.startsWith('Route this capture.')).toBe(true)

    // The candidate blocks carry the project of each strand either way.
    expect(withProjects).toContain('"projectName": "Geld"')
  })
})

describe('selectCandidates', () => {
  let db: Database
  let manager: SessionManager
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-candidates-'))
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'x', 'admin')").run()
    manager = new SessionManager({ db, memoryDir: tempDir, timeoutMinutes: 0 })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('puts the now set first, then recent strands, then tag matches, and skips archived ones', () => {
    const ids: string[] = []
    for (let i = 0; i < 23; i += 1) {
      const t = manager.createThread('1', 'main', `Strand ${i}`)
      db.prepare("UPDATE sessions SET last_activity = datetime('now', ?) WHERE id = ?").run(`-${i} minutes`, t.id)
      ids.push(t.id)
    }
    const old = manager.createThread('1', 'main', 'Old tagged')
    db.prepare("UPDATE sessions SET last_activity = datetime('now', '-40 days') WHERE id = ?").run(old.id)
    addStrandTags(db, '1', old.id, ['roofer'])
    const archived = manager.createThread('1', 'main', 'Archived')
    manager.updateThread('1', archived.id, { archived: true })
    setNowSet(db, '1', [ids[22]])
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'the second roofer was Meier')").run(ids[22])

    const candidates = selectCandidates(db, '1', 'the roofer called back with a quote')
    expect(candidates[0].strandId).toBe(ids[22])
    expect(candidates[0].projectId).toBeNull()
    expect(candidates[0].projectName).toBeNull()
    expect(candidates[0].tail).toEqual(['user: the second roofer was Meier'])
    expect(candidates.map(c => c.strandId)).toContain(old.id)
    expect(candidates.map(c => c.strandId)).not.toContain(archived.id)
    expect(candidates.length).toBeLessThanOrEqual(25)
    expect(captureKeywords('the roofer called back')).toEqual(['roofer', 'called', 'back'])
  })

  it('drops strands that say nothing to the model and keeps the now set regardless', () => {
    const mute = manager.createThread('1', 'main')
    db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, 'user', 'irgendwas anderes')").run(mute.id)
    const titled = manager.createThread('1', 'main', 'Dach Angebote')
    const tagged = manager.createThread('1', 'main')
    addStrandTags(db, '1', tagged.id, ['steuer'])
    db.prepare("INSERT INTO projects (id, user_id, name, archived) VALUES ('p_haus', '1', 'Haus', 0)").run()
    const projected = manager.createThread('1', 'main', null, 'p_haus')
    const muteButNow = manager.createThread('1', 'main')
    setNowSet(db, '1', [muteButNow.id])

    const ids = selectCandidates(db, '1', 'der dachdecker hat zurueckgerufen').map(c => c.strandId)
    expect(ids).not.toContain(mute.id)
    expect(ids).toContain(titled.id)
    expect(ids).toContain(tagged.id)
    expect(ids).toContain(projected.id)
    expect(ids).toContain(muteButNow.id)
    expect(ids[0]).toBe(muteButNow.id)
  })

  it('gives every candidate the last user message, collapsed and hard capped', () => {
    const strand = manager.createThread('1', 'main', 'Langer Verlauf')
    const insert = db.prepare("INSERT INTO chat_messages (session_id, user_id, role, content) VALUES (?, 1, ?, ?)")
    insert.run(strand.id, 'user', 'erste frage')
    insert.run(strand.id, 'assistant', 'antwort des assistenten')
    const long = `zeile eins\nzeile zwei\n${'wort '.repeat(80)}`
    insert.run(strand.id, 'user', long)
    insert.run(strand.id, 'assistant', 'letzte antwort')

    const candidate = selectCandidates(db, '1', 'verlauf')!.find(c => c.strandId === strand.id)!
    expect(candidate.lastMessage.startsWith('zeile eins zeile zwei')).toBe(true)
    expect(candidate.lastMessage).not.toContain('\n')
    expect(candidate.lastMessage.length).toBeLessThanOrEqual(ROUTER_LAST_MESSAGE_CHARS)
    expect(candidate.lastMessage.length).toBeGreaterThan(100)

    const empty = manager.createThread('1', 'main', 'Leer')
    expect(selectCandidates(db, '1', 'leer')!.find(c => c.strandId === empty.id)!.lastMessage).toBe('')
  })

  it('carries projectId and projectName on every candidate (SPEC 4.2b)', () => {
    db.prepare("INSERT INTO projects (id, user_id, name, archived) VALUES ('p_haus', '1', 'Haus', 0)").run()
    db.prepare("INSERT INTO projects (id, user_id, name, archived) VALUES ('p_old', '1', 'Altlast', 1)").run()
    const attached = manager.createThread('1', 'main', 'Dach', 'p_haus')
    const archivedProject = manager.createThread('1', 'main', 'Alt')
    db.prepare("UPDATE sessions SET project_id = 'p_old' WHERE id = ?").run(archivedProject.id)
    const loose = manager.createThread('1', 'main', 'Ohne Projekt')

    const byId = new Map(selectCandidates(db, '1', 'dach').map(c => [c.strandId, c]))
    expect(byId.get(attached.id)).toMatchObject({ projectId: 'p_haus', projectName: 'Haus' })
    // An archived project still labels the candidate: the strand really is in it.
    expect(byId.get(archivedProject.id)).toMatchObject({ projectId: 'p_old', projectName: 'Altlast' })
    expect(byId.get(loose.id)).toMatchObject({ projectId: null, projectName: null })
  })
})

describe('listRouterProjects', () => {
  let db: Database
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-projects-'))
    db = initDatabase(':memory:')
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'x', 'admin')").run()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns active projects of that user only, stable by name, capped', () => {
    const insert = db.prepare('INSERT INTO projects (id, user_id, name, archived) VALUES (?, ?, ?, ?)')
    insert.run('p_b', '1', 'kachelwerk', 0)
    insert.run('p_a', '1', 'Halfway', 0)
    insert.run('p_arch', '1', 'Archiviert', 1)
    insert.run('p_other', '2', 'Fremd', 0)
    for (let i = 0; i < ROUTER_PROJECT_CAP; i += 1) insert.run(`p_${i}`, '1', `zz Filler ${i}`, 0)

    const projects = listRouterProjects(db, '1')
    expect(projects.length).toBe(ROUTER_PROJECT_CAP)
    expect(projects.slice(0, 2)).toEqual([{ id: 'p_a', name: 'Halfway' }, { id: 'p_b', name: 'kachelwerk' }])
    expect(projects.map(p => p.id)).not.toContain('p_arch')
    expect(projects.map(p => p.id)).not.toContain('p_other')
    // Same input, same order: the prompt prefix stays cacheable.
    expect(listRouterProjects(db, '1')).toEqual(projects)
    expect(listRouterProjects(db, '9')).toEqual([])
  })
})

describe('declaresSelfNote', () => {
  it('recognises the phrases the user writes when they mean a note', () => {
    expect(declaresSelfNote('Nur als Notiz: du musst noch die Reifen wechseln.')).toBe(true)
    expect(declaresSelfNote('NUR ZUR INFO, der Dachdecker war da')).toBe(true)
    expect(declaresSelfNote('Just for the record, the deploy was red')).toBe(true)
    expect(declaresSelfNote('note to self: call the roofer')).toBe(true)
    expect(declaresSelfNote('nur   als   notiz, mehrere leerzeichen')).toBe(true)
  })

  it('says no for everything else, including empty and non-strings', () => {
    expect(declaresSelfNote('Winterreifen kaufen')).toBe(false)
    expect(declaresSelfNote('Kannst du das fixen?')).toBe(false)
    expect(declaresSelfNote('')).toBe(false)
    expect(declaresSelfNote('   ')).toBe(false)
    expect(declaresSelfNote(undefined as unknown as string)).toBe(false)
  })

  it('is the reason addressStrength gives up on such a capture', () => {
    // Two marker classes (second person + imperative) would be "strong".
    expect(addressStrength('Du musst noch die Reifen wechseln, schau mal.')).toBe('strong')
    expect(addressStrength('Nur als Notiz: du musst noch die Reifen wechseln, schau mal.')).toBe('none')
  })
})
