import { z } from 'zod'

// Anthropic lease extraction. The model is asked to fill an extract_lease tool whose
// schema mirrors the writable LeaseForm fields, plus a _confidence map (0..1 per field).
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
  notes: z.string().optional().catch(undefined),
})
export interface ExtractionResult {
  fields: ExtractedFields
  confidence: Record<string, number>
  warnings: string[]
}

const EXTRACT_TOOL = {
  name: 'extract_lease',
  description: 'Return the lease terms found in the document. Omit any field not clearly stated.',
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
      expense_stop_amount: { type: 'number' },
      notes: { type: 'string', description: 'any notable clauses (options, escalations, percentage rent)' },
      _confidence: { type: 'object', description: 'per-field confidence 0..1' },
    },
  },
} as const

export function buildExtractionRequest(pdfBase64: string, model: string) {
  return {
    model,
    max_tokens: 1024,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_lease' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extract the lease terms into the extract_lease tool. Only include fields clearly stated in the document; set a _confidence value (0..1) for each field you fill.' },
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
  pdfBase64: string,
  opts: { apiKey: string; model: string },
): Promise<ExtractionResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildExtractionRequest(pdfBase64, opts.model)),
  })
  if (!res.ok) {
    // Never surface the raw upstream body — it may echo document text.
    throw new Error(`Lease extraction failed (status ${res.status})`)
  }
  return parseExtractionResponse(await res.json())
}
