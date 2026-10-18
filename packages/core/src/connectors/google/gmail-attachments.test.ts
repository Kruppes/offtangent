/**
 * gmail_list_attachments / gmail_read_attachment against the fake Google
 * upstream (production URLs, real token store and manifest).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createConnectorToolContext } from '../access.js'
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TEXT_CAP_CHARS } from '../attachment-text.js'
import { GMAIL_BASE_URL } from './api.js'
import { GMAIL_MESSAGE_MAX_RESPONSE_BYTES, GMAIL_THREAD_MAX_RESPONSE_BYTES } from './gmail.js'
import { ATTACHMENT_MAX_RESPONSE_BYTES, createGmailReadAttachmentTool } from './gmail-attachments.js'
import { brokenPdf, scanPdf, textPdf } from '../pdf.fixture.js'
import { saveConnectorTokens, setConnectorClient } from '../store.js'
import {
  createFakeGoogle,
  FAKE_GOOGLE_MESSAGES,
  GOOGLE_FAKE_ATTACHMENT_CANARY,
} from './fake-google.fixture.js'
import type { FakeGoogle, FakeMessage } from './fake-google.fixture.js'
import { createGoogleConnectorManifest, GOOGLE_SCOPES } from './manifest.js'

const manifest = createGoogleConnectorManifest({ resolveTimeZone: () => 'Europe/Berlin' })
let dataDir = ''
let previousDataDir: string | undefined
let previousKey: string | undefined

function b64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const HEADERS = {
  From: 'Alice <alice@example.com>',
  To: 'Bob <bob@example.com>',
  Subject: 'Documents',
  Date: 'Mon, 28 Sep 2026 09:00:00 +0200',
}

/** A message with one text part and the given attachment parts. */
function messageWith(id: string, attachments: Array<Record<string, unknown>>): FakeMessage {
  const text = 'See attached.'
  return {
    id,
    threadId: `thr-${id}`,
    snippet: text,
    internalDate: '1790000000000',
    headers: HEADERS,
    payload: {
      mimeType: 'multipart/mixed',
      body: { size: 0 },
      parts: [
        { mimeType: 'text/plain', body: { size: text.length, data: b64url(Buffer.from(text)) } },
        ...(attachments as unknown as FakeMessage['payload'][]),
      ],
    },
  }
}

const LONG_PDF = textPdf(
  Array.from({ length: 12 }, (_, page) =>
    Array.from({ length: 40 }, (_, row) => `Page ${page + 1} row ${row + 1}: quarterly figures for the example ledger`)),
)

const MESSAGES: FakeMessage[] = [
  ...FAKE_GOOGLE_MESSAGES,
  messageWith('m-scan', [
    { mimeType: 'application/pdf', filename: 'scan.pdf', body: { size: scanPdf().length, attachmentId: 'a-scan' } },
  ]),
  messageWith('m-broken', [
    { mimeType: 'application/pdf', filename: 'broken.pdf', body: { size: brokenPdf().length, attachmentId: 'a-broken' } },
    // Inline (small) attachment next to the broken one: must still be readable.
    {
      mimeType: 'text/plain',
      filename: 'notes.txt',
      body: { size: 22, data: b64url(Buffer.from('Remember the 3 pallets')) },
    },
  ]),
  messageWith('m-big', [
    { mimeType: 'application/pdf', filename: 'huge.pdf', body: { size: ATTACHMENT_MAX_BYTES + 1, attachmentId: 'a-big' } },
    { mimeType: 'image/jpeg', filename: 'photo.jpg', body: { size: 54_321, attachmentId: 'a-photo' } },
  ]),
  messageWith('m-long', [
    { mimeType: 'application/octet-stream', filename: 'ledger.pdf', body: { size: LONG_PDF.length, attachmentId: 'a-long' } },
  ]),
  messageWith('m-badb64', [
    { mimeType: 'text/plain', filename: 'bad.txt', body: { size: 10, attachmentId: 'a-badb64' } },
  ]),
  messageWith('m-dupe', [
    { mimeType: 'text/plain', filename: 'same.txt', body: { size: 1, data: b64url(Buffer.from('a')) } },
    { mimeType: 'text/plain', filename: 'same.txt', body: { size: 1, data: b64url(Buffer.from('b')) } },
  ]),
  messageWith('m-none', []),
  // Declared size missing (0) although the real body is over the limit.
  messageWith('m-zero', [
    { mimeType: 'application/pdf', filename: 'zero.pdf', body: { size: 0, attachmentId: 'a-zero' } },
  ]),
  // Declared size far below what Gmail then returns.
  messageWith('m-under', [
    { mimeType: 'application/pdf', filename: 'under.pdf', body: { size: 100, attachmentId: 'a-under' } },
  ]),
  // An attachment nested two levels deep whose attachment id Gmail re-issues
  // on every message fetch (see rotatingIds below).
  messageWith('m-nested', [
    {
      mimeType: 'multipart/related',
      body: { size: 0 },
      parts: [
        { mimeType: 'text/html', body: { size: 9, data: b64url(Buffer.from('<p>hi</p>')) } },
        { mimeType: 'application/pdf', filename: 'nested.pdf', body: { size: 900, attachmentId: 'a-rot' } },
      ],
    },
  ]),
]

