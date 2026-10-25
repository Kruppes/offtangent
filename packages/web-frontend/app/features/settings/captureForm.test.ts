/**
 * The settings form keeps `captureSources.clock` (companion K1).
 *
 * SettingsWorkspace.vue is too large to mount, so the clone is a pure helper:
 * it is checked by behaviour here, and the workspace is pinned to use it for
 * the form that `save()` sends back (the payload spreads the whole form).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { cloneCaptureSources } from './captureForm'
import type { CaptureSourcesSettings } from '~/composables/useSettings'

const workspace = fs.readFileSync(path.resolve(__dirname, 'components/SettingsWorkspace.vue'), 'utf-8')

const server: CaptureSourcesSettings = {
  puck: { styleHint: 'Kurz halten.' },
  clock: { enabled: true, styleHint: 'Maximal zwei Saetze.' },
}

describe('settings form: captureSources', () => {
  it('keeps clock.enabled and the clock styleHint next to puck', () => {
    const form = cloneCaptureSources(server)
    expect(form).toEqual(server)
    expect(form.clock.enabled).toBe(true)
    expect(form.clock.styleHint).toBe('Maximal zwei Saetze.')
  })

  it('copies the blocks, so editing the form does not touch the server state', () => {
    const form = cloneCaptureSources(server)
    expect(form.puck).not.toBe(server.puck)
    expect(form.clock).not.toBe(server.clock)
    form.clock.styleHint = 'anders'
    form.puck.styleHint = 'anders'
    expect(server.clock.styleHint).toBe('Maximal zwei Saetze.')
    expect(server.puck.styleHint).toBe('Kurz halten.')
  })

  it('survives the save payload: the form block is sent as it is', () => {
    const form = { captureSources: cloneCaptureSources(server) }
    const payload = JSON.parse(JSON.stringify({ ...form }))
    expect(payload.captureSources.clock).toEqual({ enabled: true, styleHint: 'Maximal zwei Saetze.' })
  })

  it('is what the workspace hydrates the form with, and save() spreads that form', () => {
    expect(workspace).toContain('captureSources: cloneCaptureSources(s.captureSources),')
    expect(workspace).not.toMatch(/captureSources: \{ puck: \{ \.\.\.s\.captureSources\.puck \} \}/)
    expect(workspace).toMatch(/const payload = \{\s*\.\.\.form\.value,/)
  })
})
