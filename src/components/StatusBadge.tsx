const COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
  terminated: 'bg-red-100 text-red-800',
  pending: 'bg-yellow-100 text-yellow-800',
  occupied: 'bg-blue-100 text-blue-800',
  vacant: 'bg-gray-100 text-gray-500',
  notice: 'bg-orange-100 text-orange-800',
  unavailable: 'bg-gray-200 text-gray-500',
  overdue: 'bg-red-100 text-red-800',
  urgent: 'bg-orange-100 text-orange-800',
  warning: 'bg-yellow-100 text-yellow-800',
  notice_urgency: 'bg-blue-50 text-blue-700',
  draft: 'bg-gray-100 text-gray-600',
  billed: 'bg-blue-100 text-blue-800',
  collected: 'bg-green-100 text-green-800',
  auto: 'bg-purple-100 text-purple-700',
  manual: 'bg-gray-100 text-gray-600',
  tracking: 'bg-gray-100 text-gray-600',
  proposal_sent: 'bg-blue-100 text-blue-700',
  negotiating: 'bg-yellow-100 text-yellow-800',
  executed: 'bg-green-100 text-green-800',
  declined: 'bg-red-100 text-red-800',
  expiring_soon: 'bg-orange-100 text-orange-800',
  missing: 'bg-red-200 text-red-900',
}

export function StatusBadge({ status }: { status: string }) {
  const cls = COLORS[status] ?? 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}