function fakeWithFixtures(): FakeGoogle {
  return createFakeGoogle({
    messages: MESSAGES,
    attachments: {
      'msg-1003a/att-1': () => textPdf([['Delivery note 8821', `Reference ${GOOGLE_FAKE_ATTACHMENT_CANARY}`], ['Pallets: 3']]),
      'm-scan/a-scan': () => scanPdf(),
      'm-broken/a-broken': () => brokenPdf(),
      'm-long/a-long': () => LONG_PDF,
      'm-big/a-big': () => Buffer.alloc(16),
      'm-big/a-photo': () => Buffer.alloc(16),
    },
  })
}

function toolsOf(fake: FakeGoogle): Record<string, AgentTool> {
  const ctx = createConnectorToolContext(manifest, { fetchImpl: fake.fetchImpl })
  const out: Record<string, AgentTool> = {}
  for (const tool of manifest.createTools(ctx)) out[tool.name] = tool
  return out
}

interface RunResult {
  text: string
  details: Record<string, unknown>
}

async function run(tool: AgentTool, params: Record<string, unknown>): Promise<RunResult> {
  const result = await (tool as unknown as {
    execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>
  }).execute('call-1', params)
  return { text: result.content.map(part => part.text).join('\n'), details: result.details ?? {} }
}

function attachmentDownloads(fake: FakeGoogle): string[] {
  return fake.requests.map(r => r.url).filter(url => url.includes('/attachments/'))
}

