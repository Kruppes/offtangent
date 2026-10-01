import { ref, type Ref } from 'vue'

/** A reactive set of expanded ids with a toggle that replaces the set (so watchers fire). */
export function useToggleSet<T>() {
  const set = ref(new Set<T>()) as Ref<Set<T>>
  function toggle(id: T) {
    const updated = new Set(set.value)
    if (updated.has(id)) updated.delete(id)
    else updated.add(id)
    set.value = updated
  }
  return { set, toggle }
}
