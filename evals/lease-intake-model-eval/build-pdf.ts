// Minimal, hand-rolled single-page PDF generator for this eval's synthetic fixtures.
//
// No PDF-generation library exists anywhere in ora-pm's dependency tree today (the app
// only ever SENDS PDF bytes to Anthropic and receives structured JSON back -- it never
// creates or parses one itself). Adding a library (e.g. pdf-lib) purely to generate a
// handful of eval fixtures would be a new dependency for a dev-only tool; a correct
// minimal PDF is simple enough (base-14 Helvetica, one content stream, no embedded
// fonts/images) that hand-building it is the smaller, more surgical change.
//
// Produces a real, spec-correct xref table (byte-accurate offsets) rather than relying
// on a reader's xref-recovery fallback -- the whole point of this eval is measuring
// genuine extraction accuracy, so the input PDF itself must not be a confound.

function escapePdfString(s: string): string {
  // PDF literal strings: backslash and unbalanced parens must be escaped.
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/** Build a single-page PDF (Letter size, Helvetica 11pt, one line of text per array entry,
 * top-down starting at y=720, 14pt leading). Returns raw PDF bytes as a Buffer. */
export function buildSimplePdf(lines: string[]): Buffer {
  const contentLines = lines.map((line, i) => {
    const y = 720 - i * 14
    return `1 0 0 1 72 ${y} Tm (${escapePdfString(line)}) Tj`
  })
  const content = `BT /F1 11 Tf\n${contentLines.join('\n')}\nET`
  const contentBytes = Buffer.from(content, 'latin1')

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream`

  const header = '%PDF-1.4\n'
  const chunks: Buffer[] = [Buffer.from(header, 'latin1')]
  const offsets: number[] = [0] // object 0 is the free-list head, never written
  let pos = chunks[0].length

  for (let i = 1; i <= 5; i++) {
    offsets[i] = pos
    const body = Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`, 'latin1')
    chunks.push(body)
    pos += body.length
  }

  const xrefOffset = pos
  const xrefLines = ['xref', `0 6`, '0000000000 65535 f ']
  for (let i = 1; i <= 5; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `)
  }
  const xref = xrefLines.join('\n') + '\n'
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  chunks.push(Buffer.from(xref, 'latin1'))
  chunks.push(Buffer.from(trailer, 'latin1'))

  return Buffer.concat(chunks)
}

/** Same as buildSimplePdf, but base64-encoded (what extractLease()/buildExtractionRequest()
 * actually consume — see server/lib/lease-extract.ts). */
export function buildSimplePdfBase64(lines: string[]): string {
  return buildSimplePdf(lines).toString('base64')
}