beforeEach(() => {
  previousDataDir = process.env.DATA_DIR
  previousKey = process.env.ENCRYPTION_KEY
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-gmail-att-'))
  process.env.DATA_DIR = dataDir
  process.env.ENCRYPTION_KEY = '0'.repeat(64)
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })
  setConnectorClient(manifest.id, { clientId: 'client-id-from-the-provider', clientSecret: 'client-secret-for-tests-only' })
  saveConnectorTokens(manifest.id, {
    accessToken: 'access-token-before-refresh',
    refreshToken: 'refresh-token-abcdefghij',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: GOOGLE_SCOPES,
  })
})

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDataDir
  if (previousKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = previousKey
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('gmail_read_thread: attachment hints', () => {
  it('shows the message id and the part id so the model can fetch an attachment', async () => {
    const fake = fakeWithFixtures()
    const { text } = await run(toolsOf(fake).gmail_read_thread, { threadId: 'thr-1003' })
    expect(text).toContain('message id: msg-1003a')
    expect(text).toContain('delivery-note.pdf (application/pdf, 20480 bytes) [part 1]')
    expect(text).toContain('gmail_read_attachment')
    expect(attachmentDownloads(fake)).toEqual([])
  })
})

describe('gmail_list_attachments', () => {
  it('lists name, type, size, part id and readability without downloading', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_list_attachments, { messageId: 'm-big' })
    expect(text).toContain('2 attachment(s) in message "m-big"')
    expect(text).toContain('message=m-big | part=1 | huge.pdf | application/pdf | 15.0 MB | too large (limit 15 MB), not readable')
    expect(text).toContain('message=m-big | part=2 | photo.jpg | image/jpeg | 53 KB | metadata only')
    expect(details).toEqual({ attachments: 2 })
    expect(attachmentDownloads(fake)).toEqual([])
  })

  it('lists across a whole thread', async () => {
    const fake = fakeWithFixtures()
    const { text } = await run(toolsOf(fake).gmail_list_attachments, { threadId: 'thr-1003' })
    expect(text).toContain('message=msg-1003a | part=1 | delivery-note.pdf | application/pdf | 20 KB | readable as pdf')
  })

  it('says so for a mail without attachments', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_list_attachments, { messageId: 'm-none' })
    expect(text).toBe('No attachments in message "m-none".')
    expect(details).toEqual({ attachments: 0 })
  })

  it('needs a thread or a message id', async () => {
    const { text } = await run(toolsOf(fakeWithFixtures()).gmail_list_attachments, {})
    expect(text).toContain('`threadId` or `messageId` is required')
  })
})

