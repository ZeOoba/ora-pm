// tests/unit/workflow-log-egress.test.ts
//
// The repository is public, so every GitHub Actions log is public too. The ora-pm cron endpoints
// return raw database / Stripe error messages, lease ids and lease dates in their response bodies;
// monthly-billing-backup.yml used to echo that body into the log.
//
// The analyzer (tests/unit/log-egress-guard.ts) is an ALLOW-LIST taint check over every `run:`
// block in .github/workflows/*.yml and any composite action, every `shell:` key, every
// package.json script reached through `npm run X` / `npm test`, and every scripts/*.sh|.mjs|.js|
// .ts|.ps1 those call.
//
//   G1  no xtrace (set -x / set -o xtrace / bash -x / `shell: bash -x` / Set-PSDebug -Trace).
//   G2  a network command (curl, wget, gh api, $CURL_BIN, Invoke-WebRequest/RestMethod) must have
//       its output captured in `$(...)` or sent to a file or /dev/null; never `-o -`,
//       /dev/stdout|stderr, `tee`, `-O-`, curl -v/--trace, or a $GITHUB_* step file.
//   T   taint: a variable assigned from a curl/wget capture, anything derived from it, and any
//       file a curl writes (-o/--output/-O or a redirect, also when the capture keeps only -w) are
//       response data. A command touching response data (env prefixes like `X=1 cmd` are stripped
//       and their values count; unquoted heredoc bodies count) may only be an assignment, a silent
//       test (`[`/`[[`/`case`, `grep -q`, stdout AND stderr to /dev/null), a redirect to a plain
//       file with stderr silenced (the file becomes tainted), or a numeric extractor that untaints:
//       `tail -n1` over a curl `-w` capture only, `wc -l`, `jq -r '.f'` with a matching
//       `(.f|type)=="number"` check, or a final digits-only `grep -oE`. Anything else is a finding,
//       and so is any redirect of response data to $GITHUB_STEP_SUMMARY / OUTPUT / ENV / PATH.
//       `gh api` is G2-only: this repo's branch and PR metadata is already public.
//   JS  (.mjs/.js/.ts) fetch()/network-CLI results, res.text()/json() values, and copies of them
//       by plain assignment, member access or destructuring, and `.then(x => ...)` parameters on a
//       network chain, must not reach console.* (incl. dir/table/trace), process.std*.write, log()
//       or fail(). In a catch whose try makes a network call the error may be printed only as
//       err.name / .code / .status, or err.message behind an `err instanceof <OwnError> ?` guard;
//       a whole `err`, JSON.stringify(err), err.cause/.message/.stack/.stdout/.stderr are findings.
//   PS  an Invoke-RestMethod/WebRequest result must not reach Write-*.
//
// CLAIM: the analyzer catches every row of the enumerated mutation tables below, and the current
// tree has no finding. It is a static, line-oriented check, not a proof; it does not try to see
// through deliberate obfuscation. KNOWN LIMITS (not caught, by design of this round):
//   - code inside single-quoted strings that the shell later runs: `eval '...'`, `trap '...' EXIT`,
//     `bash -c '...'`;
//   - indirection: `declare -n` namerefs, `${!x}`, a curl reached through a variable (`$CURL`,
//     other than $CURL_BIN) or an absolute path (`/usr/bin/curl`);
//   - hand-off between steps: a file, $GITHUB_OUTPUT value or env var written silently in one step
//     and printed by a later step (each run block is analysed on its own; writing response data
//     to a $GITHUB_* file is itself a finding);
//   - PowerShell implicit output (a bare `$r` line), `| Out-Host`, `| ConvertTo-Json`, `throw`,
//     and pwsh `run:` blocks (analysed as bash, so -OutFile + Get-Content is not followed);
//   - JS taint does not flow through function calls (parseMigrationList(stdout) is a deliberate
//     transformation), and an uncaught rejection that Node prints is not modelled.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, analyzeJs, analyzePs1, analyzeShell, analyzeWorkflow, repoScan, runBlocks } from './log-egress-guard'

// ── tests ───────────────────────────────────────────────────────────────────────

