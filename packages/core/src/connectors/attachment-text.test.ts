/**
 * Local text extraction for mail attachments. Uses the real poppler binaries
 * (`pdftotext`/`pdfinfo`, installed by the Dockerfile) on hand-built PDFs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ATTACHMENT_CALL_TOKENS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TEXT_CAP_CHARS,
  attachmentFormat,
  decodeTextBytes,
  estimateTokens,
  extractAttachmentText,
  prefixWithinTokens,
} from './attachment-text.js'
import { brokenPdf, scanPdf, textPdf } from './pdf.fixture.js'

// poppler-utils is part of the image (Dockerfile), so the PDF cases run in the
// image build's `npm test` too; they are deliberately not skipped when it is
// missing — a silently skipped extractor test would hide a broken image.
const pdfIt = it

describe('attachmentFormat', () => {
  it('trusts a specific MIME type and falls back to the extension for octet-stream', () => {
    expect(attachmentFormat('application/pdf', 'x.bin')).toBe('pdf')
    expect(attachmentFormat('application/octet-stream', 'Rechnung.PDF')).toBe('pdf')
    expect(attachmentFormat('text/csv; charset=utf-8', 'a')).toBe('csv')
    expect(attachmentFormat('text/html', 'a')).toBe('html')
    expect(attachmentFormat('message/rfc822', 'a')).toBe('eml')
    expect(attachmentFormat('', 'notes.txt')).toBe('text')
    expect(attachmentFormat('image/jpeg', 'scan.jpg')).toBe('other')
    expect(attachmentFormat('binary/octet-stream', 'notes.txt')).toBe('text')
    expect(attachmentFormat('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe('other')
  })
})

describe('attachmentFormat: conflicting type and name', () => {
  it('keeps a specific non-text MIME type metadata-only even when the name says .pdf', () => {
    expect(attachmentFormat('image/jpeg', 'invoice.pdf')).toBe('other')
    expect(attachmentFormat('application/zip', 'notes.txt')).toBe('other')
    expect(attachmentFormat('application/octet-stream', 'invoice.pdf')).toBe('pdf')
  })
})

describe('estimateTokens / prefixWithinTokens', () => {
  it('counts two ASCII characters per token and non-ASCII at its UTF-8 bytes, and cuts on the estimate', () => {
    expect(estimateTokens('abcdef')).toBe(3)
    expect(estimateTokens('abcde')).toBe(3)
    expect(estimateTokens('äöü')).toBe(6)
    expect(estimateTokens('日本')).toBe(6)
    expect(estimateTokens('😀')).toBe(4)
    expect(prefixWithinTokens('abcdefghi', 2)).toBe(4)
    expect(prefixWithinTokens('äöüäöü', 4)).toBe(2)
    expect(prefixWithinTokens('abc', 0)).toBe(0)
    // Never cuts through a surrogate pair.
    expect(prefixWithinTokens('a😀b', 3)).toBe(1)
  })

  it('never under-counts against the byte bound for non-ASCII and stays at or above chars/2 for ASCII', () => {
    const mixed = 'Rechnung Nr. 4711 – Größe 5 € · 日本語 😀'.repeat(50)
    const ascii = [...mixed].filter(ch => ch.charCodeAt(0) < 128).join('')
    const nonAsciiBytes = Buffer.byteLength(mixed, 'utf-8') - ascii.length
    expect(estimateTokens(mixed)).toBe(Math.ceil(ascii.length / 2) + nonAsciiBytes)
    // The 10k-character window costs at most the per-call token bound for ASCII.
    expect(estimateTokens('x'.repeat(ATTACHMENT_TEXT_CAP_CHARS))).toBeLessThanOrEqual(ATTACHMENT_CALL_TOKENS)
  })
})

describe('decodeTextBytes', () => {
  it('reads UTF-8, falls back to windows-1252 and refuses binary', () => {
    expect(decodeTextBytes(Buffer.from('Größe 5 €', 'utf-8'))).toBe('Größe 5 €')
    expect(decodeTextBytes(Buffer.from([0x47, 0x72, 0xf6, 0xdf, 0x65, 0x20, 0x80]))).toBe('Größe €')
    expect(decodeTextBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeNull()
  })

  it('honours a declared charset', () => {
    expect(decodeTextBytes(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]), 'iso-8859-1')).toBe('Müller')
  })
})

describe('extractAttachmentText: PDF', () => {
  pdfIt('extracts the text layer of a text PDF, with the page count', async () => {
    const pdf = textPdf([['Invoice 2026-114', 'Total 248.50 EUR'], ['Due on 2026-09-30']])
    const result = await extractAttachmentText(pdf, { mimeType: 'application/pdf', filename: 'invoice.pdf' })
    expect(result.kind).toBe('text')
    expect(result.pages).toBe(2)
    expect(result.text).toContain('Invoice 2026-114')
    expect(result.text).toContain('Total 248.50 EUR')
    expect(result.text).toContain('Due on 2026-09-30')
    expect(result.truncated).toBe(false)
    expect(result.text).not.toContain('\f')
  })

  pdfIt('reports an image-only PDF as a scan, without text', async () => {
    const result = await extractAttachmentText(scanPdf(), { mimeType: 'application/pdf', filename: 'scan.pdf' })
    expect(result.kind).toBe('scan')
    expect(result.reason).toBe('no_text_layer')
    expect(result.pages).toBe(1)
    expect(result.text).toBe('')
  })

  pdfIt('reports a broken PDF as unreadable instead of throwing', async () => {
    const result = await extractAttachmentText(brokenPdf(), { mimeType: 'application/pdf', filename: 'broken.pdf' })
    expect(result.kind).toBe('unreadable')
    expect(result.reason).toBe('pdf_damaged')
    expect(result.text).toBe('')
  })

  it('reports bytes that are no PDF at all as unreadable without running poppler', async () => {
    const result = await extractAttachmentText(Buffer.from('<html>error page</html>'), {
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
      pdftotextBin: 'definitely-not-installed-pdftotext',
    })
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'not_a_pdf' })
  })

  it('says so when pdftotext is not installed', async () => {
    const result = await extractAttachmentText(textPdf([['x']]), {
      mimeType: 'application/pdf',
      filename: 'a.pdf',
      pdftotextBin: 'definitely-not-installed-pdftotext',
      pdfinfoBin: 'definitely-not-installed-pdfinfo',
    })
    expect(result).toMatchObject({ kind: 'extractor_unavailable', reason: 'pdftotext_missing' })
  })

  pdfIt('cuts long text at the cap, marks it and pages on with offset', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${String(i).padStart(2, '0')} of the long report`)
    const pdf = textPdf([lines])
    const first = await extractAttachmentText(pdf, { mimeType: 'application/pdf', filename: 'r.pdf', capChars: 200 })
    expect(first.kind).toBe('text')
    expect(first.text.length).toBe(200)
    expect(first.truncated).toBe(true)
    expect(first.totalChars).toBeGreaterThan(1000)
    expect(first.text).toContain('Line 00')

    const next = await extractAttachmentText(pdf, { mimeType: 'application/pdf', filename: 'r.pdf', capChars: 200, offset: 200 })
    expect(next.offset).toBe(200)
    expect(next.text).not.toContain('Line 00')
    expect(first.text + next.text).toContain('Line 07')
  })
})

describe('extractAttachmentText: other formats', () => {
  it('refuses bytes above the size limit without parsing them', async () => {
    const big = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x41)
    const result = await extractAttachmentText(big, { mimeType: 'text/plain', filename: 'big.txt' })
    expect(result).toMatchObject({ kind: 'binary', reason: 'too_large', text: '' })
  })

  it('reads txt and csv, decoding windows-1252', async () => {
    const csv = Buffer.from('Datum;Betrag\n2026-09-30;248,50 \x80\n', 'latin1')
    const result = await extractAttachmentText(csv, { mimeType: 'text/csv', filename: 'umsatz.csv' })
    expect(result.kind).toBe('text')
    expect(result.text).toContain('2026-09-30;248,50 €')
  })

  it('converts html to text without tags or styles', async () => {
    const html = Buffer.from('<html><style>p{color:red}</style><body><h1>Order 77</h1><p>Ships <b>today</b>.</p></body></html>')
    const result = await extractAttachmentText(html, { mimeType: 'text/html', filename: 'order.html' })
    expect(result.kind).toBe('text')
    expect(result.text).toContain('Order 77')
    expect(result.text).toContain('today')
    expect(result.text).not.toContain('<b>')
    expect(result.text).not.toContain('color:red')
  })

  it('reads an attached eml with its headers and lists, but does not read, its own attachments', async () => {
    const eml = Buffer.from([
      'From: Alice <alice@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Forwarded offer',
      'Date: Tue, 22 Sep 2026 10:00:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The offer is valid until 2026-10-15.',
      '--b1',
      'Content-Type: application/pdf; name="offer.pdf"',
      'Content-Disposition: attachment; filename="offer.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 tiny').toString('base64'),
      '--b1--',
      '',
    ].join('\r\n'))
    const result = await extractAttachmentText(eml, { mimeType: 'message/rfc822', filename: 'offer.eml' })
    expect(result.kind).toBe('text')
    expect(result.text).toContain('subject: Forwarded offer')
    expect(result.text).toContain('alice@example.com')
    expect(result.text).toContain('valid until 2026-10-15')
    expect(result.text).toContain('attachments (not read): offer.pdf (application/pdf')
  })

  it('returns metadata only for a binary format', async () => {
    const result = await extractAttachmentText(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { mimeType: 'image/jpeg', filename: 'a.jpg' })
    expect(result).toMatchObject({ kind: 'binary', reason: 'unsupported_format', text: '' })
  })

  it('treats a binary file that claims to be text as unreadable', async () => {
    const result = await extractAttachmentText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08]), {
      mimeType: 'text/plain',
      filename: 'a.txt',
    })
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'not_text' })
  })
})

// Stand-in extractors: tiny shell scripts that misbehave in one specific way.
describe('extractAttachmentText: misbehaving extractors', () => {
  let binDir = ''
  const script = (name: string, body: string): string => {
    const file = path.join(binDir, name)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  beforeAll(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-fake-poppler-'))
  })
  afterAll(() => {
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  it('marks text cut at the extractor output bound as incomplete, never as the whole document', async () => {
    // 6 MB of text, more than the 4 MB the extractor may produce.
    const flood = script('flood-pdftotext', 'cat >/dev/null; yes "Line of a very long report" | head -c 6000000')
    const pages = script('pages-pdfinfo', 'cat >/dev/null; echo "Pages:          900"')
    const result = await extractAttachmentText(textPdf([['x']]), {
      mimeType: 'application/pdf',
      filename: 'manual.pdf',
      pdftotextBin: flood,
      pdfinfoBin: pages,
    })
    expect(result.kind).toBe('text')
    expect(result.outputLimited).toBe(true)
    expect(result.truncated).toBe(true)

    // Paging to the end of the captured prefix still says "more follows".
    const tail = await extractAttachmentText(textPdf([['x']]), {
      mimeType: 'application/pdf',
      filename: 'manual.pdf',
      pdftotextBin: flood,
      pdfinfoBin: pages,
      offset: result.totalChars,
    })
    expect(tail.text).toBe('')
    expect(tail.truncated).toBe(true)
    expect(tail.outputLimited).toBe(true)
  }, 20_000)

  it('kills a hanging extractor when the signal aborts and reports "cancelled"', async () => {
    const hang = script('hang-pdfinfo', 'sleep 30')
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 150)
    const result = await extractAttachmentText(textPdf([['x']]), {
      mimeType: 'application/pdf',
      filename: 'a.pdf',
      pdfinfoBin: hang,
      pdftotextBin: hang,
      signal: controller.signal,
    })
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'cancelled', text: '' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('returns "cancelled" at once for an already aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await extractAttachmentText(textPdf([['x']]), {
      mimeType: 'application/pdf',
      filename: 'a.pdf',
      signal: controller.signal,
    })
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'cancelled' })
  })

  pdfIt('still reports a scan when pdfinfo is missing', async () => {
    const result = await extractAttachmentText(scanPdf(), {
      mimeType: 'application/pdf',
      filename: 'scan.pdf',
      pdfinfoBin: 'definitely-not-installed-pdfinfo',
    })
    expect(result).toMatchObject({ kind: 'scan', reason: 'no_text_layer' })
    expect(result.pages).toBeUndefined()
  })

  pdfIt('still reports a scan when pdfinfo times out', async () => {
    const slow = script('slow-pdfinfo', 'sleep 10')
    const result = await extractAttachmentText(scanPdf(), {
      mimeType: 'application/pdf',
      filename: 'scan.pdf',
      pdfinfoBin: slow,
      timeoutMs: 1_500,
    })
    expect(result).toMatchObject({ kind: 'scan', reason: 'no_text_layer' })
  }, 10_000)

  pdfIt('reports damage when pdfinfo ran and rejected the file', async () => {
    const reject = script('reject-pdfinfo', 'cat >/dev/null; exit 1')
    const result = await extractAttachmentText(scanPdf(), {
      mimeType: 'application/pdf',
      filename: 'scan.pdf',
      pdfinfoBin: reject,
    })
    expect(result).toMatchObject({ kind: 'unreadable', reason: 'pdf_damaged' })
  })
})
