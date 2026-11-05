// RFC 4180 CSV building. toCsv is pure; downloadCsv is browser-only.

export type CsvColumn<T> = { header: string; accessor: (row: T) => unknown }

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.accessor(row))).join(','))
  }
  return lines.join('\r\n')
}

export function downloadCsv(filename: string, csv: string): void {
  // BOM so Excel reads UTF-8 correctly.
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
