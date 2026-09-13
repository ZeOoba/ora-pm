// Tripwire: server/routes/cron.ts's row-cap guards and keyset paging detect truncation by
// comparing a response's length against POSTGREST_MAX_ROWS. That only works if the constant
// equals the server's `max_rows` — if the cap is LOWER than the constant, a truncated response
// looks like a short (i.e. final, complete) one and every guard is silently defeated. This pins
// the constant to the local Supabase config. It cannot see the HOSTED project's setting
// (Supabase dashboard → Project Settings → API → Max rows), which must be kept >= this value.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { POSTGREST_MAX_ROWS } from '../../server/lib/postgrest-paging'

describe('POSTGREST_MAX_ROWS matches supabase/config.toml max_rows', () => {
  it('is equal to the [api] max_rows setting', () => {
    const toml = readFileSync(join(__dirname, '../../supabase/config.toml'), 'utf-8')
    const match = toml.match(/^max_rows\s*=\s*(\d+)\s*$/m)
    expect(match, 'max_rows not found in supabase/config.toml').not.toBeNull()
    expect(POSTGREST_MAX_ROWS).toBe(Number(match![1]))
  })
})