describe('workflow log egress: the repo is clean', () => {
  const scan = repoScan()

  it('scans every workflow and every script they call', () => {
    expect(scan.workflows.length).toBeGreaterThanOrEqual(6)
    expect(scan.scripts).toEqual(expect.arrayContaining([
      'scripts/delinquency-backup.sh',
      'scripts/check-deploy-env.mjs',
      'scripts/check-migrations-applied.mjs',
      'scripts/branch-cleanup.mjs',
      'scripts/verify-gl-sql.sh', // reached through `npm run verify:gl-sql`
    ]))
    expect(scan.npmScripts).toEqual(expect.arrayContaining(['build', 'lint', 'test', 'typecheck', 'verify:gl-sql']))
  })

  it('no finding in any workflow, composite action or called script', () => {
    expect(scan.findings).toEqual([])
  })
})

// The live monthly-billing drain block is the baseline every shell mutation starts from.
const BILLING_WF = readFileSync(join(ROOT, '.github/workflows/monthly-billing-backup.yml'), 'utf8')
const BILLING = runBlocks('monthly-billing-backup.yml', BILLING_WF).runs[0].code
const AFTER_BODY = /^(\s*body=.*)$/m
const insertAfterBody = (line: string) => BILLING.replace(AFTER_BODY, `$1\n${line}`)

describe('workflow log egress: shell mutation table (every row must be caught)', () => {
  it('baseline billing block is clean', () => {
    expect(BILLING).toMatch(/curl/)
    expect(analyzeShell('baseline', BILLING)).toEqual([])
  })

  const renamed = BILLING.replace(/\bresp\b/g, 'res').replace(/\bbody\b/g, 'err')
  const MUTATIONS: [string, string][] = [
    ['set -x', `set -x\n${BILLING}`],
    ['set -euxo pipefail', BILLING.replace('set -uo pipefail', 'set -euxo pipefail')],
    ['set -o xtrace', `set -o xtrace\n${BILLING}`],
    ['bash -x on a nested script', `${BILLING}\nbash -x ./helper.sh`],
    ["printf '%s' \"$body\" | jq .", insertAfterBody(`printf '%s' "$body" | jq .`)],
    ['echo "$body" | head -c 500', insertAfterBody('echo "$body" | head -c 500')],
    ['| tee /dev/stderr into a silent jq', insertAfterBody(`printf '%s' "$body" | tee /dev/stderr | jq -e . >/dev/null 2>&1`)],
    ['jq . <<< "$body"', insertAfterBody('jq . <<< "$body"')],
    ['cat <<< "$body"', insertAfterBody('cat <<< "$body"')],
    ['renamed variables ($res, $err) echoed', renamed.replace(/^(\s*err=.*)$/m, '$1\necho "::error::$err"')],
    ['body on a continuation line', insertAfterBody('echo "::error::invocation $inv -> HTTP $code" \\\n  "$body"')],
    ['pipe into a non-parser (sed)', insertAfterBody(`printf '%s' "$body" | sed 's/x/y/'`)],
    ['body inside an echoed $(...)', insertAfterBody(`echo "::error::$(printf '%s' "$body" | head -c 200)"`)],
    ['jq string field with no numeric type check', insertAfterBody(`msg=$(printf '%s' "$body" | jq -r '.errorMessages')\necho "::error::$msg"`)],
    ['printf to stderr', insertAfterBody(`printf '%s\\n' "$body" >&2`)],
    ['alias of the body', insertAfterBody('copy="$body"\necho "$copy"')],
    ['body into a file, then cat', insertAfterBody(`printf '%s' "$body" > out.json 2>&1\ncat out.json`)],
    ['curl -o -', `${BILLING}\ncurl -sS -o - "$url"`],
    ['curl -o /dev/stdout', `${BILLING}\ncurl -sS -o /dev/stdout "$url"`],
    ['curl -v inside the capture', BILLING.replace('curl -sS', 'curl -sS -v')],
    ['curl --trace-ascii inside the capture', BILLING.replace('curl -sS', 'curl -sS --trace-ascii /dev/stderr')],
    ['curl uncaptured', `${BILLING}\ncurl -sS -X POST "$url"`],
    ['curl -o file, then cat it', `${BILLING}\ncurl -sS -o resp.json "$url"\ncat resp.json`],
    ['wget -qO-', `${BILLING}\nwget -qO- "$url"`],
    ['wget -O -', `${BILLING}\nwget -O - "$url"`],
    ['gh api uncaptured', `${BILLING}\ngh api repos/o/r/actions/secrets`],
    ['gh api | tee', `${BILLING}\ngh api repos/o/r > x.json | tee /dev/stderr`],
    // round-3 rows (a)-(f)
    ['(a) code=$(curl -o file -w code), then cat file', `${BILLING}\ncode=$(curl -sS -o out.json -w '%{http_code}' "$url")\ncat out.json`],
    ['(a) code=$(curl -o file -w code), then jq . file', `${BILLING}\ncode=$(curl -sS -o out.json -w '%{http_code}' "$url")\njq . out.json`],
    ['(a) code=$(curl --output file ...), then head file', `${BILLING}\ncode=$(curl -sS --output out.json -w '%{http_code}' "$url")\nhead -c 300 out.json`],
    ['(b) env prefix: X=1 echo "$body"', insertAfterBody('X=1 echo "$body"')],
    ['(b) env prefix: NO_COLOR=1 jq . <<< "$body"', insertAfterBody('NO_COLOR=1 jq . <<< "$body"')],
    ['(b) env prefix carrying the body: X="$body" printenv X', insertAfterBody('X="$body" printenv X')],
    ['(b) env prefix inside a pipeline: | LC_ALL=C sed', insertAfterBody(`printf '%s' "$body" | LC_ALL=C sed 's/a/b/'`)],
    ['(c) tail -n1 over the body is not a status code', insertAfterBody(`last=$(printf '%s' "$body" | tail -n1)\necho "::error::last line: $last"`)],
    ['(d) unquoted heredoc to stderr', insertAfterBody('cat >&2 <<MSG\n::error::response was $body\nMSG')],
    ['(d) unquoted heredoc with ${body}', insertAfterBody('cat <<-EOF\n\tresponse: ${body}\n\tEOF')],
    ['(f) body >> $GITHUB_STEP_SUMMARY 2>/dev/null', insertAfterBody('echo "$body" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null')],
    ['(f) body >> $GITHUB_OUTPUT', insertAfterBody('echo "b=$body" >> "$GITHUB_OUTPUT"')],
    ['(f) body >> $GITHUB_ENV 2>/dev/null', insertAfterBody('echo "X=$body" >> "$GITHUB_ENV" 2>/dev/null')],
    ['(f) curl straight into $GITHUB_STEP_SUMMARY', `${BILLING}\ncurl -sS "$url" >> "$GITHUB_STEP_SUMMARY"`],
  ]

  it('a quoted heredoc is literal text and is not flagged', () => {
    expect(analyzeShell('q', insertAfterBody(`cat <<'MSG'\nliteral $body\nMSG`))).toEqual([])
  })

  it.each(MUTATIONS)('%s', (_name, code) => {
    expect(code).not.toBe(BILLING)
    expect(analyzeShell('mutation', code).length).toBeGreaterThan(0)
  })
})

