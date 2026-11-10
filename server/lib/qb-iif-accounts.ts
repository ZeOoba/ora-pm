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
/** Stop collecting after this many problems: a damaged file should not cost CPU or a huge response. */
export const MAX_IIF_ERRORS = 50
const READ_COLUMNS = ['NAME', 'ACCNTTYPE', 'ACCNUM', 'HIDDEN'] as const

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
  const fail = (msg: string) => { if (errors.length < MAX_IIF_ERRORS) errors.push(msg) }

  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  // Column positions for the current !ACCNT header, built once per header (first occurrence of a
  // name wins). `need` is how many fields a row must have to carry every column we read.
  let cols: Map<string, number> | null = null
  let need = 0
  let sawAccntHeader = false

  for (let i = 0; i < lines.length && errors.length < MAX_IIF_ERRORS; i++) {
    const raw = lines[i]
    const line = i + 1
    if (raw.trim() === '') continue
    const fields = raw.split('\t').map(unquote)
    const kind = fields[0].toUpperCase()
    if (kind.startsWith('!')) {
      cols = null
      if (kind === '!ACCNT') {
        sawAccntHeader = true
        cols = new Map()
        fields.forEach((f, idx) => { const k = f.toUpperCase(); if (idx > 0 && !cols!.has(k)) cols!.set(k, idx) })
        need = Math.max(0, ...READ_COLUMNS.map((c) => (cols!.get(c) ?? -1) + 1))
        if (!cols.has('NAME') || !cols.has('ACCNTTYPE')) fail(`line ${line}: the !ACCNT header has no NAME or no ACCNTTYPE column`)
      }
      continue
    }
    if (kind !== 'ACCNT') continue
    if (!cols) {
      fail(`line ${line}: ACCNT row before its !ACCNT header`)
      continue
    }
    // A short row means a field held a line break (or the file was trimmed): the number or the
    // hidden flag would be lost silently, and a hidden QB account would import as postable.
    if (fields.length < need) {
      fail(`line ${line}: row has ${fields.length} fields but the header needs ${need} (a field may contain a line break; re-export from QuickBooks)`)
      continue
    }
    const col = (name: string) => { const idx = cols!.get(name); return idx === undefined ? '' : fields[idx] }
    const name = col('NAME')
    const type = col('ACCNTTYPE').toUpperCase()
    if (!name) {
      fail(`line ${line}: account has no NAME`)
      continue
    }
    if (name.length > MAX_NAME) {
      fail(`line ${line}: account name is longer than ${MAX_NAME} characters`)
      continue
    }
    const parts = name.split(':')
    if (parts.some((part) => part.trim() === '')) {
      fail(`line ${line}: "${name}" has an empty part in its Parent:Child name`)
      continue
    }
    if (parts.some((part) => part !== part.trim())) {
      fail(`line ${line}: "${name}" has spaces at the start or end of a name part; QuickBooks does not export names that way`)
      continue
    }
    if (type === NON_POSTING) {
      skipped.push({ line, qb_name: name, reason: 'non-posting (estimates / purchase orders)' })
      continue
    }
    if (!(type in QB_ACCOUNT_TYPES)) {
      fail(`line ${line}: "${name}" has an unknown QuickBooks account type "${type || '(blank)'}"`)
      continue
    }
    const number = col('ACCNUM')
    if (number.length > MAX_NUMBER) {
      fail(`line ${line}: account number for "${name}" is longer than ${MAX_NUMBER} characters`)
      continue
    }
    const hidden = col('HIDDEN').toUpperCase()
    if (hidden !== '' && hidden !== 'Y' && hidden !== 'N') {
      fail(`line ${line}: "${name}" has HIDDEN "${col('HIDDEN')}"; QuickBooks writes Y or N`)
      continue
    }
    const qbType = type as QbAccountType
    accounts.push({
      line,
      qb_name: name,
      number: number || null,
      qb_account_type: qbType,
      account_type: QB_ACCOUNT_TYPES[qbType],
      is_active: hidden !== 'Y',
    })
  }

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
    else if (parent.qb_name !== parentName) errors.push(`line ${a.line}: sub-account "${a.qb_name}" spells its parent differently from "${parent.qb_name}"`)
    else if (parent.account_type !== a.account_type) {
      errors.push(`line ${a.line}: sub-account "${a.qb_name}" is ${a.account_type} but its parent is ${parent.account_type}`)
    }
  }
  if (errors.length > MAX_IIF_ERRORS) errors.length = MAX_IIF_ERRORS
  if (errors.length === MAX_IIF_ERRORS) errors.push(`stopped after ${MAX_IIF_ERRORS} problems; fix these and preview again`)
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
  // Exact spelling first: the ledger's unique key is case-sensitive, so it can hold "Checking"
  // and "checking"; a file row matching one exactly must not be reported against the other.
  const exact = new Map(existing.map((e) => [e.qb_name, e]))
  const byName = new Map<string, ExistingAccount>()
  for (const e of existing) if (!byName.has(e.qb_name.toLowerCase())) byName.set(e.qb_name.toLowerCase(), e)
  const byNumber = new Map(existing.filter((e) => e.number).map((e) => [e.number as string, e]))
  const seen = new Set<string>()

  for (const a of file) {
    const e = exact.get(a.qb_name) ?? byName.get(a.qb_name.toLowerCase())
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
