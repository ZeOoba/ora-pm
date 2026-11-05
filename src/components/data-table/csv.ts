// RFC 4180 CSV building. toCsv is pure; downloadCsv is browser-only.

export type CsvColumn<T> = { header: string; accessor: (row: T) => unknown }

// Spreadsheet formula injection: strings starting with these are neutralised
// with a leading apostrophe. Numbers are never touched (negatives stay numeric).
const FORMULA_START = /^[=+\-@\t\r]/

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = typeof value === 'string' ? value : String(value)
  if (typeof value === 'string' && FORMULA_START.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.accessor(row))).join(','))
  }
  return lines.join('\r\n')
}

const REVOKE_DELAY_MS = 1000

export function downloadCsv(filename: string, csv: string): void {
  // BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer so the browser can start the download before the URL is released. Firefox/Safari can
  // begin the download after click() returns, so a 0 ms revoke can race it; ~1 s is safe.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

/** Standard export name for a list page: ora-<page>-YYYY-MM-DD.csv (local date). */
export function csvFilename(page: string, now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `ora-${page}-${y}-${m}-${d}.csv`
}