describe('workflow log egress: workflow-level mutations', () => {
  it('`shell: bash -x {0}` on a step', () => {
    const y = BILLING_WF.replace(/(\n\s+)run: \|/, '$1shell: bash -x {0}$1run: |')
    expect(y).not.toBe(BILLING_WF)
    expect(analyzeWorkflow('m.yml', y).findings.length).toBeGreaterThan(0)
  })

  it('`run: bash -x scripts/...`', () => {
    const y = 'jobs:\n  j:\n    steps:\n      - name: x\n        run: bash -x scripts/delinquency-backup.sh\n'
    const r = analyzeWorkflow('m.yml', y)
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.scripts).toEqual(['scripts/delinquency-backup.sh'])
  })

  it('(g) `run: npm run X` resolves through package.json and its scripts/*.ts is scanned', () => {
    const y = 'jobs:\n  j:\n    steps:\n      - run: npm run gate\n      - run: npm test\n'
    const pkg = { gate: 'tsx scripts/check-refute-required.ts && set -x', test: 'vitest run' }
    const r = analyzeWorkflow('m.yml', y, pkg)
    expect(r.npmScripts.sort()).toEqual(['gate', 'test'])
    expect(r.scripts).toEqual(['scripts/check-refute-required.ts'])
    expect(r.findings.map((f) => f.rule)).toEqual(['G1 xtrace (set -x / set -o xtrace)'])
  })

  it('(g) a resolved npm script that leaks a curl body is caught', () => {
    const y = 'jobs:\n  j:\n    steps:\n      - run: npm run ping\n'
    const pkg = { ping: 'r=$(curl -sS "$U") && echo "$r"' }
    expect(analyzeWorkflow('m.yml', y, pkg).findings.length).toBeGreaterThan(0)
  })

  it('a called script is scanned with the shell rules', () => {
    const src = readFileSync(join(ROOT, 'scripts/delinquency-backup.sh'), 'utf8')
    expect(analyzeShell('d', src)).toEqual([])
    expect(analyzeShell('d', src.replace(/^(body=.*)$/m, '$1\necho "$body"')).length).toBeGreaterThan(0)
    expect(analyzeShell('d', src.replace(/\| grep -oE '\^\[0-9\]\+ \[0-9\]\+\$'\)/, ')')).length).toBeGreaterThan(0)
  })
})

