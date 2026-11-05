import { describe, it, expect, vi } from 'vitest'
import { toCsv, downloadCsv, csvFilename } from '../../src/components/data-table/csv'

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

describe('toCsv formula injection', () => {
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx'])('prefixes %j with an apostrophe', (v) => {
    const out = toCsv([{ name: v, rent: 1 }], cols).slice('Name,Rent,Note\r\n'.length)
    expect(out.startsWith("'") || out.startsWith('"\'')).toBe(true)
  })

  it('leaves negative numbers as numbers', () => {
    expect(toCsv([{ name: 'A', rent: -5 }], cols)).toContain('A,-5,')
  })

  it('does not touch strings that merely contain a trigger char', () => {
    expect(toCsv([{ name: 'a=b', rent: 1 }], cols)).toContain('\r\na=b,')
  })
})

describe('downloadCsv', () => {
  it('writes the BOM as an escape and defers revokeObjectURL', () => {
    vi.useFakeTimers()
    const el = { click: vi.fn(), remove: vi.fn(), href: '', download: '' }
    const blobs: unknown[][] = []
    vi.stubGlobal('Blob', class { constructor(parts: unknown[]) { blobs.push(parts) } })
    const revoke = vi.fn()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: revoke })
    vi.stubGlobal('document', { createElement: () => el, body: { appendChild: vi.fn() } })
    downloadCsv('f', 'a,b')
    expect(blobs[0][0]).toBe('\uFEFF')
    expect(revoke).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:x')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
})

describe('csvFilename', () => {
  it('builds ora-<page>-YYYY-MM-DD.csv from the local date', () => {
    expect(csvFilename('tenants', new Date(2026, 0, 5))).toBe('ora-tenants-2026-01-05.csv')
  })
})
