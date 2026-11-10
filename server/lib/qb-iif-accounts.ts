// B8 slice 1: import an LLC's QuickBooks Desktop chart of accounts into the native ledger.
// FINANCIAL-DECISION CODE (refute-gated): the QB account type decides which statement (balance
// sheet or P&L, and which side) every future posting to the account lands on.
//
// Input: the file QuickBooks Desktop writes from File → Utilities → Export → Lists to IIF Files
// with "Chart of Accounts" ticked. IIF is tab-separated; a line starting with "!" declares the
// columns for the record type that follows it (e.g. "!ACCNT  NAME  REFNUM  ...  ACCNTTYPE ...").
// Only ACCNT records are read; any other list in the same file is ignored.
//
// Nothing here talks to the database. planAccountImport compares the parsed chart with the
// accounts the entity already has; the route inserts only the "new" accounts, all-or-nothing,
// and refuses the whole file when any account conflicts.

/** QuickBooks Desktop ACCNTTYPE codes that post to the general ledger, and the ledger type each maps to. */
export const QB_ACCOUNT_TYPES = {
  BANK: 'asset',
  AR: 'asset',
  OCASSET: 'asset',
  FIXASSET: 'asset',
  OASSET: 'asset',
  AP: 'liability',
  CCARD: 'liability',
  OCLIAB: 'liability',
  LTLIAB: 'liability',
  EQUITY: 'equity',
  INC: 'income',
  EXINC: 'income',
  COGS: 'expense',
  EXP: 'expense',
  EXEXP: 'expense',
} as const

export type QbAccountType = keyof typeof QB_ACCOUNT_TYPES
export type LedgerAccountType = (typeof QB_ACCOUNT_TYPES)[QbAccountType]

/** QB's non-posting accounts (estimates, purchase orders) carry no balances: listed, never imported. */
const NON_POSTING = 'NONPOSTING'

export const MAX_IIF_CHARS = 2_000_000
export const MAX_IIF_ACCOUNTS = 2000
const MAX_NAME = 300 // gl.ts AccountSchema
const MAX_NUMBER = 40

export type IifAccount = {
  line: number
  qb_name: string
  number: string | null
  qb_account_type: QbAccountType
  account_type: LedgerAccountType
  is_active: boolean
}

export type IifParse = {
  accounts: IifAccount[]
  skipped: { line: number; qb_name: string; reason: string }[]
  errors: string[]
}

/** One IIF field: QB quotes fields that contain special characters, doubling any inner quote. */
function unquote(field: string): string {
  const f = field.trim()
  if (f.length >= 2 && f.startsWith('"') && f.endsWith('"')) return f.slice(1, -1).replace(/""/g, '"')
  return f
}

export function parseIifAccounts(text: string): IifParse {
  const errors: string[] = []
  const accounts: IifAccount[] = []
  const skipped: IifParse['skipped'] = []
  if (text.length > MAX_IIF_CHARS) return { accounts, skipped, errors: [`file is larger than ${MAX_IIF_CHARS.toLocaleString('en-US')} characters`] }

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  let header: string[] | null = null
  let sawAccntHeader = false

  lines.forEach((raw, i) => {
    const line = i + 1
    if (raw.trim() === '') return
    const fields = raw.split('\t').map(unquote)
    const kind = fields[0].toUpperCase()
    if (kind.startsWith('!')) {
      header = kind === '!ACCNT' ? fields.map((f) => f.toUpperCase()) : null
      if (kind === '!ACCNT') sawAccntHeader = true
      return
    }
    if (kind !== 'ACCNT') return
    if (!header) {
      errors.push(`line ${line}: ACCNT row before its !ACCNT header`)
      return
    }
    const col = (name: string) => {
      const idx = header!.indexOf(name)
      return idx > 0 && idx < fields.length ? fields[idx] : ''
    }
    const name = col('NAME')
    const type = col('ACCNTTYPE').toUpperCase()
    if (!name) {
      errors.push(`line ${line}: account has no NAME`)
      return
    }
    if (name.length > MAX_NAME) {
      errors.push(`line ${line}: account name is longer than ${MAX_NAME} characters`)
      return
    }
    if (name.split(':').some((part) => part.trim() === '')) {
      errors.push(`line ${line}: "${name}" has an empty part in its Parent:Child name`)
      return
    }
    if (type === NON_POSTING) {
      skipped.push({ line, qb_name: name, reason: 'non-posting (estimates / purchase orders)' })
      return
    }
    if (!(type in QB_ACCOUNT_TYPES)) {
      errors.push(`line ${line}: "${name}" has an unknown QuickBooks account type "${type || '(blank)'}"`)
      return
    }
    const number = col('ACCNUM')
    if (number.length > MAX_NUMBER) {
      errors.push(`line ${line}: account number for "${name}" is longer than ${MAX_NUMBER} characters`)
      return
    }
    const qbType = type as QbAccountType
    accounts.push({
      line,
      qb_name: name,
      number: number || null,
      qb_account_type: qbType,
      account_type: QB_ACCOUNT_TYPES[qbType],
      is_active: col('HIDDEN').toUpperCase() !== 'Y',
    })
  })

  if (!sawAccntHeader) errors.push('no chart of accounts found: the file has no !ACCNT header (export Lists → Chart of Accounts to IIF)')
  if (accounts.length > MAX_IIF_ACCOUNTS) errors.push(`more than ${MAX_IIF_ACCOUNTS} accounts in one file`)

  // QuickBooks names and numbers are unique per company file; a repeat means a damaged or merged file.
  const byName = new Map<string, IifAccount>()
  const byNumber = new Map<string, IifAccount>()
  for (const a of accounts) {
    const key = a.qb_name.toLowerCase()
    const prior = byName.get(key)
    if (prior) errors.push(`line ${a.line}: "${a.qb_name}" repeats line ${prior.line}`)
    else byName.set(key, a)
    if (a.number) {
      const p = byNumber.get(a.number)
      if (p) errors.push(`line ${a.line}: account number ${a.number} is also used by "${p.qb_name}" (line ${p.line})`)
      else byNumber.set(a.number, a)
    }
  }
  // A sub-account's parent must be in the same file, and on the same statement side: QuickBooks
  // only lets a sub-account sit under a parent of the same type, so a mismatch means a bad file.
  for (const a of accounts) {
    const cut = a.qb_name.lastIndexOf(':')
    if (cut < 0) continue
    const parentName = a.qb_name.slice(0, cut)
    const parent = byName.get(parentName.toLowerCase())
    if (!parent) errors.push(`line ${a.line}: sub-account "${a.qb_name}" has no parent "${parentName}" in the file`)
    else if (parent.account_type !== a.account_type) {
      errors.push(`line ${a.line}: sub-account "${a.qb_name}" is ${a.account_type} but its parent is ${parent.account_type}`)
    }
  }
  return { accounts, skipped, errors }
}

