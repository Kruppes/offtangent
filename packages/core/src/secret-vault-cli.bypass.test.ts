/**
 * F4 (review A, finding A3 — triage 19:25): the vault-CLI detector tokenized
 * the command line and only looked at the first word of each segment. Every
 * indirection that hides the binary inside an argument therefore walked
 * straight past it:
 *
 *   sh -c "bw get password x"      → first word `sh`
 *   bash -c 'bw list items'        → first word `bash`
 *   echo id | xargs bw get item    → first word `xargs`
 *   eval "bw get password x"       → first word `eval`
 *   npx @bitwarden/cli get …       → binary is a package name
 *
 * The fix scans the WHOLE command text for a `bw <subcommand>` pattern and for
 * `@bitwarden/cli`, in addition to the token walk.
 */
import { describe, it, expect } from 'vitest'
import { classifyVaultCliCommand, commandInvokesVaultCli } from './secret-vault-cli.js'

describe('F4: bypasses of the vault-CLI detection', () => {
  const bypasses: Array<[string, string, 'single' | 'structured' | 'export']> = [
    ['sh -c with a quoted get password', 'sh -c "bw get password x"', 'single'],
    ['bash -c with single quotes', "bash -c 'bw list items'", 'structured'],
    ['xargs', 'echo id | xargs bw get item', 'structured'],
    ['xargs with password', 'echo id | xargs bw get password', 'single'],
    ['eval', 'eval "bw get password x"', 'single'],
    ['npx package name', 'npx @bitwarden/cli get password x', 'single'],
    ['nested double quotes inside a script', 'bash -lc "cd /tmp && bw unlock --raw > /tmp/k"', 'single'],
    ['export inside a subshell', 'sh -c "bw export --output /tmp/v.json"', 'export'],
    ['bunx package name', 'bunx @bitwarden/cli list items', 'structured'],
  ]

  for (const [label, command, mode] of bypasses) {
    it(`detects ${label}`, () => {
      expect(commandInvokesVaultCli(command)).toBe(true)
      expect(classifyVaultCliCommand(command).mode).toBe(mode)
    })
  }

  const stillQuiet: Array<[string, string]> = [
    ['file named like the CLI', 'ls bw-notes'],
    ['the word as an argument', 'echo bw'],
    ['a different binary', 'brew install jq'],
    ['a similar binary', 'bwrap --version'],
    ['a script with that stem', 'python3 bw.py --help'],
    ['a path segment', 'cat /home/agent/bw/readme.md'],
    ['a word ending in bw', 'echo nbw get'],
    ['an unrelated subcommand word', 'git status'],
    ['bw without a subcommand', 'which bw'],
    ['a different package', 'npx @bitwarden/other-thing --help'],
  ]

  for (const [label, command] of stillQuiet) {
    it(`does not fire: ${label}`, () => {
      expect(commandInvokesVaultCli(command)).toBe(false)
    })
  }

  // Accepted, documented false positive (triage F4): the text scan cannot tell
  // a grep PATTERN from a command. Conservative direction — the output is
  // sealed, nothing is lost but readability of that one command's output.
  it('fires on a grep whose pattern quotes the CLI (accepted false positive)', () => {
    expect(commandInvokesVaultCli('grep -r "bw get password" docs/')).toBe(true)
  })
})
