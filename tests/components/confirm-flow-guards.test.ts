import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Light source-level check (node env, no jsdom): the three ConfirmDialog flows must route their
// async action through runExclusive. The guard behavior itself is covered by tests/lib/run-exclusive.test.ts.
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

describe.each([
  ['CAM approve', '../../src/pages/cam/CAMList.tsx'],
  ['Expenses delete', '../../src/pages/expenses/ExpensesList.tsx'],
  ['TenantPortalAdmin revoke', '../../src/pages/admin/TenantPortalAdmin.tsx'],
])('%s', (_name, path) => {
  it('imports and uses runExclusive', () => {
    const src = read(path)
    expect(src).toMatch(/import \{ runExclusive \} from '\.\.\/\.\.\/lib\/run-exclusive'/)
    expect(src).toMatch(/runExclusive\(/)
  })
})
