import { formatCurrency } from '../../lib/format'

/** Ratified 2026-11-10: the parallel run starts January 1, 2027. */
export const DEFAULT_START_MONTH = '2027-01'
export const TB_MAX_BYTES = 2 * 1024 * 1024

export const dollars = (cents: number) => formatCurrency(cents / 100)

export function tbFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.csv$/i.test(file.name)) return 'Choose the .csv saved from the QuickBooks Trial Balance report (Excel → Save As → CSV).'
  if (file.size > TB_MAX_BYTES) return 'That file is larger than 2 MB; a trial balance is far smaller.'
  return null
}
