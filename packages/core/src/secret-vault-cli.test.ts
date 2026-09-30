/**
 * Sealing password-manager CLI output (maintainer request, privacy plan 2026-09-26).
 *
 * All fixtures are synthetic and every canary value is assembled at runtime
 * from fragments, so the repository holds no credential-looking literal and the
 * gitleaks allowlist stays untouched. No test talks to a real vault.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  classifyVaultCliCommand,
  commandInvokesVaultCli,
  sealVaultCliOutput,
  sealVaultValue,
  vaultSlug,
  VAULT_CLI_KIND,
  VAULT_CLI_SOURCE,
  VAULT_EXPORT_NOTICE,
  VAULT_OPAQUE_HANDLE,
  VAULT_UNPARSEABLE_NOTICE,
} from './secret-vault-cli.js'
import { invalidateKnownValues, REDACTED_HANDLE, redactKnown, secretHandle } from './secret-boundary.js'
import { invalidateSecretHandleCache, listSecrets, resolveSecret } from './secret-store.js'

/** Canary builder: never a literal secret in the repo. */
const canary = (label: string): string => ['Vw', label, 'q7', 'Zt', 'x'].join('-')

const PASSWORD = canary('PASSWORD')
const TOTP = canary('TOTPSEED')
const NOTES = `line one ${canary('NOTES')}\nline two`
const HIDDEN = canary('HIDDENFIELD')
const OLDPW = canary('OLDPASSWORD')
const CARD_NUMBER = '4111111111111111'
const CARD_CODE = '123'
const SSN = canary('SSNVALUE')
const PASSPORT = canary('PASSPORTNO')
const LICENSE = canary('LICENSENO')
const DASHES = '-'.repeat(5)
const SSH_KEY = [
  `${DASHES}BEGIN OPENSSH PRIVATE${' KEY'}${DASHES}`,
  canary('SSHBODY'),
  `${DASHES}END OPENSSH PRIVATE${' KEY'}${DASHES}`,
].join('\n')

const ALL_CANARIES = [PASSWORD, TOTP, NOTES, HIDDEN, OLDPW, CARD_NUMBER, CARD_CODE, SSN, PASSPORT, LICENSE, SSH_KEY]

function loginItem(): Record<string, unknown> {
  return {
    object: 'item',
    id: '11111111-2222-3333-4444-555555555555',
    organizationId: null,
    folderId: null,
    type: 1,
    reprompt: 0,
    name: 'Router',
    notes: NOTES,
    favorite: false,
    login: {
      username: 'admin@example.invalid',
      password: PASSWORD,
      totp: TOTP,
      passwordRevisionDate: null,
      uris: [{ match: null, uri: 'https://router.example.invalid' }],
    },
    fields: [
      { name: 'Recovery Key', value: HIDDEN, type: 1 },
      { name: 'Location', value: 'basement', type: 0 },
    ],
    passwordHistory: [{ lastUsedDate: '2026-01-01T00:00:00.000Z', password: OLDPW }],
    collectionIds: [],
    revisionDate: '2026-02-02T00:00:00.000Z',
  }
}

function cardItem(): Record<string, unknown> {
  return {
    object: 'item',
    id: '22222222-2222-3333-4444-555555555555',
    type: 3,
    name: 'Travel Card',
    notes: null,
    card: { cardholderName: 'A Person', brand: 'Visa', number: CARD_NUMBER, expMonth: '12', expYear: '2030', code: CARD_CODE },
  }
}

function identityItem(): Record<string, unknown> {
  return {
    object: 'item',
    id: '33333333-2222-3333-4444-555555555555',
    type: 4,
    name: 'Passport Data',
    identity: {
      title: 'Mr', firstName: 'A', lastName: 'Person', email: 'a@example.invalid',
      ssn: SSN, passportNumber: PASSPORT, licenseNumber: LICENSE,
    },
  }
}

function sshItem(): Record<string, unknown> {
  return {
    object: 'item',
    id: '44444444-2222-3333-4444-555555555555',
    type: 5,
    name: 'Deploy Key',
    sshKey: { privateKey: SSH_KEY, publicKey: 'ssh-ed25519 AAAAC3NotASecret', keyFingerprint: 'SHA256:abc' },
  }
}

let tmpDir: string
let previous: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-vault-'))
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previous = { DATA_DIR: process.env.DATA_DIR, ENCRYPTION_KEY: process.env.ENCRYPTION_KEY }
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-vault-cli-unit-tests'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

// ---------------------------------------------------------------------------
// Command detection
// ---------------------------------------------------------------------------