describe('gmail_read_attachment', () => {
  it('downloads a text PDF and returns its text layer', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'msg-1003a', partId: '1' })
    expect(text).toContain('attachment: delivery-note.pdf (application/pdf')
    expect(text).toContain('2 page(s)')
    expect(text).toContain('status: text extracted')
    expect(text).toContain('Delivery note 8821')
    expect(text).toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(text).toContain('Pallets: 3')
    expect(attachmentDownloads(fake)).toHaveLength(1)
    expect(attachmentDownloads(fake)[0]).toContain('/gmail/v1/users/me/messages/msg-1003a/attachments/att-1')
    // details carry metadata only, never content.
    expect(JSON.stringify(details)).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(JSON.stringify(details)).not.toContain('Pallets')
    expect(details).toMatchObject({ format: 'pdf', kind: 'text', downloaded: true, truncated: false })
  })

  it('finds the attachment by its unique file name as well', async () => {
    const fake = fakeWithFixtures()
    const { text } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'msg-1003a', filename: 'delivery-note.pdf' })
    expect(text).toContain('Delivery note 8821')
  })

  it('refuses an ambiguous file name and asks for the part id', async () => {
    const { text } = await run(toolsOf(fakeWithFixtures()).gmail_read_attachment, { messageId: 'm-dupe', filename: 'same.txt' })
    expect(text).toContain('several attachments are named "same.txt"; pass the part id')
  })

  it('reports a scanned PDF as "kein Text, Scan" without inventing content', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'm-scan', partId: '1' })
    expect(text).toContain('status: kein Text, Scan')
    expect(text).toContain('1 page(s)')
    expect(text).not.toContain('--- text')
    expect(details).toMatchObject({ kind: 'scan', downloaded: true })
  })

  it('refuses an attachment over the size limit before downloading it', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'm-big', partId: '1' })
    expect(text).toContain('status: not read — larger than the 15 MB limit.')
    expect(details).toMatchObject({ kind: 'too_large', downloaded: false })
    expect(attachmentDownloads(fake)).toEqual([])
  })

  it('returns metadata only for a binary format, without downloading', async () => {
    const fake = fakeWithFixtures()
    const { text, details } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'm-big', partId: '2' })
    expect(text).toContain('attachment: photo.jpg (image/jpeg, 53 KB)')
    expect(text).toContain('status: metadata only')
    expect(details).toMatchObject({ kind: 'binary', downloaded: false })
    expect(attachmentDownloads(fake)).toEqual([])
  })

  it('reports a broken PDF as unreadable, and the next attachment of the same mail still reads', async () => {
    const fake = fakeWithFixtures()
    const tools = toolsOf(fake)
    const broken = await run(tools.gmail_read_attachment, { messageId: 'm-broken', partId: '1' })
    expect(broken.text).toContain('status: unreadable — the file is damaged or not what its type claims (pdf_damaged)')
    expect(broken.details).toMatchObject({ kind: 'unreadable' })

    const notes = await run(tools.gmail_read_attachment, { messageId: 'm-broken', partId: '2' })
    expect(notes.text).toContain('Remember the 3 pallets')
    // The small attachment came inline: no second download.
    expect(attachmentDownloads(fake)).toHaveLength(1)
  })

  it('cuts a long PDF at the cap, says so, and continues at the offset', async () => {
    const fake = fakeWithFixtures()
    const tools = toolsOf(fake)
    const first = await run(tools.gmail_read_attachment, { messageId: 'm-long', partId: '1' })
    expect(first.text).toContain('status: text extracted')
    expect(first.text).toContain(`--- text, characters 0-${ATTACHMENT_TEXT_CAP_CHARS} of `)
    expect(first.text).toContain(`Call gmail_read_attachment again with offset=${ATTACHMENT_TEXT_CAP_CHARS} to continue.`)
    expect(first.text).toContain('Page 1 row 1:')
    expect(first.text.length).toBeLessThan(ATTACHMENT_TEXT_CAP_CHARS + 800)
    expect(first.details).toMatchObject({ truncated: true })

    const second = await run(tools.gmail_read_attachment, {
      messageId: 'm-long',
      partId: '1',
      offset: ATTACHMENT_TEXT_CAP_CHARS,
    })
    expect(second.text).toContain(`--- text, characters ${ATTACHMENT_TEXT_CAP_CHARS}-`)
    expect(second.text).not.toContain('Page 1 row 1:')
  })

  it('treats an attachment body that is not base64url as unreadable', async () => {
    const fake = createFakeGoogle({
      messages: MESSAGES,
      attachments: {},
    })
    // Serve a corrupt body for this one attachment.
    const corrupt: typeof fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/attachments/a-badb64')) {
        return new Response(JSON.stringify({ size: 10, data: '***not base64***' }), { status: 200 })
      }
      return fake.fetchImpl(input, init)
    }
    const ctx = createConnectorToolContext(manifest, { fetchImpl: corrupt })
    const tool = manifest.createTools(ctx).find(t => t.name === 'gmail_read_attachment') as AgentTool
    const { text, details } = await run(tool, { messageId: 'm-badb64', partId: '1' })
    expect(text).toContain('status: unreadable')
    expect(text).toContain('invalid_base64')
    expect(details).toMatchObject({ kind: 'unreadable' })
  })

  it('answers an unknown part id with the list of known parts', async () => {
    const { text } = await run(toolsOf(fakeWithFixtures()).gmail_read_attachment, { messageId: 'm-big', partId: '9' })
    expect(text).toContain('no attachment with part id "9". Known parts: 1=huge.pdf, 2=photo.jpg.')
  })

  it('says so for a mail without attachments', async () => {
    const { text } = await run(toolsOf(fakeWithFixtures()).gmail_read_attachment, { messageId: 'm-none', partId: '1' })
    expect(text).toContain('the message has no attachments.')
  })

  it('answers a missing message with a coarse upstream code', async () => {
    const { text } = await run(toolsOf(fakeWithFixtures()).gmail_read_attachment, { messageId: 'nope', partId: '1' })
    expect(text).toContain('upstream http_404')
  })

  it('never writes the attachment to disk', async () => {
    const before = fs.readdirSync(dataDir, { recursive: true }).map(String).sort()
    await run(toolsOf(fakeWithFixtures()).gmail_read_attachment, { messageId: 'msg-1003a', partId: '1' })
    expect(fs.readdirSync(dataDir, { recursive: true }).map(String).sort()).toEqual(before)
  })

  it('only ever issues GET requests against Gmail', async () => {
    const fake = fakeWithFixtures()
    const tools = toolsOf(fake)
    await run(tools.gmail_list_attachments, { threadId: 'thr-1003' })
    await run(tools.gmail_read_attachment, { messageId: 'msg-1003a', partId: '1' })
    const gmail = fake.requests.filter(r => r.url.includes('gmail.googleapis.com'))
    expect(gmail.length).toBeGreaterThan(0)
    expect(gmail.every(r => r.method === 'GET')).toBe(true)
  })
})

