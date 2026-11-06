import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { loadStripe } from '@stripe/stripe-js'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Charge } from '../lib/portal-api'
import { chargesGate, singleLeaseId } from '../lib/charges'
import { runPayAttempt } from '../lib/pay-attempt'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Skeleton } from '../../components/ui/skeleton'
import { QueryState, StaleDataWarning } from '../../components/QueryState'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string)

export function PortalPayNow() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<'select' | 'processing' | 'done' | 'error'>('select')
  const [errorMsg, setErrorMsg] = useState('')
  const qc = useQueryClient()

  // client_request_id: one per pay attempt (OI-035). Generated lazily on the
  // first Pay click for a given selection and reused verbatim across retries
  // (e.g. clicking Pay again after a network error) so the server's
  // idempotency key stays stable. Cleared whenever the selection changes —
  // a different set of charges is a genuinely different attempt, and reusing
  // the key across a changed amount would make Stripe reject the retry as an
  // idempotency-key/parameter mismatch — and after a successful payment, so
  // the next payment gets its own fresh id.
  //
  // paymentMethodIdRef (OI-064) is the same one-per-attempt unit as
  // clientRequestIdRef, not a separate lifecycle: reusing the client_request_id
  // on a retry only keeps Stripe's idempotency key stable if the PARAMS also
  // match, and payment_method_id is one of those params. Always reset (and
  // read) both refs together — see runPayAttempt in ../lib/pay-attempt.ts.
  const paymentMethodIdRef = useRef<string | null>(null)
  const clientRequestIdRef = useRef<string | null>(null)
  useEffect(() => {
    paymentMethodIdRef.current = null
    clientRequestIdRef.current = null
  }, [selected])

  const meQuery = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const { data: meData } = meQuery
  const chargesQuery = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })
  const { data: chargesData } = chargesQuery

  const charges = (chargesData?.data ?? []) as Charge[]
  // `charges` has no per-row paid/open column and `payments` isn't linked to a specific charge
  // (schema gap — see 2026-07-16 audit finding #7), so every charge the API returns for an
  // active lease is treated as payable, per Gabriel's 2026-07-18 ruling.
  const openCharges = charges
  const selectedCharges = openCharges.filter(ch => selected.has(ch.id))
  const totalCents = Math.round(selectedCharges.reduce((s, ch) => s + ch.amount, 0) * 100)
  const selectedLeaseId = singleLeaseId(selectedCharges)
  const spansMultipleLeases = selectedCharges.length > 0 && selectedLeaseId === null

  function toggleAll() {
    if (selected.size === openCharges.length) setSelected(new Set())
    else setSelected(new Set(openCharges.map(c => c.id)))
  }

  async function handlePay() {
    if (!meData?.tenant || totalCents < 50) return
    if (spansMultipleLeases) {
      setStep('error')
      setErrorMsg('Selected charges span more than one lease — pay each lease separately.')
      return
    }
    setStep('processing')
    setErrorMsg('')

    const tenant = meData.tenant

    if (!tenant.stripe_customer_id) {
      await portalApi.ensureStripeCustomer(
        tenant.id,
        tenant.contact_email ?? undefined,
        tenant.name
      )
    }

    const leaseId = selectedLeaseId
    if (!leaseId) { setStep('error'); setErrorMsg('No lease found'); return }

    const stripe = await stripePromise
    if (!stripe) { setStep('error'); setErrorMsg('Stripe failed to load'); return }

    try {
      if (!clientRequestIdRef.current) clientRequestIdRef.current = crypto.randomUUID()

      const result = await runPayAttempt(
        { stripe, api: portalApi },
        {
          tenant,
          leaseId,
          amountCents: totalCents,
          description: `Rent payment — ${selectedCharges.length} charge(s)`,
          clientRequestId: clientRequestIdRef.current,
        },
        paymentMethodIdRef
      )

      if (!result.payment_intent_id) throw new Error('Payment intent creation failed')

      paymentMethodIdRef.current = null
      clientRequestIdRef.current = null // this attempt is done — the next payment gets a fresh id
      setStep('done')
      qc.invalidateQueries({ queryKey: ['portal-me'] })
      qc.invalidateQueries({ queryKey: ['portal-payments'] })
    } catch (err) {
      setStep('error')
      setErrorMsg((err as Error).message)
    }
  }

  // A failed first load must not fall through to "no open charges - you are all caught up". Only the
  // select step is ever replaced (see chargesGate): the processing/done/error screens are never hidden
  // by the charges query state, and a failed background refetch with data kept does not block.
  if (chargesGate(step, { isError: chargesQuery.isError, data: chargesData }) === 'blocking') {
    return (
      <div className="p-6 max-w-2xl space-y-6">
        <h1 className="font-display text-2xl text-navy">Pay Now</h1>
        <QueryState
          query={chargesQuery}
          skeleton={(
            <div className="space-y-3" aria-busy="true" aria-label="Loading charges">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-2/3" />
            </div>
          )}
        >
          {null}
        </QueryState>
      </div>
    )
  }

  if (step === 'done') return (
    <div className="p-6 max-w-lg">
      <div className="bg-status-active/5 border border-status-active/30 rounded-lg p-6">
        <h2 className="font-display text-lg font-semibold text-status-active">Payment Initiated</h2>
        <p className="text-status-active mt-2 text-sm">
          Your ACH payment of {formatCurrency(totalCents / 100)} has been submitted.
          ACH payments typically settle in 3–5 business days.
          You will see the payment as "processing" in your payment history.
        </p>
        <a href="/portal" className="mt-4 inline-block text-navy text-sm underline-offset-2 hover:underline">← Back to dashboard</a>
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="font-display text-2xl text-navy">Pay Now</h1>

      <StaleDataWarning query={chargesQuery} />

      {/* portal-me status only: makes a pending/failed profile read visible. Pay button logic is untouched. */}
      <QueryState query={meQuery} skeleton={<p className="text-xs text-status-neutral" aria-busy="true">Loading your account…</p>}>{null}</QueryState>

      {step === 'error' && (
        <div role="alert" className="bg-status-danger/5 border border-status-danger/30 rounded p-4 text-status-danger text-sm">{errorMsg}</div>
      )}

      {openCharges.length === 0 ? (
        <div className="text-status-neutral text-sm">No open charges — you're all caught up!</div>
      ) : (
        <>
          <Card className="overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex justify-between items-center">
              <span className="text-sm font-medium text-navy">Open Charges</span>
              <button onClick={toggleAll} className="text-xs text-navy underline-offset-2 hover:underline">
                {selected.size === openCharges.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            {openCharges.map(ch => (
              <label key={ch.id} className="flex items-center gap-3 px-4 py-3 border-b border-border/50 hover:bg-parchment/50 cursor-pointer last:border-0">
                <input
                  type="checkbox"
                  checked={selected.has(ch.id)}
                  onChange={() => {
                    const next = new Set(selected)
                    if (next.has(ch.id)) {
                      next.delete(ch.id)
                    } else {
                      next.add(ch.id)
                    }
                    setSelected(next)
                  }}
                  className="rounded"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-navy">
                    {ch.description ?? ch.type.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-status-neutral">Due {ch.due_date}</p>
                </div>
                <span className="text-sm font-semibold text-navy">{formatCurrency(ch.amount)}</span>
              </label>
            ))}
          </Card>

          {selected.size > 0 && (
            <div className="pt-2 space-y-2">
              {spansMultipleLeases && (
                <p role="alert" className="text-sm text-status-danger">
                  Selected charges span more than one lease — pay each lease separately.
                </p>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-navy">
                  Total: {formatCurrency(totalCents / 100)}
                </span>
                <Button
                  onClick={handlePay}
                  disabled={step === 'processing' || spansMultipleLeases}
                  className="px-6 py-2.5"
                >
                  {step === 'processing' ? 'Processing…' : `Pay ${formatCurrency(totalCents / 100)} via ACH`}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-xs text-status-neutral">
        ACH payments are processed via Stripe. Funds are debited from your bank account within 3–5 business days.
      </p>
    </div>
  )
}
