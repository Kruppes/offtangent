import { describe, expect, it } from 'vitest'
import { buildSkillCommand, extractSkillQuery, filterSkills } from './useSkillAutocomplete'
import type { LoadableSkill } from './useSkillAutocomplete'

const skills: LoadableSkill[] = [
  { id: 'deploy', name: 'deploy', description: '', kind: 'agent' },
  { id: 'review', name: 'code-review', description: '', kind: 'agent' },
  { id: 'acme/widgets', name: 'widgets', description: '', kind: 'installed' },
]

describe('extractSkillQuery', () => {
  it('returns the partial name while typing /skill:<partial>', () => {
    expect(extractSkillQuery('/skill:')).toBe('')
    expect(extractSkillQuery('/skill:dep')).toBe('dep')
    expect(extractSkillQuery('/SKILL:Dep')).toBe('Dep')
  })

  it('returns null once a prompt follows the name or for other input', () => {
    expect(extractSkillQuery('/skill:deploy ship it')).toBeNull()
    expect(extractSkillQuery('/skill')).toBeNull()
    expect(extractSkillQuery('/model')).toBeNull()
    expect(extractSkillQuery('hello')).toBeNull()
    expect(extractSkillQuery(' /skill:x')).toBeNull()
  })
})

describe('filterSkills', () => {
  it('returns everything for an empty query', () => {
    expect(filterSkills(skills, '')).toEqual(skills)
  })

  it('ranks prefix matches on id or name before substring matches', () => {
    expect(filterSkills(skills, 'rev').map((s) => s.id)).toEqual(['review'])
    expect(filterSkills(skills, 'code').map((s) => s.id)).toEqual(['review'])
    // `widgets` starts with "w"; `code-review` only contains it → prefix first.
    expect(filterSkills(skills, 'w').map((s) => s.id)).toEqual(['acme/widgets', 'review'])
    // `deploy`/`review` merely contain "e" while nothing starts with it → original order kept.
    expect(filterSkills(skills, 'e').map((s) => s.id)).toEqual(['deploy', 'review', 'acme/widgets'])
    // Prefix match (`code-review` via name) sorts before substring match (`acme/widgets`).
    expect(filterSkills(skills, 'c').map((s) => s.id)).toEqual(['review', 'acme/widgets'])
  })

  it('is case-insensitive', () => {
    expect(filterSkills(skills, 'DEP').map((s) => s.id)).toEqual(['deploy'])
  })
})

describe('buildSkillCommand', () => {
  it('produces the colon form with a trailing space for the prompt', () => {
    expect(buildSkillCommand(skills[2]!)).toBe('/skill:acme/widgets ')
  })
})