describe('vault CLI detection', () => {
  const positives: Array<[string, string]> = [
    ['bare command', 'bw list items'],
    ['after export PATH', 'export PATH="/data/bin:$PATH"; bw list items'],
    ['absolute path', '/data/bin/bw get item 1234'],
    ['after &&', 'cd /tmp && bw sync'],
    ['in a pipe', 'bw list items | head -5'],
    ['right of a pipe', 'echo x | bw encode'],
    ['command substitution', 'SESSION=$(bw unlock --raw)'],
    ['backticks', 'S=`bw unlock --raw`'],
    ['env assignment prefix', 'BW_PASSWORD="$BW_PASSWORD" bw login user pass --raw'],
    ['wrapper command', 'timeout 30 bw sync'],
    ['newline separated', 'export PATH=/data/bin:$PATH\nbw status'],
    ['quoted binary', '"bw" status'],
    ['subshell', '(bw list items)'],
  ]
  for (const [label, command] of positives) {
    it(`detects the CLI: ${label}`, () => {
      expect(commandInvokesVaultCli(command)).toBe(true)
    })
  }

  const negatives: Array<[string, string]> = [
    ['file named like the CLI', 'ls bw-notes'],
    ['the word as an argument', 'echo bw'],
    ['a different binary', 'brew install jq'],
    ['a similar binary', 'bwrap --version'],
    ['a script with that stem', 'python3 bw.py --help'],
    ['a path segment', 'cat /home/agent/bw/readme.md'],
    ['no command at all', ''],
  ]
  for (const [label, command] of negatives) {
    it(`does not fire: ${label}`, () => {
      expect(commandInvokesVaultCli(command)).toBe(false)
    })
  }

  // F4 (triage 2026-09-26 19:25): the detector now scans the whole command
  // text, including quoted parts, because `sh -c "bw get password x"` was a
  // trivial bypass. A grep whose PATTERN quotes a bw subcommand is
  // indistinguishable from that, so it fires — accepted false positive, see
  // docs/guide/secrets.md § Grenzen. The direction is the safe one.
  it('fires on a grep whose pattern quotes the CLI (accepted false positive)', () => {
    expect(commandInvokesVaultCli('grep -r "bw get password" docs/')).toBe(true)
  })

  it('classifies modes', () => {
    expect(classifyVaultCliCommand('bw list items').mode).toBe('structured')
    expect(classifyVaultCliCommand('bw get item 1234').mode).toBe('structured')
    expect(classifyVaultCliCommand('bw get password 1234').mode).toBe('single')
    expect(classifyVaultCliCommand('bw get totp 1234').mode).toBe('single')
    expect(classifyVaultCliCommand('bw get notes 1234').mode).toBe('single')
    expect(classifyVaultCliCommand('bw list items --raw').mode).toBe('single')
    expect(classifyVaultCliCommand('bw unlock').mode).toBe('single')
    expect(classifyVaultCliCommand('bw generate -ulns --length 20').mode).toBe('single')
    expect(classifyVaultCliCommand('bw export --format json').mode).toBe('export')
    // export wins over everything else in the same command line
    expect(classifyVaultCliCommand('bw get password 1 && bw export --raw').mode).toBe('export')
  })
})

