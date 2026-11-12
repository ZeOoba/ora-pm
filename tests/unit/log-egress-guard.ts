// tests/unit/log-egress-guard.ts
//
// Static allow-list taint check behind tests/unit/workflow-log-egress.test.ts (see that file's
// header for the rules, the claim and the known limits). Kept out of the test file so a reviewer
// harness can import the same analyzer the test runs.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = process.env.ORA_PM_ROOT || join(fileURLToPath(new URL('.', import.meta.url)), '../..')

export type Finding = { where: string; rule: string; text: string }

// ── shell parsing ───────────────────────────────────────────────────────────────

/**
 * Heredocs. A quoted delimiter (<<'EOF' / <<"EOF") body is literal text: dropped. An unquoted body
 * expands variables, so its references are appended to the opening line as `"$x"` words and the
 * owning command is analysed with them (`cat >&2 <<MSG` + `$body` in the body => a finding).
 */
function foldHeredocs(text: string): string {
  const out: string[] = []
  let end: string | null = null
  let quoted = false
  let openerIdx = -1
  for (const line of text.split(/\r?\n/)) {
    if (end !== null) {
      if (line.trim() === end) { end = null; continue }
      if (!quoted && openerIdx >= 0) {
        const refs = [...line.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => ` "$${m[1]}"`).join('')
        out[openerIdx] += refs
      }
      continue
    }
    out.push(line)
    const m = line.match(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/)
    const at = m?.index ?? 0
    if (m && line[at + 2] !== '<' && line[at - 1] !== '<') {
      end = m[3]
      quoted = m[2] !== ''
      openerIdx = out.length - 1
    }
  }
  return out.join('\n')
}

/**
 * Split a shell script into simple commands (pipelines), honouring quotes, $(...) nesting,
 * comments and `\`-newline continuations. Separators: newline, `;`, `&&`, `||` at top level.
 */
