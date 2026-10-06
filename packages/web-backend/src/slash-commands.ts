import { SlashCommandRegistry, registerBuiltInSlashCommands } from '@axiom/core'

export function buildWebChatSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry()
  registerBuiltInSlashCommands(registry)

  registry.register({
    name: 'new',
    description: 'Summarize the current session and start a fresh conversation.',
    surfaces: ['web', 'telegram'],
  })
  // `/stop` is strand-local (the visible stop button sends it with the open
  // strand's sessionId); `/kill` is the separate global emergency stop that
  // ends every running or queued turn of the user in every strand.
  registry.register({
    name: 'stop',
    description: 'Stop the running and queued turns of this strand.',
    surfaces: ['web', 'telegram'],
  })
  registry.register({
    name: 'kill',
    description: 'Emergency stop: abort all of your running and queued turns in every strand.',
    surfaces: ['web', 'telegram'],
  })

  return registry
}
