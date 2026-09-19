import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  addressDomain,
  collectAttachmentParts,
  decodeHtmlEntities,
  describeConnectionError,
  formatAddress,
  htmlToText,
  mapAddresses,
  normalizeAddress,
  parseReferences,
  pickTrashFolder,
} from './email-client.js'

describe('htmlToText', () => {
  it('converts block markup into line breaks', () => {
    expect(htmlToText('<p>Hello</p><p>World</p>')).toBe('Hello\nWorld')
    expect(htmlToText('Line<br>Break')).toBe('Line\nBreak')
  })

  it('drops script and style content', () => {
    expect(htmlToText('<style>a{color:red}</style><p>Visible</p><script>alert(1)</script>')).toBe('Visible')
  })

  it('decodes entities and collapses whitespace', () => {
    expect(htmlToText('<div>Tom &amp;   Jerry&nbsp;&#8212;&nbsp;fun</div>')).toBe('Tom & Jerry — fun')
  })

  it('renders list items as dashes', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two')
  })

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('')
  })
})

describe('decodeHtmlEntities', () => {
  it('keeps unknown entities untouched', () => {
    expect(decodeHtmlEntities('&unknown; &lt;x&gt;')).toBe('&unknown; <x>')
  })
})

describe('normalizeAddress', () => {
  it('lowercases and trims', () => {
    expect(normalizeAddress('  Boss@Example.COM ')).toBe('boss@example.com')
  })

  it('extracts the address from a display-name form', () => {
    expect(normalizeAddress('Jane Doe <Jane.Doe@Example.com>')).toBe('jane.doe@example.com')
  })
})

describe('addressDomain', () => {
  it('returns the lowercased domain', () => {
    expect(addressDomain('Jane <Jane@Sub.Example.COM>')).toBe('sub.example.com')
  })

  it('returns an empty string when there is no domain', () => {
    expect(addressDomain('not-an-address')).toBe('')
  })
})

describe('formatAddress', () => {
  it('includes the display name when present', () => {
    expect(formatAddress({ name: 'Jane', address: 'jane@example.com' })).toBe('Jane <jane@example.com>')
    expect(formatAddress({ address: 'jane@example.com' })).toBe('jane@example.com')
  })
})

describe('mapAddresses', () => {
  it('normalizes and skips entries without an address', () => {
    expect(mapAddresses([
      { name: ' Jane ', address: 'Jane@Example.com' },
      { name: 'Ghost' },
      { address: 'bob@example.com' },
    ])).toEqual([
      { address: 'jane@example.com', name: 'Jane' },
      { address: 'bob@example.com' },
    ])
  })

  it('returns an empty array for undefined input', () => {
    expect(mapAddresses(undefined)).toEqual([])
  })
})

describe('parseReferences', () => {
  it('splits whitespace-separated message ids', () => {
    expect(parseReferences('<a@x> <b@x>')).toEqual(['<a@x>', '<b@x>'])
    expect(parseReferences(['<a@x>', '<b@x>'])).toEqual(['<a@x>', '<b@x>'])
    expect(parseReferences(undefined)).toEqual([])
  })
})

describe('collectAttachmentParts', () => {
  it('collects attachment parts from a bodystructure tree', () => {
    const parts = collectAttachmentParts({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'report.pdf' },
          size: 1234,
        },
        {
          part: '3',
          type: 'image/png',
          disposition: 'inline',
          dispositionParameters: { filename: 'logo.png' },
        },
      ],
    } as never)

    expect(parts).toEqual([
      { partId: '2', filename: 'report.pdf', contentType: 'application/pdf', size: 1234 },
    ])
  })

  it('returns an empty array for a missing node', () => {
    expect(collectAttachmentParts(undefined)).toEqual([])
  })
})

describe('describeConnectionError', () => {
  it('explains refused connections', () => {
    expect(describeConnectionError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, 'IMAP'))
      .toContain('connection refused')
  })

  it('points at the self-signed certificate flag', () => {
    const message = describeConnectionError(
      { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' },
      'SMTP',
    )
    expect(message).toContain('self-signed')
    expect(message).toContain('accept self-signed certificate')
  })

  it('explains authentication failures', () => {
    expect(describeConnectionError({ code: 'AUTHENTICATIONFAILED', message: 'LOGIN failed' }, 'IMAP'))
      .toContain('authentication failed')
  })

  it('falls back to the raw message', () => {
    expect(describeConnectionError(new Error('something odd'), 'SMTP')).toBe('SMTP: something odd')
  })

  it('keeps the server response text of a failed IMAP command', () => {
    const message = describeConnectionError(
      Object.assign(new Error('Command failed'), { responseStatus: 'NO', responseText: 'Mailbox is locked' }),
      'IMAP',
    )
    expect(message).toBe('IMAP: Command failed: Mailbox is locked')
  })
})

describe('email library encapsulation', () => {
  it('is the only module importing imapflow/mailparser/nodemailer', () => {
    const packagesDir = path.resolve(import.meta.dirname, '../..')
    const offenders: string[] = []

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (/\.(ts|vue)$/.test(entry.name)) {
          if (/from '(imapflow|mailparser|nodemailer)'/.test(fs.readFileSync(full, 'utf-8'))) {
            offenders.push(path.relative(packagesDir, full))
          }
        }
      }
    }
    walk(packagesDir)

    expect(offenders).toEqual(['core/src/email-client.ts'])
  })
})

describe('pickTrashFolder', () => {
  it('prefers the \\Trash special-use folder', () => {
    expect(pickTrashFolder([{ path: 'INBOX' }, { path: 'Bin', specialUse: '\\Trash' }], 'INBOX')).toBe('Bin')
  })

  it('falls back to a name match', () => {
    expect(pickTrashFolder([{ path: 'Papierkorb' }], 'INBOX')).toBe('Papierkorb')
  })

  it('returns null when already in trash or none exists', () => {
    expect(pickTrashFolder([{ path: 'Trash' }], 'Trash')).toBeNull()
    expect(pickTrashFolder([{ path: 'INBOX' }], 'INBOX')).toBeNull()
  })
})
