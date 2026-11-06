import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Phase 1 / Task 6: blocking browser dialogs are replaced by ConfirmDialog + sonner toasts.
// `alert(`, `confirm(` and `window.confirm` / `window.alert` must not come back anywhere in src/.
const SRC = join(__dirname, '../../src')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(name) ? [p] : []
  })
}
// Case-sensitive and word-bounded: `onConfirm(` / `handleConfirm(` / `ConfirmDialog` do not match.
const BANNED = /(?:\bwindow\s*\.\s*(?:alert|confirm)\b)|(?:\b(?:alert|confirm)\s*\()/

describe('no alert()/confirm() in src/', () => {
  it('finds zero occurrences', () => {
    const hits: string[] = []
    for (const file of walk(SRC)) {
      readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
        if (BANNED.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('the pattern itself catches the banned forms and spares the replacements', () => {
    for (const bad of ['if (!confirm("x")) return', 'alert(msg)', 'window.confirm("x")', 'window.alert', 'confirm ("x")']) {
      expect(BANNED.test(bad), bad).toBe(true)
    }
    for (const ok of ['onConfirm()', 'handleConfirm(row)', '<ConfirmDialog open />', 'confirmLabel="Delete"', 'setConfirming(true)']) {
      expect(BANNED.test(ok), ok).toBe(false)
    }
  })
})
