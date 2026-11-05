import { describe, it, expect } from 'vitest'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { PALETTE_RESTRICTED_SYNTAX } from '../../eslint.palette.js'

// Runs the real selector list (shared with eslint.config.js) against snippets, so the
// "no raw gray/blue palette classes in src/" rule cannot silently stop working.
const linter = new Linter()
function lint(code: string) {
  return linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { 'no-restricted-syntax': ['error', ...PALETTE_RESTRICTED_SYNTAX] },
      },
    ],
    { filename: 'src/x.tsx' },
  )
}

describe('palette lint rule', () => {
  it.each([
    ['className string literal', `const a = <div className="bg-gray-100" />`],
    ['text-gray', `const a = <p className="text-gray-500 text-sm" />`],
    ['border-gray with variant', `const a = <p className="p-2 hover:border-gray-300" />`],
    ['bg-blue', `const a = <p className="bg-blue-600" />`],
    ['text-blue', `const a = <a className="text-blue-600 hover:underline" />`],
    ['template literal', 'const a = <div className={`p-2 ${x ? "a" : "b"} bg-gray-50`} />'],
    ['template literal head', 'const a = <div className={`bg-blue-50 ${x}`} />'],
    ['cn() string arg', `const a = cn('p-2', cond && 'text-gray-400')`],
    ['clsx() string arg', `const a = clsx('border-gray-200')`],
    ['ternary in expression container', `const a = <div className={x ? 'bg-gray-100' : 'bg-white'} />`],
    ['object map value', `const m = { notice: 'border-gray-200 bg-white' }`],
    ['divide-gray', `const a = <table className="divide-y divide-gray-200" />`],
    ['ring-blue', `const a = <input className="focus:ring-blue-500" />`],
  ])('flags %s', (_name, code) => {
    const msgs = lint(code)
    expect(msgs.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it.each([
    ['token classes', `const a = <div className="bg-muted text-muted-foreground border-border" />`],
    ['brand classes', `const a = <div className="bg-primary text-primary-foreground text-status-danger" />`],
    ['unrelated words', `const a = 'text-grayscale bluetooth'`],
    ['template literal with tokens', 'const a = <div className={`p-2 ${x} bg-muted`} />'],
    ['bg-white', `const a = <div className="bg-white border-border" />`],
  ])('allows %s', (_name, code) => {
    expect(lint(code)).toEqual([])
  })
})
