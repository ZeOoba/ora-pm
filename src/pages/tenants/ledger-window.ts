/** Tenant ledger statement window: the last six full months plus this month to date. */
export function ledgerWindow(today: Date = new Date()): { start: string; end: string } {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 6, 1)).toISOString().slice(0, 10)
  return { start, end: today.toISOString().slice(0, 10) }
}