/** Wrap a fetch: answer `/attachments/<id>` URLs matching `match` with `respond`. */
function withAttachmentResponse(fake: FakeGoogle, match: string, respond: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes(`/attachments/${match}`)) return respond()
    return fake.fetchImpl(input, init)
  }) as typeof fetch
}

function readTool(fetchImpl: typeof fetch, extra: { runBudgetTokens?: number } = {}): AgentTool {
  const ctx = createConnectorToolContext(manifest, { fetchImpl })
  return createGmailReadAttachmentTool({ ctx, baseUrl: GMAIL_BASE_URL, formatDate: value => value, ...extra })
}

describe('gmail_read_attachment: sizes Gmail did not declare honestly', () => {
  it('refuses an over-limit body behind a declared size of 0', async () => {
    const fake = createFakeGoogle({
      messages: MESSAGES,
      attachments: { 'm-zero/a-zero': () => Buffer.alloc(ATTACHMENT_MAX_BYTES + 1024, 0x41) },
    })
    const { text, details } = await run(toolsOf(fake).gmail_read_attachment, { messageId: 'm-zero', partId: '1' })
    expect(text).toContain('status: not read — larger than the 15 MB limit.')
    expect(details).toMatchObject({ kind: 'too_large', downloaded: false })
  }, 30_000)

  it('refuses a body larger than an understated size before decoding it', async () => {
    const fake = createFakeGoogle({ messages: MESSAGES, attachments: {} })
    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1024, 0x41)
    const fetchImpl = withAttachmentResponse(fake, 'a-under', () =>
      // `size` lies as well: only the data length gives it away.
      new Response(JSON.stringify({ size: 100, data: b64url(oversized) }), { status: 200 }))
    const { text, details } = await run(readTool(fetchImpl), { messageId: 'm-under', partId: '1' })
    expect(text).toContain('larger than the 15 MB limit')
    expect(details).toMatchObject({ kind: 'too_large' })
  }, 30_000)

  it('drops a response stream that grows past the bound, with or without Content-Length', async () => {
    const fake = createFakeGoogle({ messages: MESSAGES, attachments: {} })
    let pulled = 0
    const endless = (): Response => {
      // An endless body: the reader must stop on its own, not wait for the end.
      const chunk = new Uint8Array(256 * 1024).fill(0x41)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"size":100,"data":"')) },
        pull(controller) { pulled += chunk.length; controller.enqueue(chunk) },
      })
      return new Response(stream, { status: 200 })
    }
    const first = await run(readTool(withAttachmentResponse(fake, 'a-under', endless)), { messageId: 'm-under', partId: '1' })
    expect(first.text).toContain('larger than the 15 MB limit')
    expect(pulled).toBeLessThan(ATTACHMENT_MAX_RESPONSE_BYTES + 2 * 256 * 1024)

    const declared = (): Response => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(ATTACHMENT_MAX_RESPONSE_BYTES + 1) },
    })
    const second = await run(readTool(withAttachmentResponse(fake, 'a-under', declared)), { messageId: 'm-under', partId: '1' })
    expect(second.text).toContain('larger than the 15 MB limit')
  }, 30_000)
})