export function shellCommands(text: string): string[] {
  const src = foldHeredocs(text)
  const cmds: string[] = []
  const stack: ('dq' | 'sub' | 'paren')[] = []
  let cur = ''
  const flush = () => {
    const c = cur.trim()
    if (c) cmds.push(c)
    cur = ''
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const top = stack[stack.length - 1]
    if (ch === '\\') {
      if (src[i + 1] === '\n') { cur += ' '; i++; continue }
      if (src[i + 1] === '\r' && src[i + 2] === '\n') { cur += ' '; i += 2; continue }
      cur += ch + (src[i + 1] ?? '')
      i++
      continue
    }
    if (top === 'dq') {
      if (ch === '"') stack.pop()
      else if (ch === '$' && src[i + 1] === '(') { stack.push('sub'); cur += '$('; i++; continue }
      cur += ch
      continue
    }
    if (ch === "'") {
      const j = src.indexOf("'", i + 1)
      const k = j === -1 ? src.length - 1 : j
      cur += src.slice(i, k + 1)
      i = k
      continue
    }
    if (ch === '"') { stack.push('dq'); cur += ch; continue }
    if (ch === '#' && (i === 0 || /[\s;]/.test(src[i - 1]))) {
      while (i < src.length && src[i] !== '\n') i++
      i--
      continue
    }
    if (ch === '$' && src[i + 1] === '(') { stack.push('sub'); cur += '$('; i++; continue }
    if (ch === '(') { stack.push('paren'); cur += ch; continue }
    if (ch === ')') { if (stack.length) stack.pop(); cur += ch; continue }
    if (stack.length === 0) {
      if (ch === '\n' || ch === '\r') { flush(); continue }
      if (ch === ';') { flush(); while (src[i + 1] === ';') i++; continue }
      if ((ch === '&' && src[i + 1] === '&') || (ch === '|' && src[i + 1] === '|')) { flush(); i++; continue }
    }
    cur += ch
  }
  flush()
  // Strip control keywords / grouping / case-pattern prefixes so the real command comes first.
  return cmds
    .map((c) => {
      let s = c
      for (;;) {
        const t = s
          .replace(/^(?:if|elif|while|until|then|else|do|done|fi|esac|!|\{|\}|\(|\))(?=\s|$)\s*/, '')
          .replace(/^[^\s()$"'=]+\)\s+/, '') // case pattern `2[0-9][0-9]) cmd`
          .replace(/\s*(?:\}|fi|done|esac)$/, '')
        if (t === s) break
        s = t.trim()
      }
      return s.trim()
    })
    .filter((c) => c && !/^[^\s()$"'=]+\)$/.test(c)) // lone case pattern
}

/** Text outside single quotes (single-quoted text never expands variables). */
function unSingle(s: string): string {
  return s.replace(/'[^']*'/g, "''")
}

/** Top-level pipeline stages (split on `|`, not `||`, outside quotes and $(...)). */
function stages(cmd: string): string[] {
  const out: string[] = []
  let depth = 0, sq = false, dq = false, cur = ''
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === '\\') { cur += ch + (cmd[i + 1] ?? ''); i++; continue }
    if (!dq && ch === "'") sq = !sq
    else if (!sq && ch === '"') dq = !dq
    else if (!sq && ch === '(') depth++
    else if (!sq && ch === ')') depth--
    else if (!sq && !dq && depth === 0 && ch === '|' && cmd[i + 1] !== '|' && cmd[i - 1] !== '|') {
      out.push(cur.trim()); cur = ''; continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

/** Read one shell word from the start of `s` (quotes and $(...) aware); returns [word, rest]. */
function readWord(s: string): [string, string] {
  let depth = 0, sq = false, dq = false
  let i = 0
  for (; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') { i++; continue }
    if (!dq && ch === "'") sq = !sq
    else if (!sq && ch === '"') dq = !dq
    else if (!sq && ch === '(') depth++
    else if (!sq && ch === ')') depth--
    else if (!sq && !dq && depth <= 0 && /\s/.test(ch)) break
  }
  return [s.slice(0, i), s.slice(i).trim()]
}

/**
 * Leading `NAME=value` words. With nothing after them the command is a plain assignment; with a
 * command after them they are an environment prefix and `rest` is the command that runs.
 */
function splitAssignments(cmd: string): { assigns: [string, string][]; rest: string } {
  const assigns: [string, string][] = []
  let s = cmd.replace(/^(?:local|export|readonly|declare(?:\s+-\w+)?)\s+/, '')
  for (;;) {
    const m = s.match(/^([A-Za-z_]\w*)=/)
    if (!m) break
    const [word, rest] = readWord(s)
    assigns.push([m[1], word.slice(m[0].length)])
    s = rest
  }
  return { assigns, rest: assigns.length ? s : cmd }
}

const CURLISH = /(?:^|[\s(;|&`])(?:curl|wget|"?\$\{?CURL_BIN\}?"?|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)(?=\s|$)/
const GH_API = /(?:^|[\s(;|&`])gh\s+api(?=\s)/
const isNetwork = (s: string) => CURLISH.test(unSingle(s)) || GH_API.test(unSingle(s))

/** Variables referenced (expanded) in `s`. */
function varRefs(s: string): string[] {
  return [...unSingle(s).matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1])
}

const XTRACE: [RegExp, string][] = [
  [/(?:^|[\s;])set\s+(?:-[A-Za-z]*x[A-Za-z]*|-o\s+xtrace)\b/m, 'set -x / set -o xtrace'],
  [/(?:^|[\s;(|&])(?:ba|z|da)?sh\s+(?:-[A-Za-z]*x[A-Za-z]*)(?=\s|$)/m, 'bash -x'],
  [/^#!.*\bsh\s+-[A-Za-z]*x/m, 'xtrace shebang'],
]

function xtraceFindings(where: string, code: string): Finding[] {
  const noComments = code.split(/\r?\n/).filter((l) => !/^\s*#(?!!)/.test(l)).join('\n')
  return XTRACE.filter(([re]) => re.test(noComments)).map(([, rule]) => ({ where, rule: `G1 xtrace (${rule})`, text: '' }))
}

/**
 * Is `inner` (the body of a `$(...)`) a numeric extractor that removes taint? `tail -n1` counts
 * only when every variable it reads is a curl `-w` capture (the status code is curl's last line).
 */
function isNumericExtractor(inner: string, scope: string, wCaptures: Set<string>): boolean {
  const st = stages(inner.replace(/\s*\|\|\s*true\s*$/, ''))
  const last = st[st.length - 1]
  if (/^tail\s+(?:-n\s*1|-1)$/.test(last)) {
    const refs = varRefs(inner)
    return refs.length > 0 && refs.every((v) => wCaptures.has(v))
  }
  if (/^wc\s+-[lc]$/.test(last)) return true
  const jq = last.match(/^jq\s+-r\s+'\.([A-Za-z_]\w*)'$/)
  if (jq) return new RegExp(String.raw`\(\.${jq[1]}\|type\)=="number"`).test(scope)
  const gr = last.match(/^grep\s+-o[E]?\s+'([^']*)'$/)
  if (gr) return /^[\^$0-9{},+ ]*$/.test(gr[1].replace(/\[0-9\]/g, ''))
  return false
}

const SILENT_STDOUT = /(?:^|\s)1?>\s*\/dev\/null(?=\s|$)/
const SILENT_STDERR = /(?:^|\s)(?:2>\s*\/dev\/null|2>&1|&>\s*\/dev\/null)(?=\s|$)/
const BAD_NET_FLAG = /(?:\s-o\s*-(?=\s|$)|--output\s+-(?=\s|$)|\/dev\/(?:stdout|stderr|tty|fd\/[12])|-q?O\s*-(?=\s|$)|\s-v(?=\s|$)|--verbose|--trace|\s-D\s+-(?=\s|$)|(?:^|\|)\s*tee\b)/
// Files GitHub renders (step summary) or hands to later steps (outputs, env, path): a sink.
const GITHUB_FILE = /\$\{?GITHUB_(?:STEP_SUMMARY|OUTPUT|ENV|PATH|STATE)\b/

function fileRedirect(stage: string): string | null {
  const m = unSingle(stage).match(/(?:^|\s)(?:1)?>>?\s*("?)([^\s"&>]+)\1/)
  return m && m[2] !== '/dev/null' ? m[2] : null
}

/** The file a curl/wget writes with -o / --output / -O <file>, if any. */
function netOutputFile(bare: string): string | null {
  return bare.match(/\s(?:-o|--output|-O)\s*("?)([^\s"-][^\s")]*)\1/)?.[2] ?? null
}

/** Analyse one shell scope (a run block or a script). */
export function analyzeShell(where: string, code: string): Finding[] {
  const findings: Finding[] = [...xtraceFindings(where, code)]
  const tainted = new Set<string>()
  const wCaptures = new Set<string>()
  const taintedFiles = new Set<string>()
  const touches = (s: string) =>
    varRefs(s).some((v) => tainted.has(v)) || [...taintedFiles].some((f) => unSingle(s).includes(f))
  const flag = (rule: string, text: string) => findings.push({ where, rule, text })

  for (const full of shellCommands(code)) {
    const { assigns, rest } = splitAssignments(full)
    const isAssignment = assigns.length > 0 && rest === ''
    // An env prefix's values still count: `X="$body" printenv X` reads the body.
    const cmd = isAssignment ? full : rest
    const prefixTouches = !isAssignment && assigns.some(([, v]) => touches(v))
    const bare = unSingle(full)

    if (isNetwork(full)) {
      if (BAD_NET_FLAG.test(bare)) flag('G2 network output to the log (-o -, /dev/std*, tee, -O-, -v, --trace)', full)
      const curl = CURLISH.test(bare)
      const outFile = netOutputFile(bare)
      if (outFile && curl) taintedFiles.add(outFile) // recorded before any `continue` (row a)
      if (isAssignment) {
        const [name, value] = assigns[assigns.length - 1]
        if (/^"?\$\(/.test(value)) {
          if (curl) {
            tainted.add(name)
            if (/\s(?:-w|--write-out)(?=\s)/.test(bare)) wCaptures.add(name)
            else wCaptures.delete(name)
          }
          continue
        }
      }
      const st = stages(cmd)
      const last = st[st.length - 1]
      const redirect = fileRedirect(last)
      if (redirect && GITHUB_FILE.test(redirect)) flag('G2 network output written to a GitHub step file', full)
      if (!redirect && !outFile && !SILENT_STDOUT.test(last)) flag('G2 network command output not captured or redirected', full)
      if (redirect && curl) taintedFiles.add(redirect)
      continue
    }

    if (isAssignment) {
      for (const [name, raw] of assigns) {
        const value = raw.trim()
        if (touches(value)) {
          const sub = value.match(/^"?\$\(([\s\S]*)\)"?$/)
          if (sub && isNumericExtractor(sub[1], code, wCaptures)) tainted.delete(name)
          else tainted.add(name)
        } else {
          tainted.delete(name)
        }
        wCaptures.delete(name)
      }
      continue
    }

    if (/^read\b/.test(cmd)) {
      const names = cmd.replace(/<<<[\s\S]*$/, '').split(/\s+/).slice(1).filter((w) => /^[A-Za-z_]\w*$/.test(w))
      const fromResponse = touches(cmd) || prefixTouches
      for (const n of names) {
        if (fromResponse) tainted.add(n)
        else tainted.delete(n)
      }
      continue
    }

    if (!touches(cmd) && !prefixTouches) continue
    const st = stages(cmd)
    const last = st[st.length - 1]
    const redirect = fileRedirect(last)
    if ((redirect && GITHUB_FILE.test(redirect)) || GITHUB_FILE.test(unSingle(last).replace(/^[^>]*/, ''))) {
      flag('T response data written to $GITHUB_STEP_SUMMARY / OUTPUT / ENV', full)
      continue
    }
    if (/^(?:\[\[?|test|case)(?=\s)/.test(cmd)) continue
    const tee = /\btee\b/.test(unSingle(cmd))
    if (/^grep\s+(?:-[A-Za-z]*q[A-Za-z]*)(?=\s)/.test(last.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')) && !tee) continue
    if (SILENT_STDOUT.test(last) && SILENT_STDERR.test(last) && !tee) continue
    if (redirect && SILENT_STDERR.test(last) && !tee) { taintedFiles.add(redirect); continue }
    flag(/^(?:echo|printf)\b/.test(cmd) ? 'T echo/printf of response data' : 'T command writes response data to the log', full)
  }
  return findings
}

// ── JS / TS and PowerShell ──────────────────────────────────────────────────────

/** The text of the balanced (...) or {...} that opens at `open`. */
function balanced(src: string, open: number): string {
  const o = src[open], c = o === '(' ? ')' : '}'
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

const JS_NET_CALL = /\b(?:fetch|fetchImpl)\s*\(|\b(?:execFileSync|execSync|spawnSync|execFile|spawn)\s*\(\s*['"`](?:curl|wget|supabase|gh|wrangler)\b/
const JS_BODY = /\.(?:text|json|arrayBuffer|blob)\s*\(\s*\)/
const JS_SINK = /\b(?:console\.(?:log|error|warn|info|debug|dir|table|trace)|process\.std(?:out|err)\.write|log|fail|logger\.\w+)\s*\(/g
const ID = '[A-Za-z_$][\\w$]*'

/**
 * Taint in JS/TS: fetch()/network-CLI results, res.text()/json() values, and what is copied from
 * them by plain assignment, member access or destructuring, plus `.then(x => ...)` parameters on
 * a network chain. A function call over tainted data does NOT propagate (that is a deliberate
 * transformation, e.g. parseMigrationList(stdout) -> migration file names).
 */
export function analyzeJs(where: string, raw: string): Finding[] {
  // Comments are not code: drop block comments and `//` comments that start a line or follow
  // whitespace (so `https://` inside a string survives).
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  const findings: Finding[] = []
  const tainted = new Set<string>()

  type Assign = { names: string[]; rhs: string }
  const assigns: Assign[] = []
  for (const m of src.matchAll(new RegExp(String.raw`(?:\b(?:const|let|var)\s+)?(\{[^{}=]*\}|\[[^\[\]=]*\]|${ID})\s*=(?![=>])\s*(?:await\s+)?([^;\n]*)`, 'g'))) {
    const lhs = m[1]
    const names = /^[{[]/.test(lhs)
      ? [...lhs.slice(1, -1).matchAll(new RegExp(String.raw`(?:${ID}\s*:\s*)?(${ID})`, 'g'))].map((x) => x[1])
      : [lhs]
    assigns.push({ names, rhs: m[2] })
  }
  const accessOfTainted = (rhs: string) =>
    new RegExp(String.raw`^\(?\s*(?:await\s+)?(${ID})(?:\s*(?:\??\.\s*${ID}|\[[^\]]*\]))*\s*\)?\s*(?:as\s+\w+)?\s*$`).exec(rhs.trim())
  for (let changed = true; changed;) {
    changed = false
    for (const a of assigns) {
      const acc = accessOfTainted(a.rhs)
      const hit = JS_NET_CALL.test(a.rhs) || JS_BODY.test(a.rhs) || (acc !== null && tainted.has(acc[1]))
      if (!hit) continue
      for (const n of a.names) if (!tainted.has(n)) { tainted.add(n); changed = true }
    }
  }
  // `.then(x => ...)` / `.then((x) => ...)` / `.then(function (x) ...)` on a network chain.
  for (const stmt of src.split(/;|\n(?=\s*(?:const|let|var|return|await|if|for|try)\b)/)) {
    if (!JS_NET_CALL.test(stmt) && ![...tainted].some((t) => new RegExp(String.raw`\b${t.replace(/\$/g, '\\$')}\b`).test(stmt))) continue
    for (const m of stmt.matchAll(new RegExp(String.raw`\.then\s*\(\s*(?:async\s+)?(?:function\s*)?\(?\s*(${ID})`, 'g'))) tainted.add(m[1])
  }

  for (const m of src.matchAll(JS_SINK)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const args = balanced(src, open)
    const refs = new Set([...args.matchAll(new RegExp(ID, 'g'))].map((x) => x[0]))
    if ([...tainted].some((t) => refs.has(t)) || JS_BODY.test(args) || JS_NET_CALL.test(args)) {
      findings.push({ where, rule: 'JS response data passed to a log sink', text: `${m[0]}${args.slice(0, 80)})` })
    }
  }

  // A catch whose try made a network call: the error (its message can quote the body; a whole
  // error prints message, cause and stack) may reach a sink only as err.name / err.code / err.status,
  // or as err.message behind an `err instanceof <OwnError> ?` guard.
  for (const m of src.matchAll(/\btry\s*\{/g)) {
    const tryOpen = (m.index ?? 0) + m[0].length - 1
    const tryBody = balanced(src, tryOpen)
    if (!JS_NET_CALL.test(tryBody) && !JS_BODY.test(tryBody)) continue
    const after = src.slice(tryOpen + tryBody.length + 2)
    const c = after.match(new RegExp(String.raw`^\s*catch\s*\(\s*(${ID})\s*\)\s*\{`))
    if (!c) continue
    const err = c[1]
    const body = balanced(after, (c.index ?? 0) + c[0].length - 1)
    for (const s of body.matchAll(new RegExp(JS_SINK.source, 'g'))) {
      const args = balanced(body, (s.index ?? 0) + s[0].length - 1)
      const left = args
        .replace(new RegExp(String.raw`\b${err}\s+instanceof\s+\w+\s*\?\s*${err}\.message\b`, 'g'), '')
        .replace(new RegExp(String.raw`\b${err}\s+instanceof\s+\w+`, 'g'), '')
        .replace(new RegExp(String.raw`\(?\b${err}\)?\s*\??\.\s*(?:name|code|status|errno)\b`, 'g'), '')
      if (new RegExp(String.raw`\b${err}\b`).test(left)) {
        findings.push({ where, rule: 'JS network error detail printed (whole error, message, cause, stdout/stderr, stack)', text: `${s[0]}${args.slice(0, 80)})` })
      }
    }
  }
  return findings
}

export function analyzePs1(where: string, src: string): Finding[] {
  const findings: Finding[] = [...(/Set-PSDebug\s+-Trace\s+[12]/i.test(src) ? [{ where, rule: 'G1 xtrace (Set-PSDebug -Trace)', text: '' }] : [])]
  const NET = /\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i
  const tainted = new Set<string>()
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const a = line.match(/^\s*\$([A-Za-z_]\w*)\s*=\s*(.*)$/)
    if (a) {
      if (NET.test(a[2]) || [...tainted].some((t) => new RegExp(String.raw`\$${t}\b`, 'i').test(a[2]))) tainted.add(a[1].toLowerCase())
      continue
    }
    if (/\bWrite-(?:Host|Output|Error|Warning|Information|Verbose)\b/i.test(line)) {
      if (NET.test(line) || [...tainted].some((t) => new RegExp(String.raw`\$${t}\b`, 'i').test(line))) {
        findings.push({ where, rule: 'PS response data written to the log', text: line.trim() })
      }
    }
  }
  return findings
}

// ── workflow parsing and the scanned set ────────────────────────────────────────

export type RunBlock = { where: string; code: string }

export function runBlocks(file: string, yaml: string): { runs: RunBlock[]; shells: { where: string; value: string }[] } {
  const lines = yaml.split(/\r?\n/)
  const runs: RunBlock[] = []
  const shells: { where: string; value: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const sh = lines[i].match(/^\s*(?:-\s+)?shell:\s*(.+)$/)
    if (sh) shells.push({ where: `${file}:${i + 1}`, value: sh[1] })
    const m = lines[i].match(/^(\s*)(-\s+)?run:\s*(.*)$/)
    if (!m) continue
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0)
    const val = m[3].trim()
    if (/^[|>][-+]?\d*$/.test(val)) {
      const body: string[] = []
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() !== '' && l.match(/^\s*/)![0].length <= keyIndent) break
        body.push(l)
      }
      const ind = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length))
      runs.push({ where: `${file}:${i + 1}`, code: body.map((l) => l.slice(ind)).join('\n') })
      i = j - 1
    } else {
      runs.push({ where: `${file}:${i + 1}`, code: val.replace(/^(['"])([\s\S]*)\1$/, '$2') })
    }
  }
  return { runs, shells }
}

const SCRIPT_REF = /(?:^|[\s"'/=])((?:\.\/)?scripts\/[\w./-]+\.(?:sh|mjs|js|ts|ps1))\b/g

function repoPackageScripts(): Record<string, string> {
  const p = join(ROOT, 'package.json')
  if (!existsSync(p)) return {}
  return (JSON.parse(readFileSync(p, 'utf8')).scripts ?? {}) as Record<string, string>
}

/**
 * Analyse a workflow (or composite action). `npm run X` / `npm test` / `npm start` resolve
 * through package.json scripts: each resolved script body is analysed as shell and the
 * scripts/* files it calls join the scanned set.
 */
export function analyzeWorkflow(
  file: string,
  yaml: string,
  pkgScripts: Record<string, string> = repoPackageScripts(),
): { findings: Finding[]; scripts: string[]; npmScripts: string[] } {
  const { runs, shells } = runBlocks(file, yaml)
  const findings: Finding[] = []
  for (const s of shells) {
    if (/(?:^|\s)-[A-Za-z]*x[A-Za-z]*(?=\s|$)|xtrace/.test(s.value)) findings.push({ where: s.where, rule: 'G1 xtrace (shell: -x)', text: s.value })
  }
  const scripts = new Set<string>()
  const npmSeen = new Set<string>()
  const visit = (where: string, code: string) => {
    findings.push(...analyzeShell(where, code))
    for (const c of shellCommands(code)) {
      for (const m of c.matchAll(SCRIPT_REF)) scripts.add(m[1].replace(/^\.\//, ''))
      const npm = c.match(/^(?:[A-Za-z_]\w*=\S*\s+)*npm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|start)\b)/)
      const name = npm?.[1] ?? npm?.[2]
      if (name && !npmSeen.has(name) && pkgScripts[name] !== undefined) {
        npmSeen.add(name)
        visit(`${where} (npm run ${name})`, pkgScripts[name])
      }
    }
  }
  for (const r of runs) visit(r.where, r.code)
  return { findings, scripts: [...scripts], npmScripts: [...npmSeen] }
}

export function analyzeScript(rel: string, src: string): Finding[] {
  if (/\.sh$/.test(rel)) return analyzeShell(rel, src)
  if (/\.(?:mjs|js|ts)$/.test(rel)) return analyzeJs(rel, src)
  if (/\.ps1$/.test(rel)) return analyzePs1(rel, src)
  return []
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

export function repoScan(): { findings: Finding[]; workflows: string[]; scripts: string[]; npmScripts: string[] } {
  const wfDir = join(ROOT, '.github/workflows')
  const workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => `.github/workflows/${f}`)
  const actions = walk(join(ROOT, '.github/actions'))
    .filter((p) => /action\.ya?ml$/.test(p))
    .map((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  const findings: Finding[] = []
  const scripts = new Set<string>()
  const npm = new Set<string>()
  for (const f of [...workflows, ...actions]) {
    const r = analyzeWorkflow(f, readFileSync(join(ROOT, f), 'utf8'))
    findings.push(...r.findings)
    r.scripts.forEach((s) => scripts.add(s))
    r.npmScripts.forEach((s) => npm.add(s))
  }
  for (const s of scripts) {
    const p = join(ROOT, s)
    if (existsSync(p)) findings.push(...analyzeScript(s, readFileSync(p, 'utf8')))
  }
  return { findings, workflows: [...workflows, ...actions], scripts: [...scripts].sort(), npmScripts: [...npm].sort() }
}
