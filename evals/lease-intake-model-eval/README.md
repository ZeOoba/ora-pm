# Lease-intake model accuracy eval

Compares `claude-opus-5` (ora-pm's current `INTAKE_MODEL` default) against
`claude-sonnet-5` on the exact production lease-PDF extraction path
(`server/lib/lease-extract.ts`'s `extractLease()`, unmodified — this eval calls the
real function, not a reimplementation), so a change to `INTAKE_MODEL` can be made on
evidence rather than a guess.

**This does not change `INTAKE_MODEL`.** That is a separate, deliberate decision for
Gabriel once this eval's output exists.

## Why this exists

Every lease-PDF upload calls the Anthropic API at `INTAKE_MODEL` (default
`claude-opus-5`) to extract 8 structured fields (dates, rent, deposit, TI allowance,
expense stop, rent type, notes). Opus-5 is the expensive tier for what is fundamentally
structured extraction — worth checking whether sonnet-5 holds the same accuracy before
touching a default that feeds live lease/financial records.

## What it does NOT use

No real lease PDFs, tenant names, addresses, or dollar figures. `fixtures.ts` is 4
entirely fictional synthetic lease documents (fake company names, round-number rents,
made-up addresses) with hand-verified ground truth for each of the 8 extractable fields.
`build-pdf.ts` renders each fixture's text into a real, spec-valid single-page PDF (hand-
built — no PDF library exists anywhere in ora-pm's dependency tree, and adding one purely
for eval fixtures would be a heavier change than a correct minimal PDF warrants). Manually
round-tripped through `pdftotext` (poppler) during development and confirmed to extract
the exact input text with zero parse errors before trusting it in the harness.

## Running it

Requires a real `ANTHROPIC_API_KEY` — **this incurs actual API cost** (4 fixtures × 2
models = 8 small structured-extraction calls, `max_tokens: 1024` each; a few cents at
most, but it is a real charge, not a dry run).

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run eval:lease-intake-model
```

Or against a different model pair:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx evals/lease-intake-model-eval/run-eval.ts --models=claude-opus-5,claude-haiku-4-5-20251001
```

Output: per-model overall accuracy, per-fixture breakdown (which fields were correct /
wrong / missed / hallucinated), and — when exactly two models are compared — the
head-to-head accuracy and hallucination-count delta.

## Scoring (`score.ts`)

- **Numeric fields** (rent, deposit, TI, expense stop, CAM): correct within ±1% or ±$1,
  whichever is larger.
- **Exact-match fields** (dates, rent type): must match the ISO-normalized ground truth
  string exactly.
- **`notes`**: presence-only signal (did the model populate it when the fixture has a
  clause worth noting) — free text, not compared for exact content.
- **Hallucination tracking**: a field the model fills in that the fixture's ground truth
  never had (because the source document never stated it) is flagged separately from
  "wrong" — this is the failure mode that matters most for financial-record intake, and a
  plain accuracy percentage alone would hide it.

## Status as of this build (2026-07-26)

Built and unit-tested (16 tests: `score.test.ts` pure-scorer cases, `build-pdf.test.ts`
structural PDF validity). **Not yet run live** — no `ANTHROPIC_API_KEY` was available in
the session that built this harness, so no actual opus-5-vs-sonnet-5 comparison numbers
exist yet. Run the command above once a key is available; do not treat this README as
having reported real results, because it hasn't.
