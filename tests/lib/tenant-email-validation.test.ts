// tests/lib/tenant-email-validation.test.ts
//
// 2026-09-12: TenantForm.tsx validated contact_email with `includes('@')`
// (untrimmed), while TenantInsertSchema uses zod `.email()`. An address such
// as `a@b` passed the form, was rejected server-side with 422, and the admin
// saw `[object Object]` because src/lib/api.ts did `new Error(err.error)` on
// a zod fieldErrors object. Two fixes, two guards:
//   1. src/lib/validation.ts isValidEmail — must agree with the server's
//      contact_email schema on every input (parity battery below; the client
//      copies zod's regex rather than bundling zod, so this is the drift guard).
//   2. src/lib/api-error.ts apiErrorMessage — turns a fieldErrors object into
//      readable text instead of `[object Object]`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidEmail } from '../../src/lib/validation'
import { apiErrorMessage } from '../../src/lib/api-error'
import { TenantInsertSchema } from '../../server/lib/schemas'

const serverAccepts = (v: string) => TenantInsertSchema.shape.contact_email.safeParse(v).success

const CASES = [
  'jane@acme.com',
  'jane.smith+ap@acme-logistics.co.uk',
  'a@b',
  'a@b.',
  'a@.com',
  '@acme.com',
  'jane@',
  'jane@@acme.com',
  'jane smith@acme.com',
  'jane@acme..com',
  'no-at-sign.com',
  "o'brien@acme.com",
  'JANE@ACME.COM',
  '.jane@acme.com',
  'jane.@acme.com',
  'jane@acme.c',
  'jane@-acme.com',
  'jane@acme-.com',
  'jane@sub.acme.io',
  'jane_doe-1@acme.com',
  'jane@acme.com ',
  '',
]

describe('isValidEmail — parity with the server contact_email schema', () => {
  it.each(CASES)('agrees with the server on %j', (value) => {
    expect(isValidEmail(value)).toBe(serverAccepts(value))
  })

  it('rejects a@b (the reported case)', () => {
    expect(isValidEmail('a@b')).toBe(false)
  })

  it('accepts an ordinary address', () => {
    expect(isValidEmail('jane@acme.com')).toBe(true)
  })
})

describe('TenantForm.tsx uses the shared validator on the trimmed value it sends', () => {
  const src = readFileSync(join(__dirname, '../../src/pages/tenants/TenantForm.tsx'), 'utf-8')

  it('no longer uses the includes("@") heuristic', () => {
    expect(src).not.toMatch(/includes\(\s*['"]@['"]\s*\)/)
  })

  it('validates with isValidEmail on the trimmed email', () => {
    expect(src).toMatch(/isValidEmail\(\s*f\.contact_email\.trim\(\)\s*\)/)
  })
})

describe('apiErrorMessage — readable text for API error bodies', () => {
  it('passes a string error through', () => {
    expect(apiErrorMessage({ error: 'Failed to create tenant' }, 'Bad Request')).toBe('Failed to create tenant')
  })

  it('formats a zod fieldErrors object instead of [object Object]', () => {
    const msg = apiErrorMessage({ error: { contact_email: ['Invalid email'] } }, 'Unprocessable Entity')
    expect(msg).not.toContain('[object Object]')
    expect(msg).toBe('contact_email: Invalid email')
  })

  it('joins multiple fields and messages', () => {
    const msg = apiErrorMessage(
      { error: { name: ['Required'], zip: ['Invalid zip', 'Too short'] } },
      'Unprocessable Entity',
    )
    expect(msg).toBe('name: Required; zip: Invalid zip, Too short')
  })

  it('falls back to statusText when the body has no usable error', () => {
    expect(apiErrorMessage({}, 'Internal Server Error')).toBe('Internal Server Error')
    expect(apiErrorMessage({ error: {} }, 'Unprocessable Entity')).toBe('Unprocessable Entity')
    expect(apiErrorMessage(null, 'Bad Gateway')).toBe('Bad Gateway')
  })

  it('src/lib/api.ts routes both error paths through apiErrorMessage', () => {
    const api = readFileSync(join(__dirname, '../../src/lib/api.ts'), 'utf-8')
    expect(api).not.toMatch(/as \{ error: string \}\)\.error/)
    expect(api.match(/apiErrorMessage\(/g)?.length).toBe(2)
  })
})
