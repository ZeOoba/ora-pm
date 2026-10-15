import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-256: one exported model constant per repo, so a model bump is a one-line change and the
// intake route, its model eval and any future caller cannot drift apart. Static check: no network.

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('ANTHROPIC_MODEL (single source of the default model id)', () => {
  it('is exported from server/lib/models.ts as a well-formed id', async () => {
    const m = await import('../../server/lib/models')
    expect(m.ANTHROPIC_MODEL).toMatch(/^claude-(opus|sonnet|haiku)-[0-9][a-z0-9-]*$/)
  })

  it('the intake route default comes from the constant, not a literal', () => {
    const src = codeOnly(read('server/routes/intake.ts'))
    expect(src).toMatch(/ANTHROPIC_MODEL/)
    expect(src).not.toMatch(/DEFAULT_MODEL\s*=\s*['"]claude-/)
  })

  it('the intake model eval default comes from the constant, not a literal', () => {
    const src = codeOnly(read('evals/lease-intake-model-eval/run-eval.ts'))
    expect(src).toMatch(/ANTHROPIC_MODEL/)
    expect(src).not.toMatch(/DEFAULT_MODELS\s*=\s*\[\s*['"]claude-opus/)
  })
})
