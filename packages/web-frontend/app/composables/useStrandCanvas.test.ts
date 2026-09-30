/**
 * The web client's half of the canvas protocol, tested against the frame the
 * SERVER actually sends: `docs/protocol/canvas-view-updated.frame.json` is
 * recorded by `canvas-view-live.test.ts` from a running `/ws/chat` and is the
 * same file the Android app parses in its tests. A hand written frame here
 * would let the two clients agree with each other and with nobody else.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createStrandCanvasState, type CanvasViewUpdate } from './useStrandCanvas'

const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../../../../docs/protocol/canvas-view-updated.frame.json'), 'utf8'),
) as { type: string; sessionId: string; canvasView: Record<string, unknown> }

/** The recorded frame with its two volatile placeholders filled in. */
function recordedUpdate(overrides: Partial<CanvasViewUpdate> = {}): CanvasViewUpdate {
  return {
    ...(FIXTURE.canvasView as unknown as CanvasViewUpdate),
    artifactId: 'art-1',
    messageId: 4711,
    ...overrides,
  }
}

const STRAND = FIXTURE.sessionId

describe('strand canvas state', () => {
  it('parses the recorded frame into a view', () => {
    expect(FIXTURE.type).toBe('canvas_view_updated')
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate())

    expect(state.views.value).toHaveLength(1)
    const view = state.views.value[0]!
    expect(view.viewKey).toBe('front-wheel')
    expect(view.title).toBe('Wheel truing')
    expect(view.kind).toBe('html')
    expect(view.latestRevision).toBe(1)
    expect(view.revisions[0]?.note).toBe('measure spoke 25 first')
    expect(view.revisions[0]?.artifactId).toBe('art-1')
  })

  it('marks a revision of a closed view as unseen', () => {
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate())

    expect(state.unseen.value).toEqual(['front-wheel'])
    expect(state.hasUnseen.value).toBe(true)

    state.open('front-wheel')
    expect(state.unseen.value).toEqual([])
    expect(state.openRevision.value).toBe(1)
  })

  it('follows the open view to the new revision', () => {
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate())
    state.open('front-wheel')

    state.receive(recordedUpdate({ revision: 2, latestRevision: 2, note: 'radial run-out 0.4 mm', artifactId: 'art-2' }))

    expect(state.openRevision.value).toBe(2)
    expect(state.unseen.value).toEqual([])
    const view = state.views.value[0]!
    expect(view.latestRevision).toBe(2)
    expect(view.revisions.map(r => r.revision)).toEqual([1, 2])
    expect(view.revisions[1]?.note).toBe('radial run-out 0.4 mm')
  })

  it('keeps a user who is reading an old revision of ANOTHER view undisturbed', () => {
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate())
    state.receive(recordedUpdate({ viewKey: 'rear-wheel', title: 'Rear wheel', artifactId: 'art-r1' }))
    state.open('rear-wheel', 1)

    state.receive(recordedUpdate({ revision: 2, latestRevision: 2, artifactId: 'art-2' }))

    expect(state.openViewKey.value).toBe('rear-wheel')
    expect(state.openRevision.value).toBe(1)
    expect(state.unseen.value).toEqual(['front-wheel'])
  })

  it('ignores a frame of a different strand', () => {
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate({ strandId: 'someone-elses-strand' }))
    expect(state.views.value).toEqual([])
    expect(state.unseen.value).toEqual([])
  })

  it('drops the open view when the strand views no longer contain it', () => {
    const state = createStrandCanvasState(() => STRAND)
    state.receive(recordedUpdate())
    state.open('front-wheel')
    state.setViews([])
    expect(state.openViewKey.value).toBeNull()
    expect(state.openRevision.value).toBeNull()
  })
})
