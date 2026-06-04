export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export function formatSF(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US').format(value) + ' SF'
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  // Parse as local date (not UTC) to avoid timezone-shifted display
  const [year, month, day] = dateStr.slice(0, 10).split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

export function formatPSF(value: number | null | undefined): string {
  if (value == null) return '—'
  return '$' + value.toFixed(2) + '/SF'
}
