/**
 * Tiny, hand-built PDFs for the attachment tests. Never part of a build output.
 *
 * Built in code instead of checked in as binaries so the content is reviewable
 * and every string is visibly invented.
 */

function buildPdf(objects: string[]): Buffer {
  const header = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'
  let body = header
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefAt = Buffer.byteLength(body, 'latin1')
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefAt),
    '%%EOF',
    '',
  ].join('\n')
  return Buffer.from(body + xref, 'latin1')
}

function stream(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** One page per entry of `pages`, each line drawn as real text (a text layer). */
export function textPdf(pages: string[][]): Buffer {
  const pageCount = pages.length
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  pages.forEach((lines, index) => {
    const contentRef = 5 + index * 2
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>`,
    )
    const ops = lines
      .map((line, row) => `BT /F1 11 Tf 56 ${780 - row * 16} Td (${escapePdfString(line)}) Tj ET`)
      .join('\n')
    objects.push(stream(ops))
  })
  return buildPdf(objects)
}

/** A one-page PDF whose only content is an image: what a scanner produces. */
export function scanPdf(): Buffer {
  const pixels = 'ff00ff00'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream('q 500 0 0 700 48 70 cm /Im1 Do Q'),
    `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
  ]
  return buildPdf(objects)
}

/** Starts like a PDF, then breaks off: a truncated download. */
export function brokenPdf(): Buffer {
  return Buffer.concat([textPdf([['Invoice that never arrives whole']]).subarray(0, 60), Buffer.from('\u0000\u0001garbage', 'latin1')])
}
