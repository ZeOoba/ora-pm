export function EmptyState({
  title,
  message,
  action,
}: {
  title: string
  message?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gold/15 text-gold font-display text-xl">
        O
      </div>
      <p className="mt-4 text-base font-display text-navy">{title}</p>
      {message && <p className="mt-1 text-sm text-status-neutral">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
