import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { StatusBadge } from '../../components/StatusBadge'
import { QueryState } from '../../components/QueryState'
import { EmptyState } from '../../components/ui/EmptyState'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table'
import { formatSF } from '../../lib/format'
import type { Unit } from '../../types'

export function UnitMatrix({ propertyId }: { propertyId: string }) {
  const query = useQuery({
    queryKey: ['units', propertyId],
    queryFn: () =>
      api.get<{ data: Unit[] }>(`/units?property_id=${propertyId}`).then(r => r.data),
  })
  const data = query.data

  return (
    <QueryState
      query={query}
      isEmpty={(d) => (d as Unit[] | undefined)?.length === 0}
      empty={<EmptyState title="No units" message="Add the first unit to this property." />}
    >
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              {['Suite', 'Floor', 'SF', 'Status'].map(h => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.map(u => (
              <TableRow key={u.id}>
                <TableCell className="font-medium text-navy">{u.suite}</TableCell>
                <TableCell className="text-status-neutral">{u.floor ?? '—'}</TableCell>
                <TableCell className="font-mono">{formatSF(u.sf)}</TableCell>
                <TableCell><StatusBadge status={u.status} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </QueryState>
  )
}
