// Static extraction of the columns the app's Supabase calls name, for tests/db/code-columns-exist.test.ts.
//
// Walks every `.from('<table>')` chain in the given TypeScript sources with the compiler API and collects:
//   - reads:   `.select('<PostgREST select>')`, including embedded resources (`units(suite, properties(name))`);
//   - filters: `.eq/.neq/.gt/.gte/.lt/.lte/.like/.ilike/.is/.in/.contains/.containedBy/.filter/.order('<column>', ...)`;
//   - writes:  the keys of an object literal (or array of them) passed to `.insert/.update/.upsert`.
// String arguments resolve through string literals, template literals, `+` concatenation, `[...].join(sep)` and
// `const` identifiers declared in any scanned file. Anything that does not resolve (a table chosen at run time,
// a computed key) is counted in `unresolved` and skipped, never guessed: the test asserts a coverage floor so the
// check cannot quietly shrink to nothing.
import ts from 'typescript'

export type ColumnRef = { file: string; line: number; table: string; column: string; via: string }
export type Extraction = { refs: ColumnRef[]; embeds: { file: string; line: number; parent: string; name: string }[]; unresolved: { file: string; line: number; what: string }[] }

const FILTERS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'filter', 'order'])
const WRITES = new Set(['insert', 'update', 'upsert'])

type Source = { file: string; text: string }

/** Collects `const NAME = <string expression>` across all sources; a name bound to two different values is dropped. */
function constTable(files: ts.SourceFile[]): Map<string, string | null> {
  const consts = new Map<string, string | null>()
  const pending: [string, ts.Expression, ts.SourceFile][] = []
  for (const sf of files) {
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) {
        pending.push([n.name.text, n.initializer, sf])
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  // Two passes so a const built from another const (declared later or in another file) resolves.
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, init] of pending) {
      const v = evalString(init, consts)
      if (v === undefined) continue
      const prev = consts.get(name)
      if (prev === undefined) consts.set(name, v)
      else if (prev !== v && pass === 0) consts.set(name, null)
    }
  }
  return consts
}

const NO_BINDINGS = new Map<string, string>()

/**
 * For a call inside a helper bound to a name (`const page = (table, cols) => db.from(table).select(cols)`, or a
 * function declaration), one binding of the helper's parameters per call site in the same file, from the
 * arguments that resolve. One level only: a helper called with its own parameters is not followed further.
 */
function bindingSets(n: ts.Node, sf: ts.SourceFile, consts: Map<string, string | null>): Map<string, string>[] {
  // The nearest enclosing function that is bound to a name; an anonymous callback in between
  // (`(after) => db.from(table)…` inside `page`) is passed through.
  let f: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration | undefined
  let name: string | undefined
  for (let p: ts.Node | undefined = n.parent; p && !name; p = p.parent) {
    if (!ts.isArrowFunction(p) && !ts.isFunctionExpression(p) && !ts.isFunctionDeclaration(p)) continue
    f = p
    name = ts.isFunctionDeclaration(p) ? p.name?.text : ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) ? p.parent.name.text : undefined
  }
  if (!f || !name) return []
  const params = f.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null))
  const sets: Map<string, string>[] = []
  const visit = (c: ts.Node) => {
    if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === name) {
      const b = new Map<string, string>()
      c.arguments.forEach((a, i) => { const v = evalString(a, consts); if (params[i] && v !== undefined) b.set(params[i]!, v) })
      sets.push(b)
    }
    ts.forEachChild(c, visit)
  }
  visit(sf)
  return sets
}

/** Evaluates a string-valued expression statically; undefined when it cannot. */
function evalString(e: ts.Expression, consts: Map<string, string | null>, b: Map<string, string> = NO_BINDINGS): string | undefined {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return evalString(e.expression, consts, b)
  if (ts.isIdentifier(e)) return b.get(e.text) ?? consts.get(e.text) ?? undefined
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text
    for (const span of e.templateSpans) {
      const v = evalString(span.expression, consts, b)
      if (v === undefined) return undefined
      out += v + span.literal.text
    }
    return out
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = evalString(e.left, consts, b)
    const r = evalString(e.right, consts, b)
    return l === undefined || r === undefined ? undefined : l + r
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'join') {
    let arr: ts.Expression = e.expression.expression
    while (ts.isParenthesizedExpression(arr) || ts.isAsExpression(arr)) arr = arr.expression
    if (!ts.isArrayLiteralExpression(arr)) return undefined
    const sep = e.arguments.length === 0 ? ',' : evalString(e.arguments[0], consts, b)
    if (sep === undefined) return undefined
    const parts = arr.elements.map((x) => evalString(x, consts, b))
    return parts.some((p) => p === undefined) ? undefined : parts.join(sep)
  }
  return undefined
}

/** Splits on commas that are not inside parentheses. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

export type SelectItem = { column: string } | { embed: string; items: SelectItem[] }

/**
 * Parses a PostgREST select list into columns and embedded resources. Handles `*`, `alias:col`, `col::cast`,
 * `col->json->>key`, `rel!hint(...)`, `alias:rel!inner(...)` and `...rel(...)` spreads. Aggregates such as
 * `count()` and `amount.sum()` are skipped. Throws on unbalanced parentheses.
 */
