let settle: ((accepted: boolean) => void) | null = null

export function useModelConsentDialog() {
  const description = useState<string | null>('model-consent-dialog', () => null)

  function answer(accepted: boolean) {
    const resolve = settle
    settle = null
    description.value = null
    resolve?.(accepted)
  }

  function request(text: string): Promise<boolean> {
    if (!import.meta.client) return Promise.resolve(false)
    // A second settings save must not inherit the first selection's answer.
    answer(false)
    description.value = text
    return new Promise(resolve => { settle = resolve })
  }

  return { description, request, answer }
}