describe('commands without the CLI are never touched', () => {
  it('returns the text unchanged', () => {
    const text = `bw-notes.md\nsome password-looking text ${canary('UNRELATED')}`
    expect(sealVaultCliOutput(text, 'ls bw-notes')).toBe(text)
    expect(sealVaultCliOutput(text, 'echo bw')).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// JSON items
// ---------------------------------------------------------------------------

describe('JSON output: item and item list', () => {
  it('seals every secret field of a single item and keeps the metadata', () => {
    const output = sealVaultCliOutput(JSON.stringify(loginItem(), null, 2), 'bw get item 1111 --session X')

    for (const value of [PASSWORD, TOTP, NOTES, HIDDEN, OLDPW]) {
      expect(output).not.toContain(value)
    }
    // metadata stays readable
    expect(output).toContain('Router')
    expect(output).toContain('11111111-2222-3333-4444-555555555555')
    expect(output).toContain('admin@example.invalid')
    expect(output).toContain('https://router.example.invalid')
    expect(output).toContain('basement')

    // speaking slugs
    expect(output).toContain(secretHandle('vw-router-login-password'))
    expect(output).toContain(secretHandle('vw-router-login-totp'))
    expect(output).toContain(secretHandle('vw-router-notes'))
    expect(output).toContain(secretHandle('vw-router-recovery-key-hidden'))

    // the values really are in the store, with kind/source vaultwarden
    expect(resolveSecret('vw-router-login-password')).toBe(PASSWORD)
    const entry = listSecrets().find(item => item.slug === 'vw-router-login-password')
    expect(entry?.kind).toBe(VAULT_CLI_KIND)
    expect(entry?.source).toBe(VAULT_CLI_SOURCE)

    // still valid JSON
    expect(() => JSON.parse(output)).not.toThrow()
  })

  it('seals card, identity and sshKey fields across a list', () => {
    const output = sealVaultCliOutput(
      JSON.stringify([loginItem(), cardItem(), identityItem(), sshItem()]),
      'bw list items --session X',
    )
    for (const value of ALL_CANARIES) expect(output).not.toContain(value)
    expect(output).toContain(secretHandle('vw-travel-card-card-number'))
    expect(output).toContain(secretHandle('vw-travel-card-card-code'))
    expect(output).toContain(secretHandle('vw-passport-data-identity-ssn'))
    expect(output).toContain(secretHandle('vw-passport-data-identity-passportnumber'))
    expect(output).toContain(secretHandle('vw-passport-data-identity-licensenumber'))
    expect(output).toContain(secretHandle('vw-deploy-key-sshkey-privatekey'))
    // harmless siblings survive
    expect(output).toContain('ssh-ed25519 AAAAC3NotASecret')
    expect(output).toContain('Visa')
    expect(output).toContain('Travel Card')
  })

  it('does not seal a visible (type 0) custom field', () => {
    const item = loginItem()
    ;(item.fields as Array<Record<string, unknown>>)[1]!.value = 'visible-value'
    const output = sealVaultCliOutput(JSON.stringify(item), 'bw get item 1111')
    expect(output).toContain('visible-value')
  })

  it('deduplicates: the same password in two items gets one handle', () => {
    const a = loginItem()
    const b = loginItem()
    b.name = 'Router Backup'
    b.id = '99999999-2222-3333-4444-555555555555'
    const output = sealVaultCliOutput(JSON.stringify([a, b]), 'bw list items')
    expect(output).not.toContain(PASSWORD)
    const entries = listSecrets().filter(entry => resolveSecret(entry.slug) === PASSWORD)
    expect(entries).toHaveLength(1)
    // both items point at the same handle
    const occurrences = output.split(secretHandle(entries[0]!.slug)).length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('seals embedded JSON inside other text', () => {
    const text = `Syncing complete.\n${JSON.stringify(loginItem())}\nDone.`
    const output = sealVaultCliOutput(text, 'bw sync && bw get item 1111')
    expect(output).not.toContain(PASSWORD)
    expect(output).toContain('{{secret:')
  })

  it('seals a reshaped object that only has a password key', () => {
    const output = sealVaultCliOutput(JSON.stringify({ name: 'Mailbox', password: PASSWORD }), 'bw get item 1 | jq .')
    expect(output).not.toContain(PASSWORD)
    expect(output).toContain(secretHandle('vw-mailbox-password'))
  })
})

// ---------------------------------------------------------------------------
// Single-secret output
// ---------------------------------------------------------------------------

describe('single-secret output', () => {
  it('seals the whole output of `bw get password`', () => {
    const output = sealVaultCliOutput(`${PASSWORD}\n`, 'bw get password 1111 --session X')
    expect(output).toBe(secretHandle('vw-password'))
    expect(resolveSecret('vw-password')).toBe(PASSWORD)
  })

  it('seals a --raw session key', () => {
    const session = canary('SESSIONKEY') + '=='
    const output = sealVaultCliOutput(session, 'BW_PASSWORD="$BW_PASSWORD" bw login user --raw --nointeraction')
    expect(output).toBe(secretHandle('vw-session'))
    expect(resolveSecret('vw-session')).toBe(session)
  })

  it('seals `bw unlock --raw` and makes the value known afterwards', () => {
    const session = canary('UNLOCKED')
    const output = sealVaultCliOutput(`${session}\n`, 'bw unlock --raw')
    expect(output).toBe(secretHandle('vw-session'))
    invalidateKnownValues()
    // the known-value index now covers it: a later echo is redacted
    expect(redactKnown(`echo ${session}`)).toBe(`echo ${secretHandle('vw-session')}`)
  })

  it('keeps empty output empty', () => {
    expect(sealVaultCliOutput('', 'bw get password 1')).toBe('')
    expect(sealVaultCliOutput('   \n', 'bw get password 1')).toBe('   \n')
  })
})

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  it('replaces the whole output with a notice', () => {
    const csv = `folder,name,login_password\n,Router,${PASSWORD}\n`
    const output = sealVaultCliOutput(csv, 'bw export --format csv --session X')
    expect(output).toBe(VAULT_EXPORT_NOTICE)
    expect(output).not.toContain(PASSWORD)
    // nothing was written to the store either
    expect(listSecrets()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe('fail closed for transformed output', () => {
  it('redacts every non-harmless line of a jq-transformed output', () => {
    const text = `Router\n${PASSWORD}\nMailbox\n${canary('OTHERPW')}\n`
    const output = sealVaultCliOutput(text, 'bw list items --session X | jq -r \'.[] | .name, .login.password\'')
    expect(output).not.toContain(PASSWORD)
    expect(output).not.toContain('Router')
    expect(output).toContain(VAULT_OPAQUE_HANDLE)
    expect(output).toContain(VAULT_UNPARSEABLE_NOTICE)
    // fail closed means no store entry for a value we cannot attribute
    expect(listSecrets()).toHaveLength(0)
  })

  it('redacts python-reshaped output', () => {
    const text = `password=${PASSWORD}`
    const output = sealVaultCliOutput(text, "bw get item 1 | python3 -c 'import sys,json;d=json.load(sys.stdin);print(\"password=\"+d[\"login\"][\"password\"])'")
    expect(output).not.toContain(PASSWORD)
    expect(output.startsWith(VAULT_OPAQUE_HANDLE)).toBe(true)
  })

  it('keeps the harmless status lines of the CLI', () => {
    const output = sealVaultCliOutput('You are logged in!\nSyncing complete.\n2026.3.0\n', 'bw sync')
    expect(output).toContain('You are logged in!')
    expect(output).toContain('Syncing complete.')
    expect(output).toContain('2026.3.0')
    expect(output).not.toContain(VAULT_OPAQUE_HANDLE)
  })

  it('treats an error text with the line filter and writes nothing to the store', () => {
    const message = `Command failed: bw get password 1 --session ${canary('ERRSESSION')}`
    const output = sealVaultCliOutput(message, 'bw get password 1', { errorText: true })
    expect(output).not.toContain(canary('ERRSESSION'))
    expect(listSecrets()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Slugs, failures, hygiene
// ---------------------------------------------------------------------------

describe('slugs and failure behaviour', () => {
  it('builds collision-free speaking slugs', () => {
    expect(vaultSlug('Router', 'login-password')).toBe('vw-router-login-password')
    expect(vaultSlug('Weird Näme & Co', 'notes')).toBe('vw-weird-n-me-co-notes')
    expect(vaultSlug('x'.repeat(200), 'notes').length).toBeLessThanOrEqual(64)

    const first = sealVaultValue('value-one-canary-aaa', 'vw-dup')
    const second = sealVaultValue('value-two-canary-bbb', 'vw-dup')
    expect(first).toBe(secretHandle('vw-dup'))
    expect(second).toBe(secretHandle('vw-dup-2'))
  })

  it('falls back to the opaque handle when the store cannot take the value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put a regular file where the config directory belongs: writing
    // config/secrets.json fails with ENOTDIR. A chmod 0500 would not do,
    // root ignores it and the Docker image build runs the suite as root.
    const configDir = path.join(tmpDir, 'config')
    fs.rmSync(configDir, { recursive: true, force: true })
    fs.writeFileSync(configDir, 'not a directory')
    let output: string
    try {
      output = sealVaultCliOutput(`${PASSWORD}\n`, 'bw get password 1')
    } finally {
      fs.rmSync(configDir, { force: true })
      fs.mkdirSync(configDir, { recursive: true })
    }
    expect(output).not.toContain(PASSWORD)
    expect(output).toBe(VAULT_OPAQUE_HANDLE)
    expect(REDACTED_HANDLE).toBe(VAULT_OPAQUE_HANDLE)
    // the log line must not carry the value either
    for (const call of error.mock.calls) expect(JSON.stringify(call)).not.toContain(PASSWORD)
    error.mockRestore()
  })

  it('never writes a canary to secrets.json in clear text', () => {
    sealVaultCliOutput(JSON.stringify(loginItem()), 'bw get item 1111')
    const raw = fs.readFileSync(path.join(tmpDir, 'config', 'secrets.json'), 'utf-8')
    for (const value of [PASSWORD, TOTP, HIDDEN, OLDPW]) expect(raw).not.toContain(value)
  })
})