describe('workflow log egress: JS and PowerShell mutation table', () => {
  const deployEnv = readFileSync(join(ROOT, 'scripts/check-deploy-env.mjs'), 'utf8')
  const migrations = readFileSync(join(ROOT, 'scripts/check-migrations-applied.mjs'), 'utf8')

  it('baselines are clean', () => {
    expect(analyzeJs('deploy-env', deployEnv)).toEqual([])
    expect(analyzeJs('migrations', migrations)).toEqual([])
  })

  const JS: [string, string][] = [
    ['console.log(await res.text())', 'const res = await fetch(u)\nconsole.log(await res.text())'],
    ['body from res.text() to console.error', 'const res = await fetch(u)\nconst body = await res.text()\nconsole.error(`::error::${body}`)'],
    ['err.message after a fetch', 'try {\n  const r = await fetch(u)\n  await r.json()\n} catch (err) {\n  console.error(err.message)\n}'],
    ['the deploy-env catch unguarded', deployEnv.replace(/err instanceof CloudflareApiError \? err\.message : /, 'err.message || ')],
    ['supabase CLI stdout to stderr', "let stdout\nstdout = execFileSync('supabase', ['migration', 'list'])\nprocess.stderr.write(stdout)"],
    ['supabase CLI err.stderr', "try {\n  execFileSync('supabase', ['x'])\n} catch (e) {\n  fail(`failed: ${e.stderr}`)\n}"],
    // round-3 rows (e)
    ['(e) console.error(e) after a fetch', 'try {\n  const r = await fetch(u)\n  await r.json()\n} catch (e) {\n  console.error(e)\n}'],
    ['(e) JSON.stringify(e) after a fetch', 'try {\n  const r = await fetch(u)\n  await r.json()\n} catch (e) {\n  console.error(JSON.stringify(e))\n}'],
    ['(e) e.cause after a fetch', 'try {\n  const r = await fetch(u)\n  await r.json()\n} catch (e) {\n  console.error(e.cause)\n}'],
    ['(e) console.dir of the body', 'const res = await fetch(u)\nconst b = await res.json()\nconsole.dir(b)'],
    ['(e) console.table of the body', 'const res = await fetch(u)\nconst b = await res.json()\nconsole.table(b)'],
    ['(e) destructured from res.json()', 'const res = await fetch(u)\nconst { errors } = await res.json()\nconsole.error(errors)'],
    ['(e) copied by member access', 'const res = await fetch(u)\nconst data = await res.json()\nconst msg = data.errors[0].message\nconsole.error(msg)'],
    ['(e) copied by plain assignment', 'const res = await fetch(u)\nconst t = await res.text()\nlet copy = t\nlog(copy)'],
    ['(e) .then(x => console.log(x))', 'fetch(u).then(r => r.json()).then(j => console.log(j))'],
  ]
  it.each(JS)('%s', (_name, src) => {
    expect(analyzeJs('mutation', src).length).toBeGreaterThan(0)
  })

  const PS: [string, string][] = [
    ['Invoke-RestMethod result to Write-Host', '$r = Invoke-RestMethod -Uri $u -Method Post\nWrite-Host "result: $r"'],
    ['Invoke-WebRequest content to Write-Output', 'Write-Output (Invoke-WebRequest $u).Content'],
    ['Set-PSDebug -Trace 1', 'Set-PSDebug -Trace 1\n$x = 1'],
  ]
  it.each(PS)('%s', (_name, src) => {
    expect(analyzePs1('mutation', src).length).toBeGreaterThan(0)
  })
})
