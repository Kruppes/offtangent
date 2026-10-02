/**
 * useShellCommands — actions a screen offers to the command palette (W3).
 *
 * The palette does not know the composer or the strand view; those screens
 * provide a command for as long as they are mounted (`provideCommand`), and
 * the palette lists only what is available right now. Same "newest provider
 * wins" rule as the shortcut dispatcher.
 */
import { computed, onBeforeUnmount, shallowRef, type ComputedRef } from 'vue'

export type ShellCommandId = 'dictation.start' | 'strand.archive'

interface Provider {
  run: () => void | Promise<void>
  available: () => boolean
}

const providers = shallowRef(new Map<ShellCommandId, Provider[]>())
/** Bumped when a command changed strand data, so lists can reload. */
const strandsVersion = shallowRef(0)

function update(id: ShellCommandId, change: (stack: Provider[]) => void) {
  const next = new Map(providers.value)
  const stack = [...(next.get(id) ?? [])]
  change(stack)
  if (stack.length) next.set(id, stack)
  else next.delete(id)
  providers.value = next
}

export function registerCommand(id: ShellCommandId, provider: Provider): () => void {
  update(id, stack => stack.push(provider))
  return () => update(id, stack => {
    const index = stack.lastIndexOf(provider)
    if (index >= 0) stack.splice(index, 1)
  })
}

/** Component helper: offered for the lifetime of the calling component. */
export function provideCommand(id: ShellCommandId, run: Provider['run'], available: Provider['available'] = () => true): void {
  if (typeof window === 'undefined') return
  const release = registerCommand(id, { run, available })
  onBeforeUnmount(release)
}

export function useShellCommands() {
  function current(id: ShellCommandId): Provider | undefined {
    const stack = providers.value.get(id)
    return stack?.[stack.length - 1]
  }
  const isAvailable = (id: ShellCommandId): ComputedRef<boolean> => computed(() => Boolean(current(id)?.available()))
  return {
    isAvailable,
    available(id: ShellCommandId): boolean {
      return Boolean(current(id)?.available())
    },
    async run(id: ShellCommandId): Promise<boolean> {
      const provider = current(id)
      if (!provider?.available()) return false
      await provider.run()
      return true
    },
    strandsVersion,
    strandsChanged() {
      strandsVersion.value += 1
    },
  }
}

/** Test seam. */
export function resetShellCommandsForTest(): void {
  providers.value = new Map()
  strandsVersion.value = 0
}
