import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// OI-037: no public/_headers existed before this change, so Cloudflare Pages served
// zero security headers on any route (confirmed live via curl -I against
// https://ora-pm.pages.dev/api/health — no CSP, no X-Frame-Options, no HSTS, no
// X-Content-Type-Options). `public/` is Vite's default `publicDir` (unset in
// vite.config.ts => default) and is copied verbatim to `dist/` on build, which is
// wrangler.toml's `pages_build_output_dir` — so `public/_headers` becomes
// `dist/_headers`, the location Cloudflare Pages reads for custom headers.
//
// This is the testable layer available in CI: reading the file as plain text.
// Live enforcement (does Cloudflare Pages actually apply these headers, does the
// CSP break the real Stripe/Supabase flow in a browser) is a platform behavior
// verified by a manual `curl` against the deployed preview + a manual click-through
// of the Pay Now flow — not by this test. See task-5-report.md for that checklist.
describe('public/_headers — transport hardening (OI-037)', () => {
  const headers = readFileSync(join(__dirname, '../../public/_headers'), 'utf-8')

  it('applies to all routes via a /* block', () => {
    expect(headers).toMatch(/^\/\*\s*$/m)
  })

  it('sets X-Frame-Options: DENY (clickjacking defense for the Pay Now page)', () => {
    expect(headers).toMatch(/^\s*X-Frame-Options:\s*DENY\s*$/m)
  })

  it('sets a Content-Security-Policy (Report-Only for this PR — see report for why)', () => {
    // Shipped as Report-Only rather than enforcing: this task cannot open a real
    // browser to click through the live Pay Now flow against Stripe/Supabase, so an
    // enforcing CSP risks silently breaking a real payment flow. Report-Only ships
    // the same policy, reports violations, and is flipped to enforcing after a
    // manual browser verification pass (follow-up noted in task-5-report.md).
    const cspLine = headers
      .split('\n')
      .find((line) => /^\s*Content-Security-Policy-Report-Only:/.test(line))
    expect(cspLine).toBeDefined()
    const csp = cspLine as string
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' https://js.stripe.com")
    expect(csp).toContain("connect-src 'self' https://api.stripe.com https://*.supabase.co")
    expect(csp).toContain("frame-src https://js.stripe.com")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("form-action 'self'")
  })

  it('does not also ship an enforcing Content-Security-Policy header', () => {
    // Only one of the two should be present — shipping both would enforce anyway.
    expect(headers).not.toMatch(/^\s*Content-Security-Policy:/m)
  })

  it('sets X-Content-Type-Options: nosniff', () => {
    expect(headers).toMatch(/^\s*X-Content-Type-Options:\s*nosniff\s*$/m)
  })

  it('sets Referrer-Policy: strict-origin-when-cross-origin', () => {
    expect(headers).toMatch(/^\s*Referrer-Policy:\s*strict-origin-when-cross-origin\s*$/m)
  })

  it('sets Strict-Transport-Security with a 1-year max-age and includeSubDomains', () => {
    expect(headers).toMatch(/^\s*Strict-Transport-Security:\s*max-age=31536000;\s*includeSubDomains\s*$/m)
  })

  it('sets a restrictive Permissions-Policy (camera/microphone/geolocation denied)', () => {
    expect(headers).toMatch(
      /^\s*Permissions-Policy:\s*camera=\(\),\s*microphone=\(\),\s*geolocation=\(\)\s*$/m
    )
  })
})
