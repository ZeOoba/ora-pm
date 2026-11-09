import { z } from 'zod'

// Anthropic lease extraction. The model is asked to fill an extract_lease tool whose
// schema mirrors the writable LeaseForm fields, plus a _confidence map (0..1 per field).
//
// INPUT IS SCANNED TEXT ONLY (REFUTE C1b round 2): the request carries the per-page text that the
// intake confidentiality scan already cleared, never the raw PDF. A PDF can paint content pdf.js
// does not extract (images, form-field / annotation appearances, a lying ToUnicode map, outlined or
// Type3 glyphs); sending the raw bytes would send that unscanned content too. Sending only the
// scanned text makes "what leaves" identical to "what was scanned". Accepted tradeoff: extraction
// quality can drop on complex layouts (tables, multi-column, rent schedules in images) because the
// model no longer sees the rendered page.
export type ExtractedFields = Record<string, unknown>

// Server-side validation of the model's tool output. Unknown keys are stripped;
// any field with the wrong type is dropped (per-field `.catch(undefined)`) rather
// than failing the whole parse; an out-of-enum rent_type is dropped.
const FieldsSchema = z.object({
  start_date: z.string().optional().catch(undefined),
  end_date: z.string().optional().catch(undefined),
  base_rent_monthly: z.number().optional().catch(undefined),
  cam_estimate_monthly: z.number().optional().catch(undefined),
  security_deposit: z.number().optional().catch(undefined),
  rent_type: z.enum(['nnn', 'gross', 'modified_gross']).optional().catch(undefined),
  ti_allowance: z.number().optional().catch(undefined),
  expense_stop_amount: z.number().optional().catch(undefined),
  // Percent as printed in the lease (12.5 = 12.5%), (0, 100]; LeaseForm converts it to the
  // fraction stored in leases.proportionate_share_pct. Out-of-range values are dropped.
  // REFUTE D2: under 1 is dropped (most likely a fraction, 0.125 for 12.5%); a genuine sub-1% share
  // is entered by hand.
  proportionate_share_percent: z.number().min(1).max(100).optional().catch(undefined),
  base_year: z.number().int().min(1900).max(2200).optional().catch(undefined),
  base_year_expense_amount: z.number().min(0).optional().catch(undefined),
  notes: z.string().optional().catch(undefined),
})
export interface ExtractionResult {
  fields: ExtractedFields
  confidence: Record<string, number>
  warnings: string[]
}

const EXTRACT_TOOL = {
  name: 'extract_lease',
  description: 'Return the lease terms found in the extracted lease text. Omit any field not clearly stated in the text.',
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'ISO YYYY-MM-DD' },
      end_date: { type: 'string', description: 'ISO YYYY-MM-DD' },
      base_rent_monthly: { type: 'number', description: 'monthly base rent in dollars' },
      cam_estimate_monthly: { type: 'number' },
      security_deposit: { type: 'number' },
      rent_type: { type: 'string', enum: ['nnn', 'gross', 'modified_gross'] },
      ti_allowance: { type: 'number' },
      expense_stop_amount: { type: 'number', description: 'expense stop in dollars per square foot per YEAR ($/SF/yr); if the lease states only a total or monthly figure, omit this field and mention it in notes' },
      proportionate_share_percent: { type: 'number', description: "Tenant's Proportionate Share as a PERCENT exactly as the lease states it (12.5 for 12.5%). Omit if the lease states only the square-foot formula without a percentage." },
      base_year: { type: 'integer', description: 'Base Year for Operating Costs and Taxes, a calendar year (e.g. 2026). Omit for a full NNN lease with no base year.' },
      base_year_expense_amount: { type: 'number', description: 'Base-year Operating Costs and Taxes TOTAL in dollars for the whole Building or Project, only if the lease states that dollar figure. Never a $/SF figure; otherwise omit.' },
      notes: { type: 'string', description: 'any notable clauses (options, escalations, percentage rent)' },
      _confidence: { type: 'object', description: 'per-field confidence 0..1' },
    },
  },
} as const

/** One text block: every scanned page, in order, under a "--- Page n of N ---" separator. */
function formatPages(pages: readonly string[]): string {
  return pages.map((text, i) => `--- Page ${i + 1} of ${pages.length} ---\n${text}`).join('\n\n')
}

export function buildExtractionRequest(pages: readonly string[], model: string) {
  // Runtime guard as well as the type: a raw base64 PDF string must never reach this request.
  if (!Array.isArray(pages)) throw new TypeError('buildExtractionRequest expects scanned page text (string[]), not a PDF')
  return {
    model,
    max_tokens: 1024,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_lease' },
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Below is the extracted text of a commercial lease, page by page. Text was extracted '
            + 'from a PDF, so layout, tables and images are not preserved and words may be split '
            + 'across lines. Extract the lease terms into the extract_lease tool. Only include fields '
            + 'clearly stated in the text; set a _confidence value (0..1) for each field you fill.\n\n'
            + formatPages(pages),
        },
      ],
    }],
  }
}

export function parseExtractionResponse(json: unknown): ExtractionResult {
  const content = (json as { content?: Array<Record<string, unknown>> }).content ?? []
  const tool = content.find(b => b.type === 'tool_use' && b.name === 'extract_lease') as
    | { input?: Record<string, unknown> } | undefined
  if (!tool?.input) {
    return { fields: {}, confidence: {}, warnings: ['No structured lease data was returned. Enter fields manually.'] }
  }
  const { _confidence, ...rawFields } = tool.input

  // Validate/coerce the model output: drop unknown keys + wrong-typed values.
  const parsed = FieldsSchema.parse(rawFields)
  const fields: ExtractedFields = {}
  for (const [k, v] of Object.entries(parsed)) if (v !== undefined) fields[k] = v

  // Confidence: keep only numeric entries in [0,1]; ignore anything malformed.
  const confidence: Record<string, number> = {}
  if (_confidence && typeof _confidence === 'object') {
    for (const [k, v] of Object.entries(_confidence as Record<string, unknown>)) {
      if (typeof v === 'number' && v >= 0 && v <= 1) confidence[k] = v
    }
  }

  return { fields, confidence, warnings: [] }
}

export async function extractLease(
  pages: readonly string[],
  opts: { apiKey: string; model: string },
): Promise<ExtractionResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildExtractionRequest(pages, opts.model)),
  })
  if (!res.ok) {
    // Never surface the raw upstream body — it may echo document text.
    throw new Error(`Lease extraction failed (status ${res.status})`)
  }
  return parseExtractionResponse(await res.json())
}