export function parseSelect(sel: string): SelectItem[] {
  let depth = 0
  for (const ch of sel) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) break }
  if (depth !== 0) throw new Error(`unbalanced parentheses in select: ${sel}`)
  const items: SelectItem[] = []
  for (let raw of splitTop(sel)) {
    raw = raw.replace(/^\.\.\./, '')
    const paren = raw.indexOf('(')
    if (paren >= 0) {
      let head = raw.slice(0, paren).trim()
      const body = raw.slice(paren + 1, raw.lastIndexOf(')'))
      if (head.includes(':')) head = head.slice(head.indexOf(':') + 1)
      head = head.split('!')[0].trim()
      if (head === '' || head === 'count' || head.includes('.')) continue // count() / col.sum() aggregates
      items.push({ embed: head, items: parseSelect(body) })
      continue
    }
    let col = raw.split('::')[0] // cast
    if (col.includes(':')) col = col.slice(col.indexOf(':') + 1) // alias
    col = col.split('->')[0].trim() // JSON path
    if (col === '*' || col === '') continue
    items.push({ column: col })
  }
  return items
}

/** The `.from(x)` call at the root of a property-access/call chain, or null. */
function chainRoot(e: ts.Expression): ts.CallExpression | null {
  let cur: ts.Expression = e
  for (;;) {
    if (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
      if (cur.expression.name.text === 'from') return cur
      cur = cur.expression.expression
    } else if (ts.isPropertyAccessExpression(cur) || ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression
    } else return null
  }
}

function objectKeys(e: ts.Expression): string[] | undefined {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression
  if (ts.isArrayLiteralExpression(e)) {
    const all: string[] = []
    for (const el of e.elements) { const k = objectKeys(el); if (k === undefined) return undefined; all.push(...k) }
    return all
  }
  if (!ts.isObjectLiteralExpression(e)) return undefined
  const keys: string[] = []
  for (const p of e.properties) {
    if (ts.isSpreadAssignment(p)) continue // a spread's keys are not knowable here; the literal keys still are
    if (!p.name) return undefined
    if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) keys.push(p.name.text)
    else return undefined
  }
  return keys
}

export function extractColumnRefs(sources: Source[]): Extraction {
  const files = sources.map((s) => ts.createSourceFile(s.file, s.text, ts.ScriptTarget.ES2022, true, s.file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS))
  const consts = constTable(files)
  const out: Extraction = { refs: [], embeds: [], unresolved: [] }

  for (const sf of files) {
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const visit = (n: ts.Node) => {
      ts.forEachChild(n, visit)
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
      const method = n.expression.name.text
      if (method !== 'select' && !FILTERS.has(method) && !WRITES.has(method)) return
      const root = chainRoot(n.expression.expression)
      if (!root || root.arguments.length !== 1) return
      const recv = root.expression as ts.PropertyAccessExpression
      const recvText = recv.expression.getText(sf)
      if (/(^|\.)storage$/.test(recvText) || recvText === 'Array') return
      if (n.arguments.length === 0) return
      const line = lineOf(n)

      // Returns why the call could not be resolved under bindings b, or null once its refs are recorded.
      const attempt = (b: Map<string, string>): string | null => {
        const table = evalString(root.arguments[0], consts, b)
        if (table === undefined) return `table of .${method}()`
        if (method === 'select') {
          const sel = evalString(n.arguments[0], consts, b)
          if (sel === undefined) return `select list on ${table}`
          const walk = (parent: string, items: SelectItem[]) => {
            for (const it of items) {
              if ('column' in it) out.refs.push({ file: sf.fileName, line, table: parent, column: it.column, via: 'select' })
              else { out.embeds.push({ file: sf.fileName, line, parent, name: it.embed }); walk(it.embed, it.items) }
            }
          }
          walk(table, parseSelect(sel))
        } else if (FILTERS.has(method)) {
          const opts = n.arguments[n.arguments.length - 1]
          if (n.arguments.length > 1 && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => p.name && /^(foreignTable|referencedTable)$/.test(p.name.getText(sf)))) return null
          const col = evalString(n.arguments[0], consts, b)
          if (col === undefined) return `.${method}() column on ${table}`
          if (col.includes('.')) return null // a filter on an embedded resource (`leases.tenant_id`)
          out.refs.push({ file: sf.fileName, line, table, column: col.split('->')[0], via: method })
        } else {
          const keys = objectKeys(n.arguments[0])
          if (keys === undefined) return `.${method}() payload on ${table}`
          for (const k of keys) out.refs.push({ file: sf.fileName, line, table, column: k, via: method })
        }
        return null
      }

      const why = attempt(NO_BINDINGS)
      if (why === null) return
      // Not resolvable on its own: try each call site of the enclosing helper. Unresolved only if none resolves.
      let resolvedAny = false
      for (const b of bindingSets(n, sf, consts)) if (b.size > 0 && attempt(b) === null) resolvedAny = true
      if (!resolvedAny) out.unresolved.push({ file: sf.fileName, line, what: why })
    }
    visit(sf)
  }
  return out
}
