import { describe, it, expect } from 'vitest'
import { RenewalUpdateSchema } from '../../server/lib/schemas'
import { RENEWAL_STATUS_OPTIONS, renewalStatusPayload } from '../../src/pages/renewals/renewal-status'

describe('Renewals inline status edit', () => {
  it('offers exactly the statuses PUT /api/renewals/:id accepts', () => {
    const accepted = RenewalUpdateSchema.shape.status.unwrap().options
    expect(RENEWAL_STATUS_OPTIONS.map(o => o.value)).toEqual(accepted)
  })
  it('sends only { status } — a strict-schema-valid body', () => {
    const body = renewalStatusPayload('negotiating')
    expect(body).toEqual({ status: 'negotiating' })
    expect(RenewalUpdateSchema.safeParse(body).success).toBe(true)
  })
})
