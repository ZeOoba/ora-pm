import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, FileText, Grid2x2, Users, type LucideIcon } from 'lucide-react'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { NAV_GROUPS } from './nav-config'

export type SearchResult = {
  type: 'property' | 'tenant' | 'unit' | 'lease'
  id: string
  label: string
  sublabel: string
  href: string
}

const TYPE_META: Record<SearchResult['type'], { heading: string; icon: LucideIcon }> = {
  property: { heading: 'Properties', icon: Building2 },
  tenant: { heading: 'Tenants', icon: Users },
  unit: { heading: 'Units', icon: Grid2x2 },
  lease: { heading: 'Leases', icon: FileText },
}
const TYPE_ORDER: SearchResult['type'][] = ['property', 'tenant', 'unit', 'lease']

export const SEARCH_DEBOUNCE_MS = 250
export const MIN_QUERY_LENGTH = 2

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

function groupResults(results: SearchResult[]): Array<{ type: SearchResult['type']; items: SearchResult[] }> {
  return TYPE_ORDER.map((type) => ({ type, items: results.filter((r) => r.type === type) })).filter((g) => g.items.length > 0)
}

/** Cmd+K / Ctrl+K command palette: server search (debounced) plus quick-jump nav pages. */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const trimmed = input.trim()
  const term = useDebounced(trimmed, SEARCH_DEBOUNCE_MS)
  const searchable = term.length >= MIN_QUERY_LENGTH

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpenChange(!open)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onOpenChange])

  const { data, isFetching, isError } = useQuery({
    queryKey: ['global-search', term],
    queryFn: () => api.get<{ data: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}`),
    enabled: open && searchable,
    staleTime: 30_000,
  })

  function go(href: string) {
    onOpenChange(false)
    setInput('')
    navigate(href)
  }

  const needle = trimmed.toLowerCase()
  const pages = NAV_GROUPS.flatMap((g) => g.items).filter((i) => !needle || i.label.toLowerCase().includes(needle))
  const groups = searchable ? groupResults(data?.data ?? []) : []
  const pending = searchable && (isFetching || term !== trimmed)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setInput('')
        onOpenChange(next)
      }}
    >
      <DialogContent showCloseButton={false} className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Search properties, tenants, units and leases, or jump to a page.</DialogDescription>
        {/* Server results are already filtered; cmdk's own filter would hide or reorder them. */}
        <Command shouldFilter={false}>
          <CommandInput value={input} onValueChange={setInput} placeholder="Search properties, tenants, units, leases..." />
          <CommandList>
            {!pending && groups.length === 0 && pages.length === 0 && <CommandEmpty>No results.</CommandEmpty>}
            {pending && <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>}
            {isError && <div className="px-3 py-2 text-xs text-status-danger">Search failed. Try again.</div>}
            {groups.map(({ type, items }) => {
              const { heading, icon: Icon } = TYPE_META[type]
              return (
                <CommandGroup key={type} heading={heading}>
                  {items.map((r) => (
                    <CommandItem key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}`} onSelect={() => go(r.href)}>
                      <Icon aria-hidden="true" />
                      <span className="truncate">{r.label}</span>
                      {r.sublabel && <span className="ml-auto truncate text-xs text-muted-foreground">{r.sublabel}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
            {pages.length > 0 && (
              <CommandGroup heading="Pages">
                {pages.map(({ to, label, icon: Icon }) => (
                  <CommandItem key={to} value={`page-${to}`} onSelect={() => go(to)}>
                    <Icon aria-hidden="true" />
                    {label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
