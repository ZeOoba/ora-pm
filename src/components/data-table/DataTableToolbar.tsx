import { Columns3, Download, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type FilterDef = {
  /** Query-param name sent to the list endpoint (e.g. 'status'). */
  id: string
  label: string
  options: { value: string; label: string }[]
}

export type ColumnToggle = { id: string; label: string; visible: boolean; toggle: (visible: boolean) => void }

const ALL = '__all__'

export function DataTableToolbar({
  searchable,
  searchPlaceholder,
  searchText,
  onSearchTextChange,
  filters,
  filterValues,
  onFilterChange,
  columnToggles,
  canExport,
  exporting,
  onExport,
}: {
  searchable: boolean
  searchPlaceholder: string
  searchText: string
  onSearchTextChange: (text: string) => void
  filters: FilterDef[]
  filterValues: Record<string, string>
  onFilterChange: (id: string, value: string) => void
  columnToggles: ColumnToggle[]
  canExport: boolean
  exporting: boolean
  onExport: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3">
      {searchable && (
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-status-neutral" />
          <Input
            type="search"
            className="pl-8"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            value={searchText}
            onChange={(e) => onSearchTextChange(e.target.value)}
          />
        </div>
      )}
      {filters.map((f) => (
        <Select
          key={f.id}
          value={filterValues[f.id] || ALL}
          onValueChange={(v) => onFilterChange(f.id, v === ALL ? '' : v)}
        >
          <SelectTrigger aria-label={f.label}>
            <SelectValue placeholder={f.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{`All ${f.label.toLowerCase()}`}</SelectItem>
            {f.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      <div className="ml-auto flex items-center gap-2">
        {columnToggles.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2 border border-input px-3 py-1.5">
                <Columns3 className="size-4" aria-hidden />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columnToggles.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.id}
                  checked={c.visible}
                  onCheckedChange={(v) => c.toggle(!!v)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {canExport && (
          <Button
            variant="ghost"
            className="gap-2 border border-input px-3 py-1.5"
            disabled={exporting}
            onClick={onExport}
          >
            <Download className="size-4" aria-hidden />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        )}
      </div>
    </div>
  )
}
