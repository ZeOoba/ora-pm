import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useTable, type RowData, type RowSelectionState, type ColumnVisibilityState } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildCsvColumns, columnLabel, tableFeaturesConfig, type DataTableColumnDef } from './columns'
import { toCsv, downloadCsv } from './csv'
import { DataTablePager } from './DataTablePager'
import { DataTableToolbar, type FilterDef } from './DataTableToolbar'
import {
  DEFAULT_PAGE_SIZE,
  EXPORT_MAX_ROWS,
  clientFilterSort,
  clientPage,
  collectPages,
  toListParams,
  type FetchPage,
  type TableState,
} from './table-state'

export type { FilterDef } from './DataTableToolbar'

export type DataTableProps<T extends RowData> = {
  columns: DataTableColumnDef<T>[]
  /** Base TanStack Query key; the list params are appended automatically. */
  queryKey: readonly unknown[]
  /** Server mode (default). Calls the list endpoint, e.g. (p) => api.list<Tenant>('/tenants', p). */
  fetchPage?: FetchPage<T>
  /**
   * 'client' = the caller already holds the whole (unpaged) dataset in `rows`;
   * sort / search / filter / paging all happen in memory. `rows` undefined = loading.
   */
  mode?: 'server' | 'client'
  rows?: T[]
  /** Client mode: does the row match the (trimmed) search text? Search box is hidden without it. */
  clientSearchFn?: (row: T, q: string) => boolean
  /** Client mode: does the row pass the non-empty filter values (keyed by filter id)? */
  clientFilterFn?: (row: T, filters: Record<string, string>) => boolean
  /** Client mode: error to show in the banner (with `onRetry`). */
  error?: Error | null
  onRetry?: () => void
  searchable?: boolean
  searchPlaceholder?: string
  filters?: FilterDef[]
  /** Makes rows clickable (SPA navigation; needs a Router ancestor). */
  rowHref?: (row: T) => string
  /** Adds a checkbox column; rendered above the table while rows are selected. */
  bulkActions?: (selected: T[], clearSelection: () => void) => ReactNode
  /** Enables the Export CSV button (filename without extension is fine). */
  csvFilename?: string
  /**
   * Defaults to row.id when present, else the row index. The index fallback is
   * unstable across pages/sorts (selection would follow position, not the row),
   * so pass getRowId for any rows without an `id`.
   */
  getRowId?: (row: T, index: number) => string
  initialPageSize?: number
  initialSort?: { id: string; desc: boolean }
  emptyTitle?: string
  emptyMessage?: string
  emptyAction?: ReactNode
}

const EMPTY: never[] = []
const SKELETON_ROWS = 8

function defaultRowId<T>(row: T, index: number): string {
  const id = (row as { id?: unknown } | null)?.id
  return id === undefined || id === null ? String(index) : String(id)
}

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked
  }, [indeterminate, checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      role="checkbox"
      className="size-4 cursor-pointer accent-navy"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

function ClickableRow({ href, className, children, ...props }: { href: string } & React.ComponentProps<typeof TableRow>) {
  const navigate = useNavigate()
  return (
    <TableRow
      {...props}
      tabIndex={0}
      className={cn('cursor-pointer', className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,input,select,label,[role=checkbox]')) return
        void navigate(href)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) void navigate(href)
      }}
    >
      {children}
    </TableRow>
  )
}

