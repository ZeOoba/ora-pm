import {
  columnVisibilityFeature,
  createColumnHelper,
  metaHelper,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
  type RowData,
} from '@tanstack/react-table'

export type DataTableColumnMeta = {
  /** Right-align and render in font-mono tabular-nums. */
  numeric?: boolean
  /** Override the CSV cell value (default: the column's accessor). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- meta is per-feature-set, not per-row-type
  csv?: (row: any) => unknown
  /** Header text for CSV when the column header is not a plain string. */
  csvHeader?: string
}

export const tableFeaturesConfig = tableFeatures({
  rowPaginationFeature,
  rowSortingFeature,
  columnVisibilityFeature,
  rowSelectionFeature,
  columnMeta: metaHelper<DataTableColumnMeta>(),
})

import type { CsvColumn } from './csv'

export type DataTableFeatures = typeof tableFeaturesConfig

// TValue is `any` so accessor columns of differing value types fit in one array.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DataTableColumnDef<T extends RowData> = ColumnDef<DataTableFeatures, T, any>

/** Human label for a column: string header, else meta.csvHeader, else id. */
export function columnLabel(column: {
  id: string
  columnDef: { header?: unknown; meta?: DataTableColumnMeta }
}): string {
  const { header, meta } = column.columnDef
  return typeof header === 'string' ? header : (meta?.csvHeader ?? column.id)
}

/** Minimal column shape needed to build CSV columns (TanStack Column satisfies it). */
export type CsvSourceColumn = {
  id: string
  columnDef: { header?: unknown; meta?: DataTableColumnMeta }
  accessorFn?: ((row: any, index: number) => unknown) | undefined // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Pure: turn (visible) columns into CSV columns. Skips display columns (no
 * accessor and no meta.csv, e.g. checkbox/action columns); meta.csv wins over
 * the accessor.
 */
export function buildCsvColumns<T>(columns: CsvSourceColumn[]): CsvColumn<T>[] {
  const out: CsvColumn<T>[] = []
  for (const col of columns) {
    const csv = col.columnDef.meta?.csv
    const accessorFn = col.accessorFn
    if (!csv && !accessorFn) continue
    out.push({
      header: columnLabel(col),
      accessor: (row: T) => (csv ? csv(row) : accessorFn?.(row, 0)),
    })
  }
  return out
}

/**
 * Column helper bound to DataTable's feature set.
 * Column `id` (or accessorKey) IS the `sort` query param, so set
 * `enableSorting: true` only on columns the endpoint can sort by.
 */
export function dataTableColumnHelper<T extends RowData>() {
  return createColumnHelper<DataTableFeatures, T>()
}
