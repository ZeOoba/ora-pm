/// <reference types="node" />
// tests/fixtures/refute-pdfs.ts
//
// Hand-built PDFs ported from the REFUTE pass probes (refute-orapm/intake-probe2.mjs). Each one
// shows text that a viewer (and a model reading the raw PDF) can see but pdf.js's getTextContent
// does not extract: a Link annotation appearance stream, a lying ToUnicode CMap, an image inside a
// tiling pattern or a Form XObject, a Type3 glyph drawn as an image, a shading, and glyphs drawn as
// vector paths. They pin the property the intake fix relies on: only the SCANNED text leaves, so
// anything pdf.js cannot see cannot leak, whatever the PDF paints.
import { PDFDocument, StandardFonts } from 'pdf-lib'

function rawPdf(objs: string[]): Uint8Array {
  let out = '%PDF-1.7\n%âãÏÓ\n'
  const off: number[] = []
  objs.forEach((b, k) => { off.push(Buffer.byteLength(out, 'latin1')); out += `${k + 1} 0 obj\n${b}\nendobj\n` })
  const x = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return new Uint8Array(Buffer.from(out, 'latin1'))
}
const stream = (dict: string, data: string) => `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`

export const BENIGN_LINE = 'This lease agreement is made between Landlord and Tenant.'
const benign = `BT /F1 10 Tf 20 170 Td (${BENIGN_LINE}) Tj ET`
const F1 = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
const head = (extra: { font?: string; other?: string }, extraPage = '') => [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 5 0 R ${extra.font ?? ''} >> ${extra.other ?? ''} >> /Contents 4 0 R ${extraPage} >>`,
]
const img = stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', '\u0000ÿÿ\u0000')
const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lie def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfrange <20> <7E> <0078> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end'

/** Probes whose hidden content is the term `term` (only where the probe can carry text). */
export async function buildRefuteProbes(term: string): Promise<Record<string, Uint8Array>> {
  const outlined = await (async () => {
    const d = await PDFDocument.create()
    const f = await d.embedFont(StandardFonts.Helvetica)
    const p = d.addPage([400, 200])
    p.drawText(BENIGN_LINE, { x: 20, y: 170, size: 10, font: f })
    p.drawSvgPath('M0 0 L20 0 L0 30 L20 30 M30 0 L50 0 L30 30 L50 30', { x: 20, y: 120, borderWidth: 2 })
    return d.save()
  })()
  return {
    P1_link_appearance_stream: rawPdf([...head({}, '/Annots [6 0 R]'), stream('', benign), F1,
      '<< /Type /Annot /Subtype /Link /Rect [20 40 300 80] /Border [0 0 0] /A << /S /URI /URI (https://example.com) >> /AP << /N 7 0 R >> >>',
      stream('/Type /XObject /Subtype /Form /BBox [0 0 280 40] /Resources << /Font << /F1 5 0 R >> >>', `BT /F1 14 Tf 5 12 Td (${term}) Tj ET`)]),
    P2_lying_tounicode: rawPdf([...head({ font: '/F2 6 0 R' }), stream('', `${benign}\nBT /F2 14 Tf 20 100 Td (${term}) Tj ET`), F1,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 7 0 R >>', stream('', cmap)]),
    P3_outlined_text: outlined,
    P4_image_in_tiling_pattern: rawPdf([...head({ other: '/Pattern << /P1 6 0 R >>' }), stream('', `${benign}\n/Pattern cs /P1 scn 0 0 400 150 re f`), F1,
      stream('/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 400 150] /XStep 400 /YStep 150 /Resources << /XObject << /Im1 7 0 R >> >>', 'q 400 0 0 150 0 0 cm /Im1 Do Q'), img]),
    P5_image_in_form_xobject: rawPdf([...head({ other: '/XObject << /Fm1 6 0 R >>' }), stream('', `${benign}\n/Fm1 Do`), F1,
      stream('/Type /XObject /Subtype /Form /BBox [0 0 400 150] /Resources << /XObject << /Im1 7 0 R >> >>', 'q 400 0 0 150 0 0 cm /Im1 Do Q'), img]),
    P6_type3_glyph_image: rawPdf([...head({ font: '/T3 6 0 R' }), stream('', `${benign}\nBT /T3 40 Tf 20 60 Td (aaaa) Tj ET`), F1,
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << /g 7 0 R >> /Encoding << /Type /Encoding /Differences [97 /g] >> /FirstChar 97 /LastChar 97 /Widths [1] /Resources << >> >>',
      stream('', '1 0 0 0 0 1 d1 q 1 0 0 1 0 0 cm BI /W 2 /H 2 /IM true /BPC 1 ID ÀÀ EI Q')]),
    P7_shading: rawPdf([...head({ other: '/Shading << /Sh1 << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 400 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> >>' }),
      stream('', `${benign}\nq 0 0 400 150 re W n /Sh1 sh Q`), F1]),
  }
}

/** P8: a Link annotation whose URL carries the term (the URL is scanned, so this must block). */
export function buildLinkUrlTermPdf(urlWithTerm: string): Uint8Array {
  return rawPdf([...head({}, '/Annots [6 0 R]'), stream('', benign), F1,
    `<< /Type /Annot /Subtype /Link /Rect [20 40 300 80] /A << /S /URI /URI (${urlWithTerm}) >> >>`])
}

/** P9: a structurally valid PDF with zero pages. */
export function buildZeroPagePdf(): Uint8Array {
  return rawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>'])
}
