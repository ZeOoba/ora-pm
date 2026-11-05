import { describe, it, expect } from 'vitest'
import { Linter } from 'eslint'
import tseslint from 'typescript-eslint'
import { PALETTE_RESTRICTED_SYNTAX } from '../../eslint.palette.js'

// Runs the real selector list (shared with eslint.config.js) against snippets, so the
// "no raw gray/blue/green/red palette or arbitrary-hex color classes in src/" rule cannot silently stop working.
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
    ['text-red', `const a = <p className="text-sm text-red-600" />`],
    ['bg-red with variant', `const a = <p className="hover:bg-red-50" />`],
    ['border-red', `const a = <p className="border border-red-200" />`],
    ['text-green', `const a = <p className="text-green-700" />`],
    ['bg-green', `const a = <p className="bg-green-600 text-white" />`],
    ['border-green', `const a = <p className="border-green-200" />`],
    ['divide-red', `const a = <p className="divide-red-200" />`],
    ['ring-green', `const a = <p className="ring-green-500" />`],
    ['border-t-gray', `const a = <p className="border-t-gray-200" />`],
    ['border-b-gray with variant', `const a = <p className="md:border-b-gray-300" />`],
    ['border-l-red', `const a = <p className="border-l-red-500" />`],
    ['ring-blue', `const a = <input className="focus:ring-blue-500" />`],
    ['arbitrary hex bg', `const a = <button className="text-sm bg-[#1B2A4A] text-white" />`],
    ['arbitrary hex hover bg', `const a = <button className="hover:bg-[#243660]" />`],
    ['arbitrary hex text', `const a = <p className="text-[#C9A96E]" />`],
    ['arbitrary hex border', `const a = <p className="border-[#e5e7eb]" />`],
    ['arbitrary hex ring', `const a = <p className="focus:ring-[#1B2A4A]" />`],
    ['arbitrary hex fill', `const a = <path className="fill-[#15803D]" />`],
    ['arbitrary hex stroke', `const a = <path className="stroke-[#475569]" />`],
    ['arbitrary hex in cn()', `const a = cn('p-2', on && 'bg-[#F5F3EF]')`],
  ])('flags %s', (_name, code) => {
    const msgs = lint(code)
    expect(msgs.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it.each([
    ['token classes', `const a = <div className="bg-muted text-muted-foreground border-border" />`],
    ['brand classes', `const a = <div className="bg-primary text-primary-foreground text-status-danger" />`],
    ['unrelated words', `const a = 'text-grayscale bluetooth'`],
    ['template literal with tokens', 'const a = <div className={`p-2 ${x} bg-muted`} />'],
    ['status tokens', `const a = <p className="text-status-danger bg-status-active/10 border-status-danger/30" />`],
    ['side border tokens', `const a = <p className="border-t border-b-border border-l-primary" />`],
    ['unrelated words 2', `const a = 'text-redacted bg-greenhouse'`],
    ['bg-white', `const a = <div className="bg-white border-border" />`],
    ['arbitrary non-color values', `const a = <div className="w-[320px] grid-cols-[1fr_auto] text-[13px]" />`],
    ['hex outside a class', `const fill = '#1B2A4A'`],
  ])('allows %s', (_name, code) => {
    expect(lint(code)).toEqual([])
  })
})