describe('gmail_read_attachment: failures never echo upstream content', () => {
  it('keeps a canary in an upstream error body out of the result and details', async () => {
    const fake = fakeWithFixtures()
    const failing = withAttachmentResponse(fake, 'att-1', () =>
      new Response(`internal error while serving ${GOOGLE_FAKE_ATTACHMENT_CANARY}`, { status: 500 }))
    const { text, details } = await run(readTool(failing), { messageId: 'msg-1003a', partId: '1' })
    expect(text).toContain('Error: upstream')
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(JSON.stringify(details)).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
  })

  it('keeps a canary in malformed JSON out of the result and details', async () => {
    const fake = fakeWithFixtures()
    const garbled = withAttachmentResponse(fake, 'att-1', () =>
      new Response(`{"data": "${GOOGLE_FAKE_ATTACHMENT_CANARY}`, { status: 200 }))
    const { text, details } = await run(readTool(garbled), { messageId: 'msg-1003a', partId: '1' })
    expect(text).toContain('invalid_json')
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(JSON.stringify(details)).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
  })

  it('maps a fetch that throws with content in its message to a fixed code', async () => {
    const fake = fakeWithFixtures()
    const throwing = withAttachmentResponse(fake, 'att-1', () => {
      throw new Error(`socket closed after ${GOOGLE_FAKE_ATTACHMENT_CANARY}`)
    })
    const { text, details } = await run(readTool(throwing), { messageId: 'msg-1003a', partId: '1' })
    expect(text).toContain('network_error')
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(JSON.stringify(details)).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
  })
})

describe('gmail_read_attachment: per-run budget and offsets', () => {
  it('cuts at the run budget, then refuses further reads without downloading', async () => {
    const fake = fakeWithFixtures()
    // One full window (5k estimated tokens), then a second one cut by the budget.
    const tool = readTool(fake.fetchImpl, { runBudgetTokens: 7_000 })
    const first = await run(tool, { messageId: 'm-long', partId: '1' })
    expect(first.details).toMatchObject({ kind: 'text', truncated: true })
    expect(first.details.budgetCut).toBeUndefined()

    const end = Number(/characters 0-(\d+) of/.exec(first.text)?.[1])
    const second = await run(tool, { messageId: 'm-long', partId: '1', offset: end })
    expect(second.details).toMatchObject({ kind: 'text', truncated: true, budgetCut: true })
    expect(second.text).toContain('budget of this run is now used up')

    const downloadsBefore = attachmentDownloads(fake).length
    const third = await run(tool, { messageId: 'm-long', partId: '1', offset: end * 2 })
    expect(third.text).toContain('status: budget_exhausted')
    expect(third.details).toMatchObject({ kind: 'budget_exhausted', downloaded: false })
    expect(attachmentDownloads(fake).length).toBe(downloadsBefore)
  })

  it('gives every run (every createTools call) a fresh budget', async () => {
    const fake = fakeWithFixtures()
    for (let runNo = 0; runNo < 2; runNo++) {
      const tools = toolsOf(fake)
      for (let i = 0; i < 3; i++) {
        const result = await run(tools.gmail_read_attachment, { messageId: 'm-long', partId: '1', offset: i * ATTACHMENT_TEXT_CAP_CHARS })
        expect(result.details.kind).toBe('text')
      }
      const after = await run(tools.gmail_read_attachment, { messageId: 'm-long', partId: '1', offset: 0 })
      expect(['text', 'budget_exhausted']).toContain(after.details.kind)
    }
  })

  it('clamps a negative offset, and an offset at or past the end returns no text and no cut', async () => {
    const tools = toolsOf(fakeWithFixtures())
    const negative = await run(tools.gmail_read_attachment, { messageId: 'm-broken', partId: '2', offset: -1 })
    expect(negative.text).toContain('--- text, characters 0-22 of 22 ---')
    expect(negative.text).toContain('Remember the 3 pallets')

    const atEnd = await run(tools.gmail_read_attachment, { messageId: 'm-broken', partId: '2', offset: 22 })
    expect(atEnd.text).toContain('--- text, characters 22-22 of 22 ---')
    expect(atEnd.text).toContain('(no text in this range)')
    expect(atEnd.details).toMatchObject({ truncated: false })

    const beyond = await run(tools.gmail_read_attachment, { messageId: 'm-broken', partId: '2', offset: 999 })
    expect(beyond.text).toContain('--- text, characters 22-22 of 22 ---')
    expect(beyond.details).toMatchObject({ truncated: false })
  })
})