export type ExistingAccount = {
  id: string
  qb_name: string
  number: string | null
  account_type: string
  qb_account_type: string | null
  is_active: boolean
}

export type AccountImportPlan = {
  /** In the file, not in the ledger: these are what an import inserts. */
  new: IifAccount[]
  /** Same name, type, QB type and number. */
  unchanged: IifAccount[]
  /** Block the import: the ledger and the file disagree on something postings depend on. */
  conflicts: { qb_name: string; line: number; reasons: string[] }[]
  /** Informational: differences that do not block (active flag; QB type not yet recorded). */
  warnings: { qb_name: string; line: number; message: string }[]
  /** In the ledger, not in the file. Never deleted by an import. */
  ledger_only: { qb_name: string; number: string | null }[]
}

export function planAccountImport(file: IifAccount[], existing: ExistingAccount[]): AccountImportPlan {
  const plan: AccountImportPlan = { new: [], unchanged: [], conflicts: [], warnings: [], ledger_only: [] }
  const byName = new Map(existing.map((e) => [e.qb_name.toLowerCase(), e]))
  const byNumber = new Map(existing.filter((e) => e.number).map((e) => [e.number as string, e]))
  const seen = new Set<string>()

  for (const a of file) {
    const e = byName.get(a.qb_name.toLowerCase())
    if (!e) {
      const taken = a.number ? byNumber.get(a.number) : undefined
      if (taken) plan.conflicts.push({ qb_name: a.qb_name, line: a.line, reasons: [`number ${a.number} already belongs to "${taken.qb_name}" in the ledger`] })
      else plan.new.push(a)
      continue
    }
    seen.add(e.id)
    const reasons: string[] = []
    if (e.qb_name !== a.qb_name) reasons.push(`the ledger spells it "${e.qb_name}"`)
    if (e.account_type !== a.account_type) reasons.push(`type is ${e.account_type} in the ledger, ${a.account_type} in QuickBooks`)
    if (e.qb_account_type && e.qb_account_type !== a.qb_account_type) reasons.push(`QuickBooks type is ${e.qb_account_type} in the ledger, ${a.qb_account_type} in the file`)
    if ((e.number ?? null) !== a.number) reasons.push(`number is ${e.number ?? '(none)'} in the ledger, ${a.number ?? '(none)'} in QuickBooks`)
    if (reasons.length) {
      plan.conflicts.push({ qb_name: a.qb_name, line: a.line, reasons })
      continue
    }
    if (!e.qb_account_type) plan.warnings.push({ qb_name: a.qb_name, line: a.line, message: `QuickBooks type ${a.qb_account_type} is not recorded on the existing ledger account` })
    if (e.is_active !== a.is_active) plan.warnings.push({ qb_name: a.qb_name, line: a.line, message: a.is_active ? 'active in QuickBooks, inactive in the ledger' : 'inactive in QuickBooks, active in the ledger' })
    plan.unchanged.push(a)
  }
  for (const e of existing) if (!seen.has(e.id)) plan.ledger_only.push({ qb_name: e.qb_name, number: e.number })
  return plan
}
