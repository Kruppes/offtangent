import type { Ref } from 'vue'

export interface LoadableSkill {
  id: string
  name: string
  description: string
  kind: 'agent' | 'installed'
}

const SKILL_PREFIX_RE = /^\/skill:(\S*)$/i

/**
 * Returns the partial skill query when the composer text is exactly
 * `/skill:<partial>` (no prompt typed yet), else null.
 */
export function extractSkillQuery(text: string): string | null {
  const match = SKILL_PREFIX_RE.exec(text)
  return match ? match[1]! : null
}

export function filterSkills(skills: LoadableSkill[], query: string): LoadableSkill[] {
  const q = query.toLowerCase()
  if (!q) return skills
  const starts = skills.filter((s) => s.id.toLowerCase().startsWith(q) || s.name.toLowerCase().startsWith(q))
  const contains = skills.filter((s) => !starts.includes(s)
    && (s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)))
  return [...starts, ...contains]
}

export function buildSkillCommand(skill: LoadableSkill): string {
  return `/skill:${skill.id} `
}

export function useSkillAutocomplete(inputText: Ref<string>) {
  const { apiFetch } = useApi()
  const skills = useState<LoadableSkill[]>('chat_loadable_skills', () => [])
  const selectedIndex = ref(0)
  const dismissed = ref(false)

  const query = computed(() => extractSkillQuery(inputText.value))
  const suggestions = computed(() => query.value === null ? [] : filterSkills(skills.value, query.value))
  const active = computed(() => query.value !== null && !dismissed.value && suggestions.value.length > 0)

  async function refresh(): Promise<void> {
    try {
      const res = await apiFetch<{ skills: LoadableSkill[] }>('/api/chat/skills')
      skills.value = res.skills
    } catch {
      // Autocomplete is a convenience; typing /skill:<name> still works.
    }
  }

  watch(query, (q, prev) => {
    dismissed.value = false
    selectedIndex.value = 0
    // Refetch when the prefix is (re)entered so newly created skills show up
    // without a reload; the cached list keeps the dropdown instant meanwhile.
    if (q !== null && prev === null) void refresh()
  })

  watch(suggestions, (list) => {
    if (selectedIndex.value >= list.length) selectedIndex.value = Math.max(0, list.length - 1)
  })

  function move(delta: number): void {
    const n = suggestions.value.length
    if (n === 0) return
    selectedIndex.value = (selectedIndex.value + delta + n) % n
  }

  function select(skill?: LoadableSkill): void {
    const target = skill ?? suggestions.value[selectedIndex.value]
    if (!target) return
    inputText.value = buildSkillCommand(target)
    dismissed.value = true
  }

  function dismiss(): void {
    dismissed.value = true
  }

  /** Returns true when the key was consumed by the dropdown. */
  function handleKeydown(event: KeyboardEvent): boolean {
    if (!active.value) return false
    switch (event.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Tab':
      case 'Enter':
        select()
        break
      case 'Escape':
        dismiss()
        break
      default:
        return false
    }
    event.preventDefault()
    return true
  }

  return { active, suggestions, selectedIndex, select, dismiss, handleKeydown }
}