describe('gmail_read_attachment: nested part with a re-issued attachment id', () => {
  it('finds the nested part by its stable part id and downloads with the id of the current fetch', async () => {
    const fake = createFakeGoogle({ messages: MESSAGES, attachments: {} })
    let generation = 0
    const pdf = textPdf([['Nested contract 77']])
    const rotating: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/attachments/')) {
        // Only the id of the latest message fetch is valid.
        if (!url.includes(`/attachments/a-rot-${generation}`)) {
          return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid attachment token' } }), { status: 400 })
        }
        return new Response(JSON.stringify({ size: pdf.length, data: b64url(pdf) }), { status: 200 })
      }
      const response = await fake.fetchImpl(input, init)
      if (!/\/messages\/m-nested(\?|$)/.test(new URL(url).pathname + (new URL(url).search ? '?' : ''))) return response
      generation += 1
      const body = (await response.text()).replace(/"a-rot"/g, `"a-rot-${generation}"`)
      return new Response(body, { status: response.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const tool = readTool(rotating)
    for (let i = 0; i < 2; i++) {
      const { text } = await run(tool, { messageId: 'm-nested', partId: '1.1' })
      expect(text).toContain('attachment: nested.pdf')
      expect(text).toContain('Nested contract 77')
    }
    expect(generation).toBe(2)
  })
})

/** Wrap a fetch: answer every Gmail URL whose path+query matches `pattern` with `respond`. */
function withGmailResponse(fake: FakeGoogle, pattern: RegExp, respond: () => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (pattern.test(url.pathname + url.search)) return respond()
    return fake.fetchImpl(input, init)
  }) as typeof fetch
}

/**
 * A body that never ends. It opens with a canary (as a mail body would), and
 * its `cancel()` can be made to never settle, like a stuck socket.
 */
function endlessResponse(counter: { pulled: number }, opts: { hangingCancel?: boolean; contentLength?: number } = {}): Response {
  const chunk = new Uint8Array(256 * 1024).fill(0x41)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"id":"x","snippet":"${GOOGLE_FAKE_ATTACHMENT_CANARY}","raw":"`))
    },
    pull(controller) {
      counter.pulled += chunk.length
      controller.enqueue(chunk)
    },
    cancel() {
      return opts.hangingCancel ? new Promise<void>(() => undefined) : undefined
    },
  })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.contentLength !== undefined) headers['content-length'] = String(opts.contentLength)
  return new Response(stream, { status: 200, headers })
}

const MESSAGE_FETCH = /\/users\/me\/messages\/m-long\?format=full/
const THREAD_FETCH = /\/users\/me\/threads\/thr-1003\?format=full/

