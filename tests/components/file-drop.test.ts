import { describe, it, expect } from 'vitest'
import { validateFile } from '../../src/components/ui/file-drop'

const f = (name: string, type: string, size: number) => ({ name, type, size }) as File

describe('validateFile', () => {
  const opts = { accept: ['application/pdf'], maxBytes: 10 * 1024 * 1024 }
  it('accepts a small pdf', () => {
    expect(validateFile(f('a.pdf', 'application/pdf', 1000), opts)).toEqual({ ok: true })
  })
  it('rejects a non-pdf', () => {
    const r = validateFile(f('a.png', 'image/png', 1000), opts)
    expect(r.ok).toBe(false)
  })
  it('rejects an oversize file', () => {
    const r = validateFile(f('a.pdf', 'application/pdf', 20 * 1024 * 1024), opts)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/too large/i)
  })
})
