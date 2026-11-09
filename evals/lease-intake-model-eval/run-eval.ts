// evals/lease-intake-model-eval/run-eval.ts — opus-5 vs sonnet-5 lease-intake accuracy
// comparison, requested before any change to INTAKE_MODEL's default (currently
// claude-opus-5 on every lease-PDF upload). Calls the REAL production extraction path
// (server/lib/lease-extract.ts's extractLease(), unmodified) against synthetic,
// entirely-fictional lease fixtures with known ground truth, for both candidate models,
// and reports per-field accuracy + hallucination rate for each.
//
// This does NOT change INTAKE_MODEL's default -- that decision is Gabriel's, informed by
// this eval's output. Requires a real ANTHROPIC_API_KEY (this incurs actual API cost --
// FIXTURES.length * 2 models small structured-extraction calls, max_tokens=1024 each).
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... npx tsx evals/lease-intake-model-eval/run-eval.ts
//   ANTHROPIC_API_KEY=sk-... npx tsx evals/lease-intake-model-eval/run-eval.ts --models=claude-opus-5,claude-sonnet-5
import { extractLease } from '../../server/lib/lease-extract'
import { ANTHROPIC_MODEL } from '../../server/lib/models'
import { buildSimplePdf } from './build-pdf'
import { inspectPdf } from '../../server/lib/pdf-extract'
import { FIXTURES } from './fixtures'
import { scoreExtraction, summarizeModel, type ModelSummary } from './score'

const DEFAULT_MODELS = [ANTHROPIC_MODEL, 'claude-sonnet-5']

function parseModelsArg(argv: string[]): string[] {
  const arg = argv.find(a => a.startsWith('--models='))
  if (!arg) return DEFAULT_MODELS
  return arg.slice('--models='.length).split(',').map(s => s.trim()).filter(Boolean)
}

async function runModel(model: string, apiKey: string): Promise<ModelSummary> {
  const fixtureScores = []
  for (const fixture of FIXTURES) {
    // Same path as production intake (REFUTE C1b round 2): scan the PDF, send only its page text.
    const inspection = await inspectPdf(new Uint8Array(buildSimplePdf(fixture.lines)))
    if (!inspection) throw new Error(`fixture ${fixture.id}: PDF could not be inspected`)
    const result = await extractLease(inspection.pages, { apiKey, model })
    fixtureScores.push(scoreExtraction(fixture, result.fields))
  }
  return summarizeModel(model, fixtureScores)
}

function printSummary(summaries: ModelSummary[]): void {
  console.log('── Lease-intake model accuracy eval ─────────────────────────────────')
  console.log(`${FIXTURES.length} fixture(s), ${summaries.length} model(s) compared\n`)

  for (const s of summaries) {
    console.log(`${s.model}`)
    console.log(
      `  overall: ${(s.overallAccuracy * 100).toFixed(1)}% ` +
        `(${s.totalCorrect} correct / ${s.totalWrong} wrong / ${s.totalMissed} missed) ` +
        `· ${s.totalHallucinated} hallucinated field(s)`,
    )
    for (const fs of s.fixtureScores) {
      const flagged = fs.outcomes.filter(o => o.kind !== 'correct' && o.kind !== 'notes-present')
      const flag = flagged.length
        ? flagged.map(o => `${o.field}:${o.kind}`).join(', ')
        : 'all correct'
      console.log(`    ${fs.fixtureId.padEnd(28)} ${(fs.accuracy * 100).toFixed(0)}%  ${flag}`)
    }
    console.log()
  }

  if (summaries.length === 2) {
    const [a, b] = summaries
    const delta = (a.overallAccuracy - b.overallAccuracy) * 100
    console.log(
      `Δ overall accuracy (${a.model} − ${b.model}): ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} points`,
    )
    console.log(
      `Δ hallucinated fields (${a.model} − ${b.model}): ${a.totalHallucinated - b.totalHallucinated >= 0 ? '+' : ''}` +
        `${a.totalHallucinated - b.totalHallucinated}`,
    )
  }
  console.log('───────────────────────────────────────────────────────────────────────')
  console.log('This eval does not change INTAKE_MODEL -- that is a deliberate, separate decision.')
}

async function main() {
  const apiKey = process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    console.error(
      'USAGE ERROR: ANTHROPIC_API_KEY is not set. This eval calls the real Anthropic API ' +
        '(small cost: fixtures × models structured-extraction calls) and cannot run without it.',
    )
    process.exit(2)
  }

  const models = parseModelsArg(process.argv.slice(2))
  const summaries: ModelSummary[] = []
  for (const model of models) {
    console.log(`Running ${FIXTURES.length} fixture(s) against ${model}...`)
    summaries.push(await runModel(model, apiKey))
  }
  printSummary(summaries)
}

main().catch(err => {
  console.error('✗ Eval error:', err)
  process.exit(1)
})
