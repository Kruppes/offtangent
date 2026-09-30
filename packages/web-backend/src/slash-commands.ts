import { SlashCommandRegistry, registerBuiltInSlashCommands } from '@axiom/core'

export function buildWebChatSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry()
  registerBuiltInSlashCommands(registry)

  registry.register({
    name: 'new',
    description: 'Summarize the current session and start a fresh conversation.',
    surfaces: ['web', 'telegram'],
  })
  registry.register({
    name: 'stop',
    aliases: ['kill'],
    description: 'Abort the current agent turn and clear queued work.',
    surfaces: ['web', 'telegram'],
  })

  return registry
}
