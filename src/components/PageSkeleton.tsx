import { Skeleton } from '@/components/ui/skeleton'

/** Suspense fallback for lazily loaded route pages (rendered inside AppShell). */
export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading page" className="space-y-4 p-1">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  )
}
