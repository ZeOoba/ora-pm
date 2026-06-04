import { describe, it, expect } from 'vitest'
import { createApp } from '../../server/index'

describe('GET /api/health', () => {
  it('returns 200 with ok status', async () => {
    const app = createApp()
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string }
    expect(body.status).toBe('ok')
  })
})