describe('message and thread fetches are bounded before any attachment logic', () => {
  it('gmail_read_attachment drops an endless messages.get body with a fixed code and downloads nothing', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const fetchImpl = withGmailResponse(fake, MESSAGE_FETCH, () => endlessResponse(counter))
    const { text, details } = await run(readTool(fetchImpl), { messageId: 'm-long', partId: '1' })
    expect(text).toContain('Error: response_too_large')
    expect(details).toMatchObject({ error: true, code: 'response_too_large' })
    expect(counter.pulled).toBeLessThan(GMAIL_MESSAGE_MAX_RESPONSE_BYTES + 2 * 256 * 1024)
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(JSON.stringify(details)).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    expect(attachmentDownloads(fake)).toEqual([])
  }, 30_000)

  it('gmail_read_attachment refuses a messages.get body whose Content-Length is over the bound, without reading it', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const fetchImpl = withGmailResponse(fake, MESSAGE_FETCH, () =>
      endlessResponse(counter, { contentLength: GMAIL_MESSAGE_MAX_RESPONSE_BYTES + 1 }))
    const { text, details } = await run(readTool(fetchImpl), { messageId: 'm-long', partId: '1' })
    expect(details).toMatchObject({ code: 'response_too_large' })
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
    // Only what the stream buffers on its own before the first read.
    expect(counter.pulled).toBeLessThanOrEqual(256 * 1024)
  })

  it('gmail_list_attachments bounds both the message and the thread fetch', async () => {
    const fake = fakeWithFixtures()
    const messageCounter = { pulled: 0 }
    const byMessage = await run(
      toolsOf({ ...fake, fetchImpl: withGmailResponse(fake, MESSAGE_FETCH, () => endlessResponse(messageCounter)) }).gmail_list_attachments,
      { messageId: 'm-long' },
    )
    expect(byMessage.details).toMatchObject({ code: 'response_too_large' })
    expect(messageCounter.pulled).toBeLessThan(GMAIL_MESSAGE_MAX_RESPONSE_BYTES + 2 * 256 * 1024)

    const threadCounter = { pulled: 0 }
    const byThread = await run(
      toolsOf({ ...fake, fetchImpl: withGmailResponse(fake, THREAD_FETCH, () => endlessResponse(threadCounter)) }).gmail_list_attachments,
      { threadId: 'thr-1003' },
    )
    expect(byThread.details).toMatchObject({ code: 'response_too_large' })
    expect(threadCounter.pulled).toBeLessThan(GMAIL_THREAD_MAX_RESPONSE_BYTES + 2 * 256 * 1024)
    expect(byThread.text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
  }, 30_000)

  it('gmail_read_thread bounds the thread fetch as well', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const tools = toolsOf({ ...fake, fetchImpl: withGmailResponse(fake, THREAD_FETCH, () => endlessResponse(counter)) })
    const { text, details } = await run(tools.gmail_read_thread, { threadId: 'thr-1003' })
    expect(details).toMatchObject({ code: 'response_too_large' })
    expect(counter.pulled).toBeLessThan(GMAIL_THREAD_MAX_RESPONSE_BYTES + 2 * 256 * 1024)
    expect(text).not.toContain(GOOGLE_FAKE_ATTACHMENT_CANARY)
  }, 30_000)

  it('reads a 403 error body only up to a small bound', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const fetchImpl = withGmailResponse(fake, MESSAGE_FETCH, () => {
      const endless = endlessResponse(counter)
      return new Response(endless.body, { status: 403 })
    })
    const { text } = await run(readTool(fetchImpl), { messageId: 'm-long', partId: '1' })
    expect(text).toContain('http_403')
    expect(counter.pulled).toBeLessThanOrEqual(2 * 256 * 1024)
  })
})

describe('a stream whose cancel() never settles does not hang the call', () => {
  it('returns after crossing the bound while streaming', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const fetchImpl = withGmailResponse(fake, MESSAGE_FETCH, () => endlessResponse(counter, { hangingCancel: true }))
    const started = Date.now()
    const { details } = await run(readTool(fetchImpl), { messageId: 'm-long', partId: '1' })
    expect(details).toMatchObject({ code: 'response_too_large' })
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it('returns after refusing a too-large Content-Length', async () => {
    const fake = fakeWithFixtures()
    const counter = { pulled: 0 }
    const fetchImpl = withGmailResponse(fake, MESSAGE_FETCH, () =>
      endlessResponse(counter, { hangingCancel: true, contentLength: GMAIL_MESSAGE_MAX_RESPONSE_BYTES + 1 }))
    const { details } = await run(readTool(fetchImpl), { messageId: 'm-long', partId: '1' })
    expect(details).toMatchObject({ code: 'response_too_large' })
  }, 15_000)
})
