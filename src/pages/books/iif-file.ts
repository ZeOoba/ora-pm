// Reading a QuickBooks Desktop IIF export in the browser. QuickBooks writes IIF in the Windows
// ANSI code page (Windows-1252), so a name like "Café Supplies" is not valid UTF-8. Decode as
// UTF-8 when the bytes are valid UTF-8 (a re-saved or hand-edited file), else as Windows-1252,
// so account names reach the ledger exactly as QuickBooks spells them.
export function decodeIif(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export const IIF_MAX_BYTES = 2 * 1024 * 1024

export function iifFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(iif|txt)$/i.test(file.name)) return 'Choose the .IIF file QuickBooks exported (File → Utilities → Export → Lists to IIF Files).'
  if (file.size > IIF_MAX_BYTES) return 'That file is larger than 2 MB; a chart-of-accounts export is far smaller. Export only the Chart of Accounts list.'
  return null
}
