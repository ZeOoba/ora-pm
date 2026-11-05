import { describe, it, expect } from 'vitest'
import { toCsv } from '../../src/components/data-table/csv'

type Row = { name: string; rent: number | null; note?: string | null }
const cols = [
  { header: 'Name', accessor: (r: Row) => r.name },
  { header: 'Rent', accessor: (r: Row) => r.rent },
  { header: 'Note', accessor: (r: Row) => r.note },
]

describe('toCsv', () => {
  it('writes a header row and CRLF line endings', () => {
    const csv = toCsv([{ name: 'A', rent: 1, note: 'x' }, { name: 'B', rent: 2, note: 'y' }], cols)
    expect(csv).toBe('Name,Rent,Note\r\nA,1,x\r\nB,2,y')
  })

  it('quotes fields containing commas', () => {
    expect(toCsv([{ name: 'Acme, Inc', rent: 1 }], cols)).toContain('"Acme, Inc"')
  })

  it('escapes embedded quotes by doubling', () => {
    expect(toCsv([{ name: 'The "Big" One', rent: 1 }], cols)).toContain('"The ""Big"" One"')
  })

  it('quotes fields containing newlines', () => {
    expect(toCsv([{ name: 'line1\nline2', rent: 1 }], cols)).toContain('"line1\nline2"')
  })

  it('renders null and undefined as empty', () => {
    expect(toCsv([{ name: 'A', rent: null, note: null }], cols)).toBe('Name,Rent,Note\r\nA,,')
  })

  it('leaves numbers unformatted', () => {
    expect(toCsv([{ name: 'A', rent: 1234567.5 }], cols)).toContain(',1234567.5,')
  })

  it('quotes headers that need it', () => {
    expect(toCsv([], [{ header: 'Rent, $', accessor: () => 1 }])).toBe('"Rent, $"')
  })
})
