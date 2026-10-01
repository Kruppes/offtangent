import { computed, onMounted, ref } from 'vue'

/**
 * Name, initials and colour of the persona that speaks in this strand, from
 * the optional client persona catalog. Without the catalog the persona id
 * stays readable.
 */
export function useSpeakerPersona(agentId: () => string | null | undefined, fallbackLabel: () => string) {
  const { apiFetch } = useApi()
  const clientPersonas = ref<Array<{ id: string; displayName: string; color: string | null }>>([])
  const speakerPersona = computed(() => clientPersonas.value.find(p => p.id === agentId()))
  const label = computed(() => speakerPersona.value?.displayName || agentId() || fallbackLabel())
  const initials = computed(() => label.value.slice(0, 2).toUpperCase())
  const color = computed(() => /^#[0-9a-f]{6}$/i.test(speakerPersona.value?.color ?? '') ? speakerPersona.value!.color! : undefined)
  onMounted(async () => {
    try { clientPersonas.value = (await apiFetch<{ personas: typeof clientPersonas.value }>('/api/personas/client')).personas }
    catch { /* A readable persona id remains when the optional catalog is unavailable. */ }
  })
  return { label, initials, color }
}