export function DataTable<T extends RowData>({
  columns,
  queryKey,
  fetchPage,
  mode = 'server',
  rows: clientRows,
  clientSearchFn,
  clientFilterFn,
  error: clientError,
  onRetry,
  searchable: searchableProp,

  searchPlaceholder = 'Search…',
  filters = [],
  rowHref,
  bulkActions,
  csvFilename,
  getRowId = defaultRowId,
  initialPageSize = DEFAULT_PAGE_SIZE,
  initialSort,
  emptyTitle = 'No results',
  emptyMessage,
  emptyAction,
}: DataTableProps<T>) {
  const isClient = mode === 'client'
  const searchable = searchableProp ?? (isClient ? !!clientSearchFn : true)
  const [state, setState] = useState<TableState>({
    pageIndex: 0,
    pageSize: initialPageSize,
    sort: initialSort,
    q: '',
    filters: {},
  })
  const [searchText, setSearchText] = useState('')
  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibilityState>({})
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [exporting, setExporting] = useState(false)

  // Any change to what the server returns invalidates the selection.
  const update = useCallback((fn: (s: TableState) => TableState) => {
    setState(fn)
    setRowSelection({})
  }, [])

  // Debounced (300 ms) search -> state.q, resetting to the first page.
  useEffect(() => {
    const t = setTimeout(() => {
      // Compare trimmed values: whitespace-only edits must not reset paging/selection.
      if (state.q?.trim() === searchText.trim()) return
      setState((s) => ({ ...s, q: searchText, pageIndex: 0 }))
      setRowSelection({})
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm on searchText only; state.q read at fire time
  }, [searchText])

  const params = useMemo(() => toListParams(state), [state])
  const serverQuery = useQuery({
    queryKey: [...queryKey, params],
    queryFn: () => {
      if (!fetchPage) throw new Error('DataTable: fetchPage is required in server mode')
      return fetchPage(params)
    },
    placeholderData: keepPreviousData,
    enabled: !isClient,
  })

  // Client mode: sort values come straight from the column accessors.
  const clientOpts = useMemo(() => {
    const byId = new Map<string, (row: T) => unknown>()
    for (const c of columns) {
      const def = c as { id?: string; accessorKey?: string; accessorFn?: (row: T, i: number) => unknown }
      const id = def.id ?? def.accessorKey
      if (!id) continue
      if (def.accessorFn) byId.set(id, (r) => def.accessorFn!(r, 0))
      else if (def.accessorKey) {
        const path = def.accessorKey.split('.')
        byId.set(id, (r) => path.reduce<unknown>((v, k) => (v as Record<string, unknown> | null | undefined)?.[k], r))
      }
    }
    return {
      searchFn: clientSearchFn,
      filterFn: clientFilterFn,
      getSortValue: (row: T, id: string) => byId.get(id)?.(row),
    }
  }, [columns, clientSearchFn, clientFilterFn])
  const clientData = useMemo(
    () => (isClient && clientRows ? clientPage(clientRows, state, clientOpts) : undefined),
    [isClient, clientRows, state, clientOpts],
  )

  const data = isClient ? clientData : serverQuery.data
  const isPending = isClient ? clientRows === undefined && !clientError : serverQuery.isPending
  const isError = isClient ? !!clientError : serverQuery.isError
  const errorValue = isClient ? clientError : serverQuery.error
  const isPlaceholderData = !isClient && serverQuery.isPlaceholderData
  const refetch = () => (isClient ? onRetry?.() : void serverQuery.refetch())
  const rows = data?.data ?? (EMPTY as T[])
  const total = data?.total ?? 0

  // Deleted rows can leave us past the last page; fall back to the first.
  useEffect(() => {
    if (data && data.data.length === 0 && data.total > 0 && state.pageIndex > 0) {
      update((s) => ({ ...s, pageIndex: 0 }))
    }
  }, [data, state.pageIndex, update])

  // Sorting is opt-in. A table-level `enableSorting: false` would override
  // column-level `true` in v9, so normalise per column instead.
  const sortableOptIn = useMemo(
    () => columns.map((c) => ({ ...c, enableSorting: c.enableSorting === true })) as typeof columns,
    [columns],
  )

  const table = useTable<typeof tableFeaturesConfig, T>({
    features: tableFeaturesConfig,
    columns: sortableOptIn,
    data: rows,
    getRowId,
    rowCount: total,
    manualPagination: true,
    manualSorting: true,
    enableMultiSort: false,
    sortDescFirst: false,
    enableRowSelection: !!bulkActions,
    state: {
      pagination: { pageIndex: state.pageIndex, pageSize: state.pageSize },
      sorting: state.sort ? [state.sort] : [],
      columnVisibility,
      rowSelection,
    },
    onColumnVisibilityChange: setColumnVisibility,
    onRowSelectionChange: setRowSelection,
    onSortingChange: (updater) => {
      const current = state.sort ? [state.sort] : []
      const next = typeof updater === 'function' ? updater(current) : updater
      update((s) => ({ ...s, sort: next[0], pageIndex: 0 }))
    },
  })

  const visibleColumns = table.getVisibleLeafColumns()
  const colSpan = visibleColumns.length + (bulkActions ? 1 : 0)
  const selected = bulkActions ? table.getSelectedRowModel().rows.map((r) => r.original) : []
  const filtersActive = !!state.q || Object.values(state.filters).some(Boolean)

  const exportCsv = async () => {
    setExporting(true)
    try {
      if (isClient) {
        const all = clientFilterSort(clientRows ?? [], state, clientOpts)
        downloadCsv(csvFilename ?? 'export', toCsv(all, buildCsvColumns<T>(visibleColumns)))
        return
      }
      if (!fetchPage) throw new Error('DataTable: fetchPage is required in server mode')
      const { rows: all, total: grand, truncated } = await collectPages(fetchPage, state)
      const cols = buildCsvColumns<T>(visibleColumns)
      downloadCsv(csvFilename ?? 'export', toCsv(all, cols))
      if (truncated) {
        toast.warning(
          `Exported the first ${EXPORT_MAX_ROWS.toLocaleString()} of ${grand.toLocaleString()} rows. Narrow the filters to export the rest.`,
        )
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'CSV export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <DataTableToolbar
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        searchText={searchText}
        onSearchTextChange={setSearchText}
        filters={filters}
        filterValues={state.filters}
        onFilterChange={(id, value) =>
          update((s) => ({ ...s, pageIndex: 0, filters: { ...s.filters, [id]: value } }))
        }
        columnToggles={table
          .getAllLeafColumns()
          .filter((c) => c.getCanHide())
          .map((c) => ({
            id: c.id,
            label: columnLabel(c),
            visible: c.getIsVisible(),
            toggle: (v: boolean) => c.toggleVisibility(v),
          }))}
        canExport={!!csvFilename}
        exporting={exporting}
        onExport={() => void exportCsv()}
      />

      {isError && (
        <div
          role="alert"
          className="mb-3 flex items-center justify-between gap-3 rounded-md border border-status-danger/30 bg-status-danger/5 px-4 py-3 text-sm text-status-danger"
        >
          <span>{errorValue instanceof Error ? errorValue.message : 'Failed to load data.'}</span>
          <Button variant="ghost" className="border border-status-danger/40 px-3 py-1" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {bulkActions && selected.length > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md bg-parchment px-4 py-2 text-sm text-navy">
          <span className="font-medium">{selected.length} selected</span>
          {bulkActions(selected, () => setRowSelection({}))}
        </div>
      )}

      <div className="rounded-md border bg-white">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {bulkActions && (
                  <TableHead className="w-10 px-3">
                    <Checkbox
                      label="Select all rows"
                      checked={table.getIsAllRowsSelected()}
                      indeterminate={table.getIsSomeRowsSelected()}
                      onChange={(v) => table.toggleAllRowsSelected(v)}
                    />
                  </TableHead>
                )}
                {group.headers.map((header) => {
                  const column = header.column
                  const numeric = !!column.columnDef.meta?.numeric
                  const sorted = column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      className={cn('text-navy', numeric && 'text-right')}
                      aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}
                    >
                      {header.isPlaceholder ? null : column.getCanSort() ? (
                        <button
                          type="button"
                          className={cn(
                            'inline-flex items-center gap-1 rounded-sm hover:text-gold-600 focus-visible:outline-2 focus-visible:outline-gold',
                            numeric && 'flex-row-reverse',
                          )}
                          onClick={() => column.toggleSorting()}
                        >
                          <table.FlexRender header={header} />
                          {sorted === 'asc' ? (
                            <ArrowUp className="size-3.5" aria-hidden />
                          ) : sorted === 'desc' ? (
                            <ArrowDown className="size-3.5" aria-hidden />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-40" aria-hidden />
                          )}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={cn(isPlaceholderData && 'opacity-60 transition-opacity')}>
            {isPending
              ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                  <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                    {Array.from({ length: colSpan }, (_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full min-w-12" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.length === 0
                ? !isError && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={colSpan}>
                        <EmptyState
                          title={emptyTitle}
                          message={emptyMessage ?? (filtersActive ? 'No rows match the current search or filters.' : undefined)}
                          action={emptyAction}
                        />
                      </TableCell>
                    </TableRow>
                  )
                : table.getRowModel().rows.map((row) => {
                    const cells = (
                      <>
                        {bulkActions && (
                          <TableCell className="w-10 px-3">
                            <Checkbox
                              label="Select row"
                              checked={row.getIsSelected()}
                              onChange={(v) => row.toggleSelected(v)}
                            />
                          </TableCell>
                        )}
                        {row.getVisibleCells().map((cell) => (
                          <TableCell
                            key={cell.id}
                            className={cn(cell.column.columnDef.meta?.numeric && 'text-right font-mono tabular-nums')}
                          >
                            <table.FlexRender cell={cell} />
                          </TableCell>
                        ))}
                      </>
                    )
                    const selectedState = row.getIsSelected() ? 'selected' : undefined
                    return rowHref ? (
                      <ClickableRow key={row.id} href={rowHref(row.original)} data-state={selectedState}>
                        {cells}
                      </ClickableRow>
                    ) : (
                      <TableRow key={row.id} data-state={selectedState}>
                        {cells}
                      </TableRow>
                    )
                  })}
          </TableBody>
        </Table>
      </div>

      <DataTablePager
        pageIndex={state.pageIndex}
        pageSize={state.pageSize}
        total={total}
        hideRange={isError && !data}
        onPageChange={(pageIndex) => update((s) => ({ ...s, pageIndex }))}
        onPageSizeChange={(pageSize) => update((s) => ({ ...s, pageSize, pageIndex: 0 }))}
      />
    </div>
  )
}
