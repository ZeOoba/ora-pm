import { Button } from '@/components/ui/Button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { pageCount, pageSizeOptions, rangeLabel } from './table-state'

export function DataTablePager({
  pageIndex,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  hideRange = false,
}: {
  pageIndex: number
  pageSize: number
  total: number
  onPageChange: (pageIndex: number) => void
  onPageSizeChange: (pageSize: number) => void
  /** Hide the "Showing x of y" label (e.g. query errored with no data). */
  hideRange?: boolean
}) {
  const pages = pageCount(total, pageSize)
  const sizes = pageSizeOptions(pageSize)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm text-status-neutral">
      <span className="font-mono tabular-nums" aria-live="polite">
        {hideRange ? '' : rangeLabel(pageIndex, pageSize, total)}
      </span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2">
          <span>Rows</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger size="sm" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizes.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <span className="font-mono tabular-nums">
          Page {pageIndex + 1} of {pages}
        </span>
        <Button
          variant="ghost"
          className="border border-input px-3 py-1"
          disabled={pageIndex <= 0}
          onClick={() => onPageChange(pageIndex - 1)}
        >
          Previous
        </Button>
        <Button
          variant="ghost"
          className="border border-input px-3 py-1"
          disabled={pageIndex + 1 >= pages}
          onClick={() => onPageChange(pageIndex + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
