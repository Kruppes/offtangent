/**
 * F1 (review B-A1, triage 19:25): the text of an ATTACHMENT is file content,
 * not prose the user typed — and it used to be appended to the prompt AFTER the
 * channel had sealed the message (`agent.ts:1057`, `fileHints`). A password in
 * an uploaded `.env` therefore reached the model unsealed.
 *
 * The boundary now sits in {@link buildAttachmentContext} itself, the ONE place
 * that turns an upload into model input, so every caller is covered.
 *
 * Canary values are assembled at runtime; no credential-shaped literal lives in
 * this repository.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildAttachmentContext } from './attachment-context.js'
import { invalidateKnownValues, redactKnown, SECRET_HANDLE_RE } from './secret-boundary.js'
import { invalidateSecretHandleCache, listSecrets, resolveSecret } from './secret-store.js'
import type { UploadDescriptor } from './uploads.js'

/** `ghp_` plus 36 alphanumerics — the structural `github-token` rule. */
const STRONG_CANARY = ['ghp', '_', 'Att4ch', 'Fake', 'Token', '0000', 'abcdefghij', 'klmnopqr'].join('')
/** Structureless password — only the `user` tier would see it in prose. */
const PLAIN_CANARY = ['Att', 'ach', 'ment', '-K4', 'nari3', '!'].join('')

let tmpDir: string
let uploadsDir: string
let previousDataDir: string | undefined
let previousKey: string | undefined

function handles(text: string): string[] {
  return [...text.matchAll(new RegExp(SECRET_HANDLE_RE.source, 'g'))].map(match => match[1]!)
}

function writeUpload(name: string, content: string, mimeType: string): UploadDescriptor {
  fs.writeFileSync(path.join(uploadsDir, name), content)
  return {
    id: name,
    originalName: name,
    relativePath: name,
    mimeType,
    size: Buffer.byteLength(content),
    kind: 'document',
  } as unknown as UploadDescriptor
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-seal-'))
  uploadsDir = path.join(tmpDir, 'uploads')
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'config'), { recursive: true })
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  process.env.DATA_DIR = tmpDir
  process.env.ENCRYPTION_KEY = 'test-key-for-attachment-sealing'
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(tmpDir, { recursive: true, force: true })
  invalidateSecretHandleCache()
  invalidateKnownValues()
})

describe('attachment text is sealed before it becomes prompt material', () => {
  it('replaces a structural canary in an uploaded text file by a handle', () => {
    const upload = writeUpload('deploy.md', `token: ${STRONG_CANARY}\nnothing else\n`, 'text/markdown')
    const { hints } = buildAttachmentContext([upload], { uploadsDir })
    expect(hints).toHaveLength(1)
    const hint = hints[0]!
    expect(hint).not.toContain(STRONG_CANARY)
    expect(handles(hint)).toHaveLength(1)
    expect(resolveSecret(handles(hint)[0]!)).toBe(STRONG_CANARY)
    // File name and path survive: the agent can still open the file itself.
    expect(hint).toContain('deploy.md')
  })

  it('documents the limit: a structureless password in an uploaded file survives the strong tier', async () => {
    // The triage (19:25) prescribes the `strong` tier for file content, and the
    // strong tier has no context rules — `DB_PASSWORD=<prose>` has no shape. The
    // same limit already applies to the system prompt (`sealSystemText`), and it
    // is written down in docs/guide/secrets.md ("Grenzen"). The test exists so a
    // future change of the tier is a deliberate, visible decision.
    const upload = writeUpload('.env', `DB_PASSWORD=${PLAIN_CANARY}\nPORT=3000\n`, 'text/plain')
    const { hints } = buildAttachmentContext([upload], { uploadsDir })
    expect(hints[0]!).toContain(PLAIN_CANARY)
    // A value that IS already known (sealed on another path) is redacted even here.
    const { sealSecret } = await import('./secret-store.js')
    sealSecret(PLAIN_CANARY, 'password', 'test')
    invalidateKnownValues()
    const again = buildAttachmentContext([upload], { uploadsDir }).hints[0]!
    expect(again).not.toContain(PLAIN_CANARY)
    expect(handles(again)).toHaveLength(1)
  })

  it('the prompt the agent composes from text + hints carries no canary (F1 canary test)', () => {
    const upload = writeUpload('notes.txt', `api key: ${STRONG_CANARY}`, 'text/plain')
    const { hints } = buildAttachmentContext([upload], { uploadsDir })
    // Exactly what agent.ts does with the hints (`baseText`).
    const prompt = `please read the file\n\n${hints.join('\n')}`
    expect(prompt).not.toContain(STRONG_CANARY)
    expect(handles(prompt)).toHaveLength(1)
  })

  it('files the value in the SAME store, so later turns redact it too', () => {
    const upload = writeUpload('creds.txt', `token: ${STRONG_CANARY}`, 'text/plain')
    buildAttachmentContext([upload], { uploadsDir })
    const slugs = listSecrets().map(entry => entry.slug)
    expect(slugs).toHaveLength(1)
    invalidateKnownValues()
    expect(redactKnown(`echo ${STRONG_CANARY}`)).toBe(`echo {{secret:${slugs[0]}}}`)
  })

  it('leaves an attachment without a secret byte-identical', () => {
    const upload = writeUpload('plain.txt', 'just a shopping list\nmilk\n', 'text/plain')
    const { hints } = buildAttachmentContext([upload], { uploadsDir })
    expect(hints[0]).toContain('just a shopping list')
    expect(listSecrets()).toEqual([])
  })

  it('seals the reference hint of a binary attachment too (path only, no content)', () => {
    const upload = writeUpload('archive.bin', 'binary', 'application/x-tar')
    const { hints } = buildAttachmentContext([upload], { uploadsDir })
    expect(hints[0]).toContain('archive.bin')
    expect(listSecrets()).toEqual([])
  })
})
