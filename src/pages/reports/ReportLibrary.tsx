import { Link } from 'react-router'
import { PageHeader } from '../../components/PageHeader'

// AppFolio-style report library: one row per report, name + what you'll find inside.
const REPORTS: { to: string; name: string; description: string }[] = [
  {
    to: '/reports/cash-flow',
    name: 'Cash Flow',
    description: 'Cash received from tenants by payment method and cash paid out by expense category for a period, with fiscal-year-to-date alongside. Pending ACH is excluded until it settles.',
  },
  {
    to: '/reports/income-statement',
    name: 'Income Statement',
    description: "Review a property's income, operating expense, net operating income and capital spend for a period, with fiscal-year-to-date and each line's share of total income.",
  },
  {
    to: '/reports/income-statement-12-month',
    name: 'Income Statement - 12 Month',
    description: 'Month-over-month income, operating expense and NOI for the trailing twelve months, with a twelve-month total.',
  },
  {
    to: '/ar',
    name: 'Delinquency',
    description: "Locate tenants with outstanding balances as of today's date, aged current / 1–30 / 31–60 / 61–90 / 90+ days.",
  },
  {
    to: '/rent-roll',
    name: 'Rent Roll',
    description: "A snapshot of each property's expected revenue from leases in effect: suite, SF, tenant, lease end, base rent, CAM and rent per SF.",
  },
  {
    to: '/budgets',
    name: 'Budget vs. Actual',
    description: 'Compare each property’s annual budget to actual billed income and recorded expense by category.',
  },
  {
    to: '/critical-dates',
    name: 'Critical Dates',
    description: 'Lease expirations and insurance-certificate expiries coming due in the next 90 days, flagged by urgency.',
  },
  {
    to: '/exports',
    name: 'QuickBooks Export',
    description: 'Export charges and payments as a QuickBooks Desktop IIF file for a period.',
  },
]

export function ReportLibrary() {
  return (
    <div>
      <PageHeader title="Reports" />
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {REPORTS.map((r) => (
          <li key={r.to} className="grid gap-1 px-6 py-5 md:grid-cols-[16rem_1fr] md:gap-8">
            <Link to={r.to} className="font-medium text-primary hover:underline">{r.name}</Link>
            <p className="text-sm text-foreground">{r.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
