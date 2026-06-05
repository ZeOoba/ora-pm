import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { loadStripe } from '@stripe/stripe-js'
import { portalApi } from '../lib/portal-api'
import { formatCurrency } from '../../lib/format'
import type { Charge } from '../lib/portal-api'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string)

export function PortalPayNow() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [step, setStep] = useState<'select' | 'processing' | 'done' | 'error'>('select')
  const [errorMsg, setErrorMsg] = useState('')
  const qc = useQueryClient()

  const { data: meData } = useQuery({ queryKey: ['portal-me'], queryFn: portalApi.getMe })
  const { data: chargesData, isLoading } = useQuery({ queryKey: ['portal-charges'], queryFn: portalApi.getCharges })

  const charges = (chargesData?.data ?? []) as Charge[]
  const openCharges = charges.filter(ch => ch.status === 'open')
  const selectedCharges = openCharges.filter(ch => selected.has(ch.id))
  const totalCents = Math.round(selectedCharges.reduce((s, ch) => s + ch.amount, 0) * 100)

  function toggleAll() {
    if (selected.size === openCharges.length) setSelected(new Set())
    else setSelected(new Set(openCharges.map(c => c.id)))
  }

  async function handlePay() {
    if (!meData?.tenant || totalCents < 50) return
    setStep('processing')
    setErrorMsg('')

    const tenant = meData.tenant

    if (!tenant.stripe_customer_id) {
      await fetch('/api/stripe/customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id }),
      })
    }

    const leaseId = selectedCharges[0]?.lease_id
    if (!leaseId) { setStep('error'); setErrorMsg('No lease found'); return }

    const stripe = await stripePromise
    if (!stripe) { setStep('error'); setErrorMsg('Stripe failed to load'); return }

    try {
      const { client_secret } = await portalApi.createSetupIntent(tenant.id)

      const { setupIntent, error: setupErr } = await stripe.collectBankAccountForSetup({
        clientSecret: client_secret,
        params: {
          payment_method_type: 'us_bank_account',
          payment_method_data: { billing_details: { name: tenant.name } },
        },
      })

      if (setupErr) throw new Error(setupErr.message)
      if (!setupIntent?.payment_method) throw new Error('No payment method returned')

      const { error: confirmErr } = await stripe.confirmUsBankAccountSetup(client_secret)
      if (confirmErr) throw new Error(confirmErr.message)

      const paymentMethodId = typeof setupIntent.payment_method === 'string'
        ? setupIntent.payment_method
        : setupIntent.payment_method.id

      const result = await portalApi.createPaymentIntent({
        tenant_id: tenant.id,
        lease_id: leaseId,
        amount_cents: totalCents,
        payment_method_id: paymentMethodId,
        description: `Rent payment — ${selectedCharges.length} charge(s)`,
      })

      if (!result.payment_intent_id) throw new Error('Payment intent creation failed')

      setStep('done')
      qc.invalidateQueries({ queryKey: ['portal-me'] })
      qc.invalidateQueries({ queryKey: ['portal-payments'] })
    } catch (err) {
      setStep('error')
      setErrorMsg((err as Error).message)
    }
  }

  if (isLoading) return <div className="p-6 text-gray-500">Loading charges…</div>

  if (step === 'done') return (
    <div className="p-6 max-w-lg">
      <div className="bg-green-50 border border-green-200 rounded-lg p-6">
        <h2 className="text-lg font-semibold text-green-800">Payment Initiated</h2>
        <p className="text-green-700 mt-2 text-sm">
          Your ACH payment of {formatCurrency(totalCents / 100)} has been submitted.
          ACH payments typically settle in 3–5 business days.
          You will see the payment as "processing" in your payment history.
        </p>
        <a href="/portal" className="mt-4 inline-block text-blue-600 text-sm hover:underline">← Back to dashboard</a>
      </div>
    </div>
  )

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-2xl font-serif" style={{ color: '#1B2A4A' }}>Pay Now</h1>

      {step === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded p-4 text-red-700 text-sm">{errorMsg}</div>
      )}

      {openCharges.length === 0 ? (
        <div className="text-gray-500 text-sm">No open charges — you're all caught up!</div>
      ) : (
        <>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex justify-between items-center">
              <span className="text-sm font-medium text-gray-700">Open Charges</span>
              <button onClick={toggleAll} className="text-xs text-blue-600 hover:underline">
                {selected.size === openCharges.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            {openCharges.map(ch => (
              <label key={ch.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50 cursor-pointer last:border-0">
                <input
                  type="checkbox"
                  checked={selected.has(ch.id)}
                  onChange={() => {
                    const next = new Set(selected)
                    next.has(ch.id) ? next.delete(ch.id) : next.add(ch.id)
                    setSelected(next)
                  }}
                  className="rounded"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">
                    {ch.description ?? ch.charge_type.replace(/_/g, ' ')}
                  </p>
                  <p className="text-xs text-gray-500">Due {ch.due_date}</p>
                </div>
                <span className="text-sm font-semibold text-gray-900">{formatCurrency(ch.amount)}</span>
              </label>
            ))}
          </div>

          {selected.size > 0 && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-sm font-medium text-gray-700">
                Total: {formatCurrency(totalCents / 100)}
              </span>
              <button
                onClick={handlePay}
                disabled={step === 'processing'}
                className="bg-[#1B2A4A] text-white rounded px-6 py-2.5 text-sm font-medium hover:bg-[#243660] disabled:opacity-50"
              >
                {step === 'processing' ? 'Processing…' : `Pay ${formatCurrency(totalCents / 100)} via ACH`}
              </button>
            </div>
          )}
        </>
      )}

      <p className="text-xs text-gray-400">
        ACH payments are processed via Stripe. Funds are debited from your bank account within 3–5 business days.
      </p>
    </div>
  )
}
