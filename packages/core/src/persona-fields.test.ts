/**
 * The structured view of the persona markdown (SPEC 13.3).
 *
 * The one property that matters: a file that goes through parse → apply comes
 * back byte identical. A persona file is a prompt somebody wrote by hand, and
 * an editor that quietly drops a paragraph makes the agent worse for days
 * before anybody notices.
 */
import { describe, it, expect } from 'vitest'
import { parsePersonaFields, applyPersonaFields } from './persona-fields.js'

const LIVE_IDENTITY = [
  '# IDENTITY.md',
  '',
  '- **Name:** Bob',
  '- **Creature:** Senior Software Engineer Agent — strukturell, tief, qualitätsorientiert',
  '- **Vibe:** Pragmatisch, ergebnisorientiert, plan-first. Kein Smalltalk.',
  '- **Emoji:** 🔨',
  '- **Avatar:** —',
  '',
  'Freitext, der bleiben muss.',
  '',
].join('\n')

describe('parsePersonaFields', () => {
  it('reads the labels the persona files really use', () => {
    const fields = parsePersonaFields({ identity: LIVE_IDENTITY, tools: '' })
    expect(fields.name).toBe('Bob')
    expect(fields.role).toBe('Senior Software Engineer Agent — strukturell, tief, qualitätsorientiert')
    expect(fields.tone).toBe('Pragmatisch, ergebnisorientiert, plan-first. Kein Smalltalk.')
    expect(fields.badge).toBe('🔨')
    expect(fields.color).toBeNull()
    expect(fields.subjects).toEqual([])
  })

  it('treats placeholders and junk as absent instead of failing', () => {
    const fields = parsePersonaFields({
      identity: '- **Name:**   \n- **Emoji:** —\n- **Color:** blue\n',
      tools: 'not markdown ***',
    })
    expect(fields.name).toBeNull()
    expect(fields.badge).toBeNull()
    expect(fields.color).toBeNull()
    expect(fields.tools).toEqual([])
  })

  it('does not read the next line into an empty field', () => {
    const fields = parsePersonaFields({ identity: '- **Name:**\n- **Emoji:** 🦊\n', tools: '' })
    expect(fields.name).toBeNull()
    expect(fields.badge).toBe('🦊')
  })
})

describe('applyPersonaFields', () => {
  it('writes back what it read without changing a byte', () => {
    const files = { identity: LIVE_IDENTITY, tools: '# TOOLS.md\n\nFreitext.\n' }
    const fields = parsePersonaFields(files)
    const written = applyPersonaFields(files, fields)
    expect(written.identity).toBe(files.identity)
    expect(written.tools).toBe(files.tools)
  })

  it('is idempotent over a second round trip', () => {
    const files = { identity: LIVE_IDENTITY, tools: '' }
    const once = applyPersonaFields(files, {
      name: 'Bobbi', subjects: ['deploys', 'code review'], tools: ['shell'],
    })
    const twice = applyPersonaFields(once, parsePersonaFields(once))
    expect(twice.identity).toBe(once.identity)
    expect(twice.tools).toBe(once.tools)
  })

  it('replaces the value in place and keeps the label the file already used', () => {
    const written = applyPersonaFields({ identity: LIVE_IDENTITY, tools: '' }, { role: 'Neue Rolle' })
    expect(written.identity).toContain('- **Creature:** Neue Rolle')
    expect(written.identity).not.toContain('Senior Software Engineer')
    expect(written.identity).toContain('Freitext, der bleiben muss.')
    expect(written.identity).toContain('- **Avatar:** —')
  })

  it('inserts a missing field after the existing bullet block', () => {
    const written = applyPersonaFields({ identity: LIVE_IDENTITY, tools: '' }, { color: '#4f8ef7' })
    expect(written.identity).toContain('- **Color:** #4f8ef7')
    // Still one bullet block, prose untouched.
    expect(written.identity.indexOf('- **Color:**')).toBeLessThan(written.identity.indexOf('Freitext'))
    expect(parsePersonaFields(written).color).toBe('#4f8ef7')
  })

  it('keeps list blocks replaceable instead of appending a second copy', () => {
    let files = { identity: LIVE_IDENTITY, tools: '# TOOLS.md\n\nHinweise.\n' }
    files = applyPersonaFields(files, { subjects: ['a', 'b'], tools: ['shell'] })
    files = applyPersonaFields(files, { subjects: ['c'], tools: ['shell', 'web_search'] })

    expect(parsePersonaFields(files).subjects).toEqual(['c'])
    expect(parsePersonaFields(files).tools).toEqual(['shell', 'web_search'])
    expect(files.identity.match(/offtangent:subjects:start/g)).toHaveLength(1)
    expect(files.tools).toContain('Hinweise.')
  })

  it('removes the block when the list is cleared', () => {
    const base = { identity: LIVE_IDENTITY, tools: '' }
    const withList = applyPersonaFields(base, { subjects: ['a'] })
    const cleared = applyPersonaFields(withList, { subjects: [] })
    expect(cleared.identity).not.toContain('offtangent:subjects')
    expect(cleared.identity).toContain('Freitext, der bleiben muss.')
    expect(cleared.identity).toContain('- **Name:** Bob')
  })

  it('drops a scalar line when the field is cleared', () => {
    const cleared = applyPersonaFields({ identity: LIVE_IDENTITY, tools: '' }, { badge: null })
    expect(cleared.identity).not.toContain('**Emoji:**')
    expect(cleared.identity).toContain('- **Name:** Bob')
  })

  it('leaves untouched keys alone', () => {
    const written = applyPersonaFields({ identity: LIVE_IDENTITY, tools: 'x' }, { name: 'Bo' })
    expect(written.tools).toBe('x')
    expect(parsePersonaFields(written).badge).toBe('🔨')
  })

  it('creates the fields from an empty file', () => {
    const written = applyPersonaFields({ identity: '', tools: '' }, { name: 'Neu', badge: '✨' })
    const back = parsePersonaFields(written)
    expect(back.name).toBe('Neu')
    expect(back.badge).toBe('✨')
  })
})
